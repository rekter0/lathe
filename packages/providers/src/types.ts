import type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ModelCapabilities,
  ProviderModel,
  ProviderProtocol,
  RunClassification,
} from "@lathe/domain";

export type { JsonObject, JsonPrimitive, JsonValue, ModelCapabilities, ProviderProtocol };

export interface ModelDescriptor {
  readonly id: string;
  readonly label?: string;
  readonly createdAt?: string;
  readonly ownedBy?: string;
  readonly capabilities?: ModelCapabilities;
  readonly source: "manual" | "discovered";
}

export interface ProviderProfile {
  readonly id: string;
  readonly label: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  /** Plaintext at the package boundary. Callers must keep this field out of API DTOs. */
  readonly credential?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly extraBody?: JsonObject;
  readonly endpointOverride?: string | null;
  readonly endpointOverrides?: {
    readonly generate?: string;
    readonly models?: string;
  };
  readonly models?: readonly ProviderModel[];
  readonly capabilityOverrides?: Readonly<Record<string, ModelCapabilities>>;
  readonly anthropicVersion?: string;
}

export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

export interface ImagePart {
  readonly type: "image";
  readonly mediaType: string;
  readonly url?: string;
  readonly data?: string;
}

export interface FilePart {
  readonly type: "file";
  readonly name: string;
  readonly mediaType: string;
  readonly url?: string;
  readonly data?: string;
}

export type CanonicalContentPart = TextPart | ImagePart | FilePart;
export type CanonicalContent = string | readonly CanonicalContentPart[];

export interface CanonicalToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonValue | string;
}

export interface CanonicalMessage {
  readonly id?: string;
  readonly role: "user" | "assistant" | "tool";
  readonly content: CanonicalContent;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly CanonicalToolCall[];
  readonly isError?: boolean;
}

export interface CanonicalTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly strict?: boolean;
}

export type CanonicalToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly name: string };

export interface CanonicalGenerationRequest {
  readonly model: string;
  readonly messages: readonly CanonicalMessage[];
  readonly systemPrompt?: string;
  readonly tools?: readonly CanonicalTool[];
  readonly toolChoice?: CanonicalToolChoice;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  readonly stopSequences?: readonly string[];
  readonly stream?: boolean;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly extraBody?: JsonObject;
}

export interface CompileWarning {
  readonly code:
    | "default-max-tokens"
    | "unsupported-tool-choice"
    | "unsupported-setting"
    | "capability-override";
  readonly message: string;
}

export interface CompiledProviderRequest {
  readonly protocol: ProviderProtocol;
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: JsonObject;
  readonly warnings: readonly CompileWarning[];
}

export type ProviderErrorClassification = RunClassification;

export interface ProviderFailure {
  readonly classification: ProviderErrorClassification;
  readonly message: string;
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;
  readonly details?: JsonValue;
}

export interface ProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
}

export type NormalizedProviderEvent =
  | { readonly type: "response.start"; readonly responseId?: string; readonly model?: string }
  | { readonly type: "content.delta"; readonly text: string; readonly index: number }
  | { readonly type: "reasoning.delta"; readonly text: string; readonly index: number }
  | {
      readonly type: "tool_call.start";
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
    }
  | {
      readonly type: "tool_call.delta";
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta: string;
    }
  | { readonly type: "usage"; readonly usage: ProviderUsage }
  | { readonly type: "response.completed"; readonly finishReason?: string }
  | { readonly type: "provider.error"; readonly error: ProviderFailure }
  | { readonly type: "provider.unknown"; readonly providerType?: string };

export interface ServerSentEvent {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
  /** Exact decoded frame, including the terminating blank line when present. */
  readonly raw: string;
}

export type RawTraceKind = "request" | "response" | "sse" | "json" | "error";

export interface RawTraceEvent {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly kind: RawTraceKind;
  /** Redacted before it crosses the provider package boundary. */
  readonly data: JsonValue;
}

export interface ProviderStreamItem {
  readonly trace: RawTraceEvent;
  readonly events: readonly NormalizedProviderEvent[];
}

export interface ExecuteOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export interface ModelDiscoveryOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly remote?: boolean;
}

export interface ModelDiscoveryResult {
  readonly models: readonly ModelDescriptor[];
  readonly warnings: readonly string[];
}

export interface ProtocolAdapter {
  readonly protocol: ProviderProtocol;
  readonly defaultGeneratePath: string;
  readonly defaultModelsPath: string;
  readonly protectedBodyFields: ReadonlySet<string>;
  compile(profile: ProviderProfile, request: CanonicalGenerationRequest): CompiledProviderRequest;
  normalizeSse(event: ServerSentEvent): readonly NormalizedProviderEvent[];
  normalizeJson(payload: JsonValue): readonly NormalizedProviderEvent[];
}

export class ProviderCompileError extends Error {
  readonly code: "protected-field" | "unsupported-content" | "invalid-profile";
  readonly field?: string;

  constructor(
    code: ProviderCompileError["code"],
    message: string,
    options: { field?: string } = {},
  ) {
    super(message);
    this.name = "ProviderCompileError";
    this.code = code;
    if (options.field !== undefined) this.field = options.field;
  }
}
