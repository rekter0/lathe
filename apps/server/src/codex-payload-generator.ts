import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CodexAppServerAdapter,
  CodexRuntimeError,
  type CodexAppServerProfile,
  type CodexFailureClassification,
  type CodexProbeResult,
  type CodexTraceEvent
} from "@lathe/agent-runtimes";
import type { JsonObject, JsonValue, RunClassification } from "@lathe/domain";
import type { ContentStore } from "@lathe/db";
import type {
  CodexGenerationResult,
  CodexPayloadGenerator
} from "./payload-generation-coordinator.js";
import type { PayloadGeneratorProfileValue } from "./payload-schemas.js";

type CodexBackend = Extract<PayloadGeneratorProfileValue["backend"], { kind: "codex-app-server" }>;

function adapterProfile(backend: CodexBackend): CodexAppServerProfile {
  return {
    executablePath: backend.executablePath,
    authPolicy: "chatgpt-subscription",
    startupTimeoutMs: Math.min(backend.timeoutMs, 60_000),
    requestTimeoutMs: Math.min(backend.timeoutMs, 120_000)
  };
}

function assertExpectedVersion(backend: CodexBackend, probe: CodexProbeResult): void {
  if (backend.expectedVersion === null) return;
  if (probe.runtime.cliVersion !== backend.expectedVersion) {
    throw new CodexRuntimeError(
      "invalid-profile",
      `Codex version mismatch: expected ${backend.expectedVersion}, observed ${probe.runtime.cliVersion ?? "unknown"}`
    );
  }
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function publicProbe(probe: CodexProbeResult): JsonObject {
  return {
    backend: "codex-app-server",
    ready: true,
    runtime: asJson(probe.runtime),
    auth: asJson(probe.auth),
    models: asJson(probe.models),
    warnings: asJson(probe.warnings),
    trace: asJson(probe.trace)
  };
}

function classifyFailure(classification: CodexFailureClassification): RunClassification {
  switch (classification) {
    case "authentication": return "authentication";
    case "invalid-profile": return "invalid-request";
    case "protocol": return "parse-failure";
    case "transport":
    case "crash": return "transport";
    case "timeout": return "timeout";
    case "cancelled": return "cancelled";
    case "runtime-error": return "unknown";
  }
}

function traceDirection(event: CodexTraceEvent): "request" | "response" | "internal" {
  if (event.direction === "request" || event.direction === "server-response") return "request";
  if (event.direction === "response" || event.direction === "notification" || event.direction === "server-request") return "response";
  return "internal";
}

/**
 * Adapts the vendor-owned App Server lifecycle to Lathe's detached payload
 * generation contract. The vendor owns login state; only already-redacted
 * JSON-RPC evidence crosses this boundary.
 */
export class CodexAppServerPayloadGenerator implements CodexPayloadGenerator {
  constructor(
    private readonly contentStore: ContentStore,
    private readonly adapter = new CodexAppServerAdapter()
  ) {}

  async probe(backend: CodexBackend): Promise<JsonObject> {
    const probe = await this.adapter.probe(adapterProfile(backend));
    assertExpectedVersion(backend, probe);
    return publicProbe(probe);
  }

  async generate(input: {
    backend: CodexBackend;
    systemPrompt: string;
    operatorPrompt: string;
    workspaceRoot: string | null;
    stagingDirectory: string;
    parentNativeThreadId: string | null;
    parentNativeTurnId: string | null;
    isRefinement: boolean;
    signal: AbortSignal;
    onText(delta: string): void;
    onReasoning(delta: string): void;
  }): Promise<CodexGenerationResult> {
    // Probe immediately before every generation so a subscription profile can
    // never silently fall back to API-key billing after its auth state changes.
    const profile = adapterProfile(input.backend);
    const probe = await this.adapter.probe(profile);
    assertExpectedVersion(input.backend, probe);
    if (!probe.models.some((model) => model.id === input.backend.modelId || model.model === input.backend.modelId)) {
      throw new CodexRuntimeError("invalid-profile", `Codex model ${input.backend.modelId} is not available`);
    }

    let isolatedDirectory: string | null = null;
    const workspace = input.backend.workspaceAccess === "project-read-only"
      ? (() => {
          if (!input.workspaceRoot) throw new CodexRuntimeError("invalid-profile", "Project-read-only generation requires a configured project workspace root");
          return { mode: "project-read-only" as const, directory: input.workspaceRoot };
        })()
      : await (async () => {
          isolatedDirectory = await mkdtemp(join(input.stagingDirectory, "codex-payload-"));
          await chmod(isolatedDirectory, 0o700);
          return { mode: "isolated" as const, directory: isolatedDirectory };
        })();

    const timeout = AbortSignal.timeout(input.backend.timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout]);
    const trace = await this.contentStore.createTraceWriter();
    let finalized = false;
    const missingNativeRefinement = input.isRefinement && input.parentNativeThreadId === null;
    const missingNativeWarning = "Native refinement state was unavailable; the exact stored candidate and feedback were replayed in a fresh thread.";
    try {
      for (const event of probe.trace) {
        await trace.append({
          direction: traceDirection(event),
          kind: event.direction === "stderr" ? "log" : "body",
          timestamp: event.occurredAt,
          data: asJson({ phase: "auth-probe", ...event })
        });
      }
      if (missingNativeRefinement) {
        await trace.append({
          direction: "internal",
          kind: "log",
          data: { code: "lossy-refinement-replay", message: missingNativeWarning }
        });
      }
      const run = await this.adapter.start(profile, {
        model: input.backend.modelId,
        input: input.operatorPrompt,
        workspace,
        baseInstructions: input.systemPrompt,
        reasoningEffort: input.backend.effort,
        reasoningSummary: "detailed",
        ...(input.parentNativeThreadId === null ? {} : {
          continuity: {
            mode: "fork" as const,
            sourceThreadId: input.parentNativeThreadId,
            ...(input.parentNativeTurnId === null ? {} : { sourceTurnId: input.parentNativeTurnId }),
            onUnavailable: "fresh-with-warning" as const
          }
        })
      }, { signal });

      for await (const item of run.events) {
        if (item.trace) {
          await trace.append({
            direction: traceDirection(item.trace),
            kind: item.trace.direction === "stderr" ? "log" : "body",
            timestamp: item.trace.occurredAt,
            data: asJson(item.trace)
          });
        }
        for (const event of item.events) {
          if (event.type === "text.delta") input.onText(event.text);
          if (event.type === "reasoning.delta") input.onReasoning(event.text);
        }
      }
      const result = await run.completed;
      const stored = await trace.finalize();
      finalized = true;
      const classification: RunClassification | null = result.status === "completed"
        ? null
        : result.status === "cancelled"
          ? (input.signal.aborted ? "cancelled" : timeout.aborted ? "timeout" : "cancelled")
          : result.failure
            ? classifyFailure(result.failure.classification)
            : "unknown";
      const adapterLossyReplay = result.continuity.mode === "lossy-fresh";
      const lossyReplay = missingNativeRefinement || adapterLossyReplay;
      const continuity: JsonObject = missingNativeRefinement
        ? { mode: "lossy-fresh", reason: "missing-native-cursor" }
        : asJson(result.continuity) as JsonObject;
      return {
        text: result.text,
        reasoning: [result.reasoning, result.reasoningSummary].filter(Boolean).join("\n\n"),
        classification,
        usage: null,
        traceHash: stored.sha256,
        nativeThreadId: result.threadId || null,
        nativeTurnId: result.turnId || null,
        metadata: {
          runtime: asJson(run.runtime),
          auth: asJson(run.auth),
          nativeStatus: result.nativeStatus,
          workspaceAccess: input.backend.workspaceAccess,
          continuity,
          lossyReplay,
          warnings: asJson([
            ...probe.warnings,
            ...(missingNativeRefinement
              ? [missingNativeWarning]
              : adapterLossyReplay
              ? ["Native thread continuity was unavailable; refinement replayed the exact stored candidate and feedback in a fresh thread."]
              : [])
          ]),
          ...(result.failure ? { failure: asJson(result.failure) } : {})
        }
      };
    } catch (error) {
      await trace.append({
        direction: "internal",
        kind: "error",
        data: {
          message: error instanceof Error ? error.message : String(error),
          classification: error instanceof CodexRuntimeError ? error.classification : "unknown"
        }
      });
      const stored = await trace.finalize();
      finalized = true;
      if (error instanceof CodexRuntimeError) {
        Object.defineProperty(error, "traceHash", { value: stored.sha256, enumerable: false });
      }
      throw error;
    } finally {
      if (!finalized) await trace.abort();
      if (isolatedDirectory !== null) await rm(isolatedDirectory, { recursive: true, force: true });
    }
  }
}
