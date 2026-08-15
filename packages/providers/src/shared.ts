import {
  ProviderCompileError,
  type CanonicalContent,
  type CanonicalGenerationRequest,
  type CompiledProviderRequest,
  type JsonObject,
  type JsonValue,
  type ModelDescriptor,
  type NormalizedProviderEvent,
  type ProviderErrorClassification,
  type ProviderFailure,
  type ProviderProfile,
  type ProviderProtocol,
  type ProviderStopDetails,
  type ProviderUsage,
} from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return value as JsonValue;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableStringValue(value: unknown): string | null | undefined {
  return value === null ? null : stringValue(value);
}

export function stopDetailsFrom(input: unknown): ProviderStopDetails | undefined {
  if (!isRecord(input)) return undefined;
  const type = stringValue(input.type);
  const category = nullableStringValue(input.category);
  const explanation = nullableStringValue(input.explanation);
  const code = nullableStringValue(input.code);
  return {
    ...(type === undefined ? {} : { type }),
    ...(category === undefined ? {} : { category }),
    ...(explanation === undefined ? {} : { explanation }),
    ...(code === undefined ? {} : { code }),
    providerData: asJsonValue(input) as JsonObject,
  };
}

const POLICY_STOP_REASONS = new Set([
  "blocklist",
  "blocked",
  "content_filter",
  "content_filtered",
  "content_policy",
  "content_policy_violation",
  "copyright",
  "guardrail",
  "guardrail_intervened",
  "image_safety",
  "moderation",
  "prohibited_content",
  "recitation",
  "refusal",
  "refused",
  "safety",
  "spii",
]);

export function isPolicyStopReason(...values: readonly (string | null | undefined)[]): boolean {
  return values.some((value) => {
    if (!value) return false;
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
    return POLICY_STOP_REASONS.has(normalized) ||
      /(?:^|_)(?:content_filter|content_policy|guardrail|moderation|prohibited_content|refusal|safety)(?:_|$)/.test(normalized);
  });
}

export function serializeArguments(value: JsonValue | string): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function textFromContent(content: CanonicalContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function assertExclusiveLocation(part: {
  readonly url?: string;
  readonly data?: string;
}): "url" | "data" {
  if ((part.url === undefined) === (part.data === undefined)) {
    throw new ProviderCompileError(
      "unsupported-content",
      "Image and file content must specify exactly one of url or data.",
    );
  }
  return part.url === undefined ? "data" : "url";
}

export function mergeExtraBody(
  protectedFields: ReadonlySet<string>,
  ...sources: readonly (JsonObject | undefined)[]
): JsonObject {
  const result: JsonObject = {};
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [key, value] of Object.entries(source)) {
      if (protectedFields.has(key.toLowerCase())) {
        throw new ProviderCompileError(
          "protected-field",
          `The provider option ${JSON.stringify(key)} is owned by Lathe and cannot be overridden.`,
          { field: key },
        );
      }
      result[key] = value;
    }
  }
  return result;
}

export function endpointUrl(baseUrl: string, override: string | undefined, path: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new ProviderCompileError("invalid-profile", `Invalid provider base URL: ${baseUrl}`);
  }

  if (override !== undefined) return new URL(override, `${base.toString().replace(/\/$/, "")}/`).toString();

  const basePath = base.pathname.replace(/\/$/, "");
  let suffix = path.startsWith("/") ? path : `/${path}`;
  if (basePath.endsWith("/v1") && suffix.startsWith("/v1/")) suffix = suffix.slice(3);
  base.pathname = `${basePath}${suffix}`.replace(/\/+/g, "/");
  return base.toString();
}

