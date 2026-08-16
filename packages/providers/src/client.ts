import { anthropicMessagesAdapter } from "./adapters/anthropic.js";
import { openAiChatAdapter } from "./adapters/openai-chat.js";
import { openAiResponsesAdapter } from "./adapters/openai-responses.js";
import { providerSecretValues, redactHeaders, redactJson, redactText, redactUrl } from "./redaction.js";
import {
  asJsonValue,
  classifyProviderError,
  endpointUrl,
  errorEvent,
  isRecord,
  manualModels,
  providerHeaders,
  stringValue,
} from "./shared.js";
import { parseSseStream } from "./sse.js";
import type {
  CanonicalGenerationRequest,
  CompiledProviderRequest,
  ExecuteOptions,
  JsonObject,
  JsonValue,
  ModelDescriptor,
  ModelDiscoveryOptions,
  ModelDiscoveryResult,
  NormalizedProviderEvent,
  ProtocolAdapter,
  ProviderFailure,
  ProviderProfile,
  ProviderProtocol,
  ProviderStreamItem,
  RawTraceEvent,
  RawTraceKind,
} from "./types.js";

const ADAPTERS: Readonly<Record<ProviderProtocol, ProtocolAdapter>> = {
  "openai-responses": openAiResponsesAdapter,
  "openai-chat": openAiChatAdapter,
  "anthropic-messages": anthropicMessagesAdapter,
};

export function getProtocolAdapter(protocol: ProviderProtocol): ProtocolAdapter {
  return ADAPTERS[protocol];
}

export function compileProviderRequest(
  profile: ProviderProfile,
  request: CanonicalGenerationRequest,
): CompiledProviderRequest {
  return getProtocolAdapter(profile.protocol).compile(profile, request);
}

function sanitizeFailure(
  error: ProviderFailure,
  secrets: readonly string[],
  redactionEnabled: boolean,
): ProviderFailure {
  return {
    ...error,
    message: redactText(error.message, secrets, redactionEnabled),
    ...(error.details === undefined ? {} : { details: redactJson(error.details, secrets, redactionEnabled) }),
  };
}

function sanitizeEvents(
  events: readonly NormalizedProviderEvent[],
  secrets: readonly string[],
  redactionEnabled: boolean,
): NormalizedProviderEvent[] {
  return events.map((event) =>
    redactJson(event as unknown as JsonValue, secrets, redactionEnabled) as unknown as NormalizedProviderEvent
  );
}

function traceFactory(now: () => Date, secrets: readonly string[], redactionEnabled: boolean) {
  let sequence = 0;
  return (kind: RawTraceKind, data: JsonValue): RawTraceEvent => ({
    sequence: sequence++,
    occurredAt: now().toISOString(),
    kind,
    data: redactJson(data, secrets, redactionEnabled),
  });
}

function item(trace: RawTraceEvent, events: readonly NormalizedProviderEvent[] = []): ProviderStreamItem {
  return { trace, events };
}

