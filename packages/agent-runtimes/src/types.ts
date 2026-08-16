export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface RuntimeClientInfo {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
}

/**
 * A Codex App Server profile deliberately contains no credential material.
 * Authentication remains owned by the locally installed Codex client.
 */
export interface CodexAppServerProfile {
  readonly executablePath: string;
  /** Optional pre-authenticated Codex home; Lathe never reads or copies its auth files. */
  readonly codexHome?: string;
  readonly authPolicy: "chatgpt-subscription";
  readonly clientInfo?: RuntimeClientInfo;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxJsonLineBytes?: number;
  readonly terminationGraceMs?: number;
}

export type CodexWorkspace =
  | {
      readonly mode: "isolated";
      /** A caller-owned empty directory. Omit to use a disposable 0700 directory. */
      readonly directory?: string;
    }
  | {
      readonly mode: "project-read-only";
      readonly directory: string;
    };

export interface CodexNativeContinuity {
  /** Fork preserves the source thread; resume appends to the native source. */
  readonly mode: "fork" | "resume";
  readonly sourceThreadId: string;
  /** Fork through this completed native turn, inclusive. Fork mode only. */
  readonly sourceTurnId?: string;
  /**
   * Fresh fallback is always visible as a warning. Use error for evidence flows
   * where losing native state would invalidate the run.
   */
  readonly onUnavailable?: "error" | "fresh-with-warning";
}

export interface CodexContinuityOutcome {
  readonly mode: "fresh" | "fork" | "resume" | "lossy-fresh";
  readonly sourceThreadId?: string;
  readonly sourceTurnId?: string;
}

export interface CodexGenerationRequest {
  readonly model: string;
  readonly input: string;
  readonly workspace: CodexWorkspace;
  /** Replaces Codex's base instructions when supported by the installed runtime. */
  readonly baseInstructions?: string;
  /** Adds application-specific developer instructions when supported. */
  readonly developerInstructions?: string;
  readonly reasoningEffort?: string;
  readonly reasoningSummary?: string;
  readonly serviceTier?: string;
  readonly continuity?: CodexNativeContinuity;
}

export interface CodexRunOptions {
  readonly signal?: AbortSignal;
  /**
   * Applies heuristic redaction to generation evidence. Defaults to true.
   * Codex authentication, account identity, stderr, and runtime environment
   * evidence remain protected even when disabled.
   */
  readonly redactionEnabled?: boolean;
}

export interface CodexRuntimeIdentity {
  readonly executablePath: string;
  readonly executableSha256: string | null;
  /** Hash covers the resolved executable entry file, not an entire installation. */
  readonly executableHashScope: "entry-file";
  readonly cliVersion: string | null;
  readonly appServerUserAgent: string | null;
}

export interface CodexSubscriptionAuth {
  readonly type: "chatgpt";
  readonly planType: string | null;
}

export interface CodexModelDescriptor {
  readonly id: string;
  readonly model: string;
  readonly label: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly isDefault: boolean;
  readonly inputModalities: readonly string[];
  readonly supportedReasoningEfforts: readonly string[];
}

export type CodexTraceDirection =
  | "request"
  | "response"
  | "notification"
  | "server-request"
  | "server-response"
  | "stderr"
  | "internal";

export interface CodexTraceEvent {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly direction: CodexTraceDirection;
  readonly method?: string;
  /** Authentication/account material is always redacted before leaving the package. */
  readonly data: JsonValue;
}

export interface CodexProbeResult {
  readonly runtime: CodexRuntimeIdentity;
  readonly auth: CodexSubscriptionAuth;
  readonly models: readonly CodexModelDescriptor[];
  readonly warnings: readonly string[];
  readonly trace: readonly CodexTraceEvent[];
}

export type RejectedRuntimeRequestKind = "approval" | "tool" | "mcp" | "app" | "other";

export type CodexNormalizedEvent =
  | {
      readonly type: "runtime.ready";
      readonly runtime: CodexRuntimeIdentity;
      readonly auth: CodexSubscriptionAuth;
      readonly model: string;
      readonly continuity: CodexContinuityOutcome;
    }
  | {
      readonly type: "run.started";
      readonly threadId: string;
      readonly turnId: string;
    }
  | {
      readonly type: "text.delta";
      readonly text: string;
      readonly itemId?: string;
    }
  | {
      readonly type: "reasoning.delta";
      readonly text: string;
      readonly kind: "raw" | "summary";
      readonly itemId?: string;
    }
  | {
      readonly type: "runtime.request.rejected";
      readonly method: string;
      readonly kind: RejectedRuntimeRequestKind;
    }
  | {
      readonly type: "runtime.warning";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly type: "run.completed";
      readonly threadId: string;
      readonly turnId: string;
      readonly nativeStatus: string;
    }
  | {
      readonly type: "run.failed";
      readonly classification: CodexFailureClassification;
      readonly message: string;
    }
  | {
      readonly type: "run.cancelled";
      readonly threadId: string;
      readonly turnId: string;
    };

export interface CodexStreamItem {
  readonly trace?: CodexTraceEvent;
  readonly events: readonly CodexNormalizedEvent[];
}

export type CodexFailureClassification =
  | "authentication"
  | "invalid-profile"
  | "protocol"
  | "transport"
  | "timeout"
  | "crash"
  | "runtime-error"
  | "cancelled";

export interface CodexRunFailure {
  readonly classification: CodexFailureClassification;
  readonly message: string;
  readonly code?: string;
}

export interface CodexRunResult {
  readonly status: "completed" | "failed" | "cancelled";
  readonly threadId: string;
  readonly turnId: string;
  readonly nativeStatus: string | null;
  readonly text: string;
  readonly reasoning: string;
  readonly reasoningSummary: string;
  readonly continuity: CodexContinuityOutcome;
  readonly failure?: CodexRunFailure;
}

export interface CodexRuntimeRun {
  readonly runtime: CodexRuntimeIdentity;
  readonly auth: CodexSubscriptionAuth;
  readonly threadId: string;
  readonly turnId: string;
  readonly continuity: CodexContinuityOutcome;
  readonly events: AsyncIterable<CodexStreamItem>;
  readonly completed: Promise<CodexRunResult>;
  cancel(reason?: string): Promise<void>;
}

export interface AgentRuntimeAdapter<
  TProfile,
  TRequest,
  TProbe,
  TRun,
> {
  readonly kind: string;
  probe(profile: TProfile): Promise<TProbe>;
  start(profile: TProfile, request: TRequest, options?: CodexRunOptions): Promise<TRun>;
}

export type CodexAppServerAdapterContract = AgentRuntimeAdapter<
  CodexAppServerProfile,
  CodexGenerationRequest,
  CodexProbeResult,
  CodexRuntimeRun
>;

export class CodexRuntimeError extends Error {
  readonly classification: CodexFailureClassification;
  readonly code?: string;

  constructor(
    classification: CodexFailureClassification,
    message: string,
    options: { readonly code?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodexRuntimeError";
    this.classification = classification;
    if (options.code !== undefined) this.code = options.code;
  }
}