export function providerHeaders(
  profile: ProviderProfile,
  request: CanonicalGenerationRequest | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(profile.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  for (const [name, value] of Object.entries(request?.extraHeaders ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  headers["content-type"] = "application/json";

  if (profile.protocol === "anthropic-messages") {
    if (profile.credential !== undefined && profile.credential !== "") {
      headers["x-api-key"] = profile.credential;
    }
    headers["anthropic-version"] = profile.anthropicVersion ?? "2023-06-01";
  } else if (profile.credential !== undefined && profile.credential !== "") {
    headers.authorization = `Bearer ${profile.credential}`;
  }
  return headers;
}

export function makeCompiledRequest(
  profile: ProviderProfile,
  protocol: ProviderProtocol,
  defaultGeneratePath: string,
  request: CanonicalGenerationRequest,
  body: JsonObject,
  warnings: CompiledProviderRequest["warnings"] = [],
): CompiledProviderRequest {
  return {
    protocol,
    url: endpointUrl(
      profile.baseUrl,
      profile.endpointOverrides?.generate ?? profile.endpointOverride ?? undefined,
      defaultGeneratePath,
    ),
    method: "POST",
    headers: providerHeaders(profile, request),
    body,
    warnings,
  };
}

export function errorShape(payload: unknown): { message?: string; code?: string; type?: string } {
  if (!isRecord(payload)) return {};
  const response = isRecord(payload.response) ? payload.response : undefined;
  const nested = isRecord(payload.error)
    ? payload.error
    : response !== undefined && isRecord(response.error)
      ? response.error
      : response ?? payload;
  const metadata = isRecord(nested.metadata) ? nested.metadata : undefined;
  const message = stringValue(nested.message) ?? stringValue(nested.detail);
  const code = stringValue(nested.code) ??
    (typeof nested.code === "number" && Number.isFinite(nested.code) ? String(nested.code) : undefined);
  const type = stringValue(nested.error_type) ??
    (metadata === undefined ? undefined : stringValue(metadata.error_type)) ??
    stringValue(nested.type) ??
    (response === undefined ? undefined : stringValue(response.error_type)) ??
    stringValue(payload.error_type);
  return {
    ...(message === undefined ? {} : { message }),
    ...(code === undefined ? {} : { code }),
    ...(type === undefined ? {} : { type }),
  };
}

const TYPED_ERROR_CLASSIFICATIONS: Readonly<Record<string, ProviderErrorClassification>> = {
  // OpenRouter's stable cross-protocol error_type vocabulary.
  authentication: "authentication",
  permission_denied: "authentication",
  payment_required: "authentication",
  rate_limit_exceeded: "rate-limit",
  provider_overloaded: "unavailable",
  provider_unavailable: "unavailable",
  timeout: "timeout",
  context_length_exceeded: "invalid-request",
  max_tokens_exceeded: "invalid-request",
  token_limit_exceeded: "invalid-request",
  string_too_long: "invalid-request",
  invalid_request: "invalid-request",
  invalid_prompt: "invalid-request",
  not_found: "invalid-request",
  precondition_failed: "invalid-request",
  payload_too_large: "invalid-request",
  unprocessable: "invalid-request",
  invalid_image: "invalid-request",
  image_too_large: "invalid-request",
  image_too_small: "invalid-request",
  unsupported_image_format: "invalid-request",
  image_not_found: "invalid-request",
  image_download_failed: "invalid-request",
  content_policy_violation: "content-policy",
  refusal: "content-policy",
  server: "unavailable",
  unmapped: "unavailable",

  // Common native spellings used when no stable gateway type is present.
  authentication_error: "authentication",
  permission_error: "authentication",
  billing_error: "authentication",
  rate_limit_error: "rate-limit",
  overloaded_error: "unavailable",
  timeout_error: "timeout",
  invalid_request_error: "invalid-request",
  not_found_error: "invalid-request",
  api_error: "unavailable",
  server_error: "unavailable",
};

function typedErrorClassification(value: string | undefined): ProviderErrorClassification | undefined {
  if (!value) return undefined;
  return TYPED_ERROR_CLASSIFICATIONS[value.trim().toLowerCase().replace(/[\s-]+/g, "_")];
}

export function classifyProviderError(input: {
  readonly status?: number;
  readonly payload?: unknown;
  readonly cause?: unknown;
  readonly timedOut?: boolean;
  readonly aborted?: boolean;
  readonly fallback?: ProviderErrorClassification;
}): ProviderFailure {
  const shape = errorShape(input.payload);
  const fingerprint = `${shape.code ?? ""} ${shape.type ?? ""} ${shape.message ?? ""}`.toLowerCase();
  const typedClassification = typedErrorClassification(shape.type);
  let classification: ProviderErrorClassification = input.fallback ?? "unknown";

  if (input.timedOut === true) classification = "timeout";
  else if (input.aborted === true) classification = "cancelled";
  else if (isPolicyStopReason(shape.code, shape.type) || /content[_ -]?(?:filter|policy)|copyright|safety|moderation|guardrail|prompt[_ -]?injection|request[_ -]?blocked|blocked[_ -]?pii|\brefus(?:al|ed)\b/.test(fingerprint)) classification = "content-policy";
  else if (typedClassification !== undefined) classification = typedClassification;
  else if (input.status === 401 || input.status === 403 || /auth(?:entication|orization)?|invalid[_ -]?api[_ -]?key|permission[_ -]?denied|forbidden/.test(fingerprint)) classification = "authentication";
  else if (input.status === 429 || /rate[_ -]?limit|\b429\b/.test(fingerprint)) classification = "rate-limit";
  else if (input.status === 408 || input.status === 504 || /timeout|timed[_ -]?out/.test(fingerprint)) classification = "timeout";
  else if (input.status !== undefined && input.status >= 500 || /(?:^|\s)(?:server|unmapped)(?:\s|$)|overload|unavailable|server[_ -]?error|upstream[_ -]?error/.test(fingerprint)) classification = "unavailable";
  else if (
    input.status !== undefined &&
    [400, 404, 405, 409, 413, 415, 422].includes(input.status)
  ) {
    classification = "invalid-request";
  } else if (/context[_ -]?length|invalid[_ -]?(?:image|prompt|request)|not[_ -]?found|payload[_ -]?too[_ -]?large|precondition[_ -]?failed|string[_ -]?too[_ -]?long|token[_ -]?limit|unprocessable|validation[_ -]?error|bad[_ -]?request/.test(fingerprint)) classification = "invalid-request";
  else if (input.cause instanceof SyntaxError) classification = "parse-failure";
  else if (input.cause instanceof TypeError) classification = "transport";

  const causeMessage = input.cause instanceof Error ? input.cause.message : undefined;
  return {
    classification,
    message: shape.message ?? causeMessage ?? `Provider request failed${input.status ? ` (${input.status})` : ""}.`,
    retryable: ["transport", "rate-limit", "unavailable", "timeout"].includes(classification),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(shape.code === undefined ? {} : { code: shape.code }),
    ...(input.payload === undefined ? {} : { details: asJsonValue(input.payload) }),
  };
}

export function errorEvent(error: ProviderFailure): NormalizedProviderEvent {
  return { type: "provider.error", error };
}

export function usageFrom(input: unknown): ProviderUsage | undefined {
  if (!isRecord(input)) return undefined;
  const inputTokens =
    numberValue(input.input_tokens) ?? numberValue(input.prompt_tokens) ?? numberValue(input.inputTokens);
  const outputTokens =
    numberValue(input.output_tokens) ??
    numberValue(input.completion_tokens) ??
    numberValue(input.outputTokens);
  const totalTokens = numberValue(input.total_tokens) ??
    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  const details = isRecord(input.input_tokens_details)
    ? input.input_tokens_details
    : isRecord(input.prompt_tokens_details)
      ? input.prompt_tokens_details
      : undefined;
  const cachedInputTokens = details === undefined ? undefined : numberValue(details.cached_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cachedInputTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

export function manualModels(profile: ProviderProfile): ModelDescriptor[] {
  return (profile.models ?? []).map((model) => ({
    id: model.id,
    label: model.label,
    capabilities: profile.capabilityOverrides?.[model.id] ?? model.capabilities,
    source: model.discovered ? ("discovered" as const) : ("manual" as const),
  }));
}