function failureData(error: ProviderFailure): JsonObject {
  return {
    classification: error.classification,
    message: error.message,
    retryable: error.retryable,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

function terminal(events: readonly NormalizedProviderEvent[]): boolean {
  return events.some((event) => event.type === "response.completed" || event.type === "provider.error");
}

async function responsePayload(response: Response): Promise<{ raw: string; value: JsonValue }> {
  const raw = await response.text();
  if (raw === "") return { raw, value: null };
  try {
    return { raw, value: JSON.parse(raw) as JsonValue };
  } catch {
    return { raw, value: raw };
  }
}

function linkedAbortSignal(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeOut = false;
  const onAbort = () => controller.abort(external?.reason);
  if (external?.aborted === true) onAbort();
  else external?.addEventListener("abort", onAbort, { once: true });
  const timer =
    timeoutMs === undefined
      ? undefined
      : globalThis.setTimeout(() => {
          didTimeOut = true;
          controller.abort(new DOMException("Provider request timed out.", "TimeoutError"));
        }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer !== undefined) globalThis.clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
    timedOut: () => didTimeOut,
  };
}

/**
 * Execute exactly one provider request. Failures are emitted as evidence-bearing events rather
 * than thrown after the request has begun, so callers can persist every trace item in order.
 */
export async function* executeProviderRequest(
  profile: ProviderProfile,
  request: CanonicalGenerationRequest,
  options: ExecuteOptions = {},
): AsyncGenerator<ProviderStreamItem> {
  const adapter = getProtocolAdapter(profile.protocol);
  const compiled = adapter.compile(profile, request);
  const secrets = providerSecretValues(profile);
  const redactionEnabled = options.redactionEnabled !== false;
  const makeTrace = traceFactory(options.now ?? (() => new Date()), secrets, redactionEnabled);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const abort = linkedAbortSignal(options.signal, options.timeoutMs);

  yield item(makeTrace("request", {
    method: compiled.method,
    url: redactUrl(compiled.url, secrets, redactionEnabled),
    headers: redactHeaders(compiled.headers, secrets, redactionEnabled),
    body: redactJson(compiled.body, secrets, redactionEnabled),
    warnings: compiled.warnings.map((warning) => ({ code: warning.code, message: warning.message })),
  }));

  try {
    const response = await fetchImpl(compiled.url, {
      method: compiled.method,
      headers: compiled.headers,
      body: JSON.stringify(compiled.body),
      signal: abort.signal,
    });
    yield item(makeTrace("response", {
      status: response.status,
      statusText: response.statusText,
      headers: redactHeaders(response.headers, secrets, redactionEnabled),
    }));

    if (!response.ok) {
      const payload = await responsePayload(response);
      const failure = sanitizeFailure(
        classifyProviderError({ status: response.status, payload: payload.value }),
        secrets,
        redactionEnabled,
      );
      yield item(
        makeTrace("error", { raw: redactText(payload.raw, secrets, redactionEnabled), error: failureData(failure) }),
        [errorEvent(failure)],
      );
      return;
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const expectsStream = compiled.body.stream === true;
    const isSse = contentType.includes("text/event-stream") || (expectsStream && !contentType.includes("json"));
    if (isSse) {
      if (response.body === null) {
        const failure = classifyProviderError({ fallback: "interrupted-stream" });
        yield item(makeTrace("error", failureData(failure)), [errorEvent(failure)]);
        return;
      }
      let sawTerminal = false;
      for await (const frame of parseSseStream(response.body)) {
        // Do not collapse completion-looking frames. Some gateways expose an
        // attempted model's policy stop and then continue on a fallback model
        // in the same HTTP 200 stream. Downstream code needs the full sequence.
        const events = sanitizeEvents(adapter.normalizeSse(frame), secrets, redactionEnabled);
        if (terminal(events)) sawTerminal = true;
        yield item(makeTrace("sse", {
          raw: redactText(frame.raw, secrets, redactionEnabled),
          data: redactText(frame.data, secrets, redactionEnabled),
          ...(frame.event === undefined ? {} : { event: frame.event }),
          ...(frame.id === undefined ? {} : { id: frame.id }),
          ...(frame.retry === undefined ? {} : { retry: frame.retry }),
        }), events);
      }
      if (!sawTerminal) {
        const failure = classifyProviderError({
          fallback: "interrupted-stream",
          payload: { message: "Provider stream ended without a terminal event." },
        });
        yield item(makeTrace("error", failureData(failure)), [errorEvent(failure)]);
      }
      return;
    }

    const payload = await responsePayload(response);
    if (typeof payload.value === "string") {
      const failure = sanitizeFailure(
        classifyProviderError({
          cause: new SyntaxError("Provider returned a non-JSON response."),
          payload: payload.value,
          fallback: "parse-failure",
        }),
        secrets,
        redactionEnabled,
      );
      yield item(makeTrace("error", { raw: redactText(payload.raw, secrets, redactionEnabled), error: failureData(failure) }), [
        errorEvent(failure),
      ]);
      return;
    }
    const events = sanitizeEvents(adapter.normalizeJson(payload.value), secrets, redactionEnabled);
    yield item(makeTrace("json", payload.value), events);
  } catch (cause) {
    const failure = sanitizeFailure(
      classifyProviderError({
        cause,
        timedOut: abort.timedOut(),
        aborted: !abort.timedOut() && (options.signal?.aborted === true || abort.signal.aborted),
        fallback: "transport",
      }),
      secrets,
      redactionEnabled,
    );
    yield item(makeTrace("error", failureData(failure)), [errorEvent(failure)]);
  } finally {
    abort.dispose();
  }
}

function discoveredModels(payload: unknown, profile: ProviderProfile): ModelDescriptor[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  const models: ModelDescriptor[] = [];
  for (const entry of payload.data) {
    if (!isRecord(entry)) continue;
    const id = stringValue(entry.id);
    if (id === undefined || id === "") continue;
    const created = typeof entry.created === "number" ? entry.created : undefined;
    const createdAt = stringValue(entry.created_at) ??
      (created === undefined ? undefined : new Date(created * 1_000).toISOString());
    const ownedBy = stringValue(entry.owned_by) ?? stringValue(entry.display_name);
    models.push({
      id,
      label: stringValue(entry.display_name) ?? id,
      source: "discovered",
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(ownedBy === undefined ? {} : { ownedBy }),
      ...(profile.capabilityOverrides?.[id] === undefined
        ? {}
        : { capabilities: profile.capabilityOverrides[id] }),
    });
  }
  return models;
}

/** Query a provider's model endpoint and merge it with operator-maintained model entries. */
export async function discoverProviderModels(
  profile: ProviderProfile,
  options: ModelDiscoveryOptions = {},
): Promise<ModelDiscoveryResult> {
  const manual = manualModels(profile);
  if (options.remote === false) return { models: manual, warnings: [] };
  const adapter = getProtocolAdapter(profile.protocol);
  const url = endpointUrl(profile.baseUrl, profile.endpointOverrides?.models, adapter.defaultModelsPath);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const warnings: string[] = [];
  let remote: ModelDescriptor[] = [];
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: providerHeaders(profile, undefined),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const payload = await responsePayload(response);
    if (!response.ok) {
      const failure = classifyProviderError({ status: response.status, payload: payload.value });
      warnings.push(`Model discovery failed: ${failure.message}`);
    } else {
      remote = discoveredModels(payload.value, profile);
      if (remote.length === 0) warnings.push("Model discovery returned no recognized model records.");
    }
  } catch (cause) {
    const failure = classifyProviderError({
      cause,
      aborted: options.signal?.aborted === true,
      fallback: "transport",
    });
    warnings.push(`Model discovery failed: ${failure.message}`);
  }

  const merged = new Map(remote.map((model) => [model.id, model]));
  for (const model of manual) merged.set(model.id, { ...merged.get(model.id), ...model });
  return { models: [...merged.values()].toSorted((left, right) => left.id.localeCompare(right.id)), warnings };
}
