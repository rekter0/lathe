export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Id = string;
export type IsoDateTime = string;

export interface Project {
  id: Id;
  name: string;
  description: string;
  targetName: string;
  defaultHarnessRevisionId: Id | null;
  workspaceRoot: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Session {
  id: Id;
  projectId: Id;
  name: string;
  description: string;
  providerProfileId: Id | null;
  modelId: string | null;
  activeBranchId: Id | null;
  draftConfig: ResolvedConfig;
  autoContinueTools: boolean;
  autoContinueLimit: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type MessageRole = "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface AttachmentPart {
  type: "attachment";
  attachmentId: Id;
  name: string;
  mediaType: string;
}

export interface ToolCallPart {
  type: "tool-call";
  callId: string;
  name: string;
  arguments: JsonValue;
  providerData?: JsonObject;
}

export interface ToolResultPart {
  type: "tool-result";
  callId: string;
  name: string;
  result: JsonValue;
  isError: boolean;
}

export type MessagePart = TextPart | AttachmentPart | ToolCallPart | ToolResultPart;

export interface MessageNode {
  id: Id;
  sessionId: Id;
  parentId: Id | null;
  role: MessageRole;
  parts: MessagePart[];
  sourceRunId: Id | null;
  configSnapshotId: Id | null;
  sourcePayloadRevisionId: Id | null;
  createdAt: IsoDateTime;
}

export interface BranchRef {
  id: Id;
  sessionId: Id;
  name: string;
  headNodeId: Id | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Checkpoint {
  id: Id;
  sessionId: Id;
  name: string;
  nodeId: Id | null;
  configSnapshotId: Id;
  providerProfileId: Id | null;
  modelId: string | null;
  autoContinueTools: boolean;
  autoContinueLimit: number;
  sessionStateCaptured: boolean;
  createdAt: IsoDateTime;
}

export interface PromptBlockSnapshot {
  revisionId: Id;
  name: string;
  content: string;
  enabled: boolean;
  order: number;
}

export type ToolImplementationMode = "manual" | "mock" | "real" | "mcp";
export type ToolApprovalMode = "manual" | "bypass-approval";

export interface ToolBindingSnapshot {
  toolRevisionId: Id;
  implementationRevisionId: Id | null;
  name: string;
  description: string;
  inputSchema: JsonObject;
  enabled: boolean;
  mode: ToolImplementationMode;
  targetId: Id | null;
  mcpServerId: Id | null;
}

export interface ProviderSnapshot {
  profileId: Id;
  profileRevision: number;
  protocol: ProviderProtocol;
  label: string;
  baseUrl: string;
  /** Optional for backward compatibility with snapshots created before v1. */
  endpointOverride?: string | null;
  modelId: string;
  headers: Record<string, string>;
  extraBody: JsonObject;
  capabilities: ModelCapabilities;
}

export interface ResolvedConfig {
  promptBlocks: PromptBlockSnapshot[];
  tools: ToolBindingSnapshot[];
  toolApprovalMode: ToolApprovalMode;
  provider: ProviderSnapshot | null;
  temperature: number | null;
  maxOutputTokens: number | null;
  protocolOverrides: Partial<Record<ProviderProtocol, JsonObject>>;
  compileWarnings: string[];
}

export interface ConfigSnapshot {
  id: Id;
  sessionId: Id;
  config: ResolvedConfig;
  contentHash: string;
  createdAt: IsoDateTime;
}

export type ProviderProtocol = "openai-responses" | "openai-chat" | "anthropic-messages";

export interface ModelCapabilities {
  streaming: boolean;
  tools: boolean;
  images: boolean;
  files: boolean;
  jsonMode: boolean;
  maxContextTokens: number | null;
}

export interface ProviderProfile {
  id: Id;
  label: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  endpointOverride: string | null;
  credential: string;
  headers: Record<string, string>;
  extraBody: JsonObject;
  models: ProviderModel[];
  revision: number;
  archivedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ProviderModel {
  id: string;
  label: string;
  capabilities: ModelCapabilities;
  discovered: boolean;
}

export interface SecretMetadata {
  id: Id;
  label: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type RunStatus =
  | "queued"
  | "streaming"
  | "awaiting-tool"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type RunClassification =
  | "transport"
  | "authentication"
  | "rate-limit"
  | "invalid-request"
  | "content-policy"
  | "unavailable"
  | "timeout"
  | "parse-failure"
  | "interrupted-stream"
  | "cancelled"
  | "tool-failure"
  | "unknown";

export interface ModelRun {
  id: Id;
  sessionId: Id;
  branchId: Id;
  contextNodeId: Id | null;
  resultNodeId: Id | null;
  configSnapshotId: Id;
  status: RunStatus;
  classification: RunClassification | null;
  operatorLabel: string | null;
  operatorNotes: string | null;
  normalizedOutput: JsonValue | null;
  usage: JsonObject | null;
  traceHash: string | null;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

export interface Attachment {
  id: Id;
  projectId: Id;
  fileName: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: IsoDateTime;
}

export type AssetKind =
  | "prompt"
  | "tool-spec"
  | "tool-implementation"
  | "harness"
  | "target"
  | "mcp-server"
  | "payload-generator-profile"
  | "payload-generator-instruction"
  | "payload-technique"
  | "payload-pipeline";

export interface AssetRevision<T extends JsonValue = JsonValue> {
  id: Id;
  assetId: Id;
  kind: AssetKind;
  revision: number;
  name: string;
  description: string;
  tags: string[];
  provenance: JsonObject;
  value: T;
  contentHash: string;
  trusted: boolean;
  archivedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

export interface Finding {
  id: Id;
  projectId: Id;
  sessionId: Id;
  branchId: Id;
  nodeId: Id | null;
  title: string;
  severity: "informational" | "low" | "medium" | "high" | "critical";
  summary: string;
  expected: string;
  observed: string;
  tags: string[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type AutomationKind = "replay" | "payload-fanout" | "batch-vary";
export type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";

export interface AutomationJob {
  id: Id;
  projectId: Id;
  sessionId: Id;
  kind: AutomationKind;
  status: JobStatus;
  concurrency: number;
  plan: JsonObject;
  progress: JsonObject;
  error: JsonObject | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Mutable application-wide settings for the local Lathe server. */
export interface ApplicationSettings {
  id: Id;
  redactionEnabled: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type PayloadContextMode = "none" | "minimal" | "full";
export type PayloadDiversity = "low" | "balanced" | "high";

export interface PayloadGenerationOptions {
  contextMode: PayloadContextMode;
  includeProjectBrief: boolean;
  includeSessionBrief: boolean;
  includeTargetConfig: boolean;
  budgetChars: number;
}

/** Global defaults for the local operator's payload workbench. */
export interface PayloadWorkbenchSettings extends PayloadGenerationOptions {
  id: Id;
  defaultGeneratorProfileRevisionId: Id | null;
  defaultInstructionRevisionId: Id | null;
  candidateCount: number;
  diversity: PayloadDiversity;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Mutable deterministic matrix controls; source text and results are never settings. */
export interface PayloadVariantMatrixDraft {
  transformId: string;
  version: 1;
  parameterSets: Record<string, string>[];
}

/** Mutable Payload Workbench choices scoped to one session. */
export interface SessionPayloadWorkbenchSettings extends PayloadGenerationOptions {
  sessionId: Id;
  generatorProfileRevisionId: Id | null;
  instructionRevisionId: Id | null;
  techniqueRevisionIds: Id[];
  pipelineRevisionId: Id | null;
  operatorInstruction: string;
  variables: Record<string, string>;
  candidateCount: number;
  diversity: PayloadDiversity;
  variantMatrix: PayloadVariantMatrixDraft | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type PayloadGenerationStatus =
  | "queued"
  | "streaming"
  | "partial"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface PayloadGeneration {
  id: Id;
  projectId: Id;
  sessionId: Id;
  branchId: Id;
  contextNodeId: Id | null;
  parentRevisionId: Id | null;
  feedback: string | null;
  operatorInstruction: string;
  generatorProfileRevisionId: Id;
  instructionRevisionId: Id | null;
  techniqueRevisionIds: Id[];
  pipelineRevisionId: Id | null;
  variables: JsonObject;
  contextOptions: PayloadGenerationOptions;
  candidateCount: number;
  diversity: PayloadDiversity;
  contextSnapshot: JsonObject;
  contextHash: string;
  status: PayloadGenerationStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  deletedAt: IsoDateTime | null;
}

/** One backend/provider invocation belonging to a logical payload generation. */
export interface PayloadGenerationAttempt {
  id: Id;
  generationId: Id;
  ordinal: number;
  backendSnapshot: JsonObject;
  providerProfileId: Id | null;
  modelId: string | null;
  configSnapshotId: Id | null;
  nativeThreadId: string | null;
  nativeTurnId: string | null;
  status: RunStatus;
  classification: RunClassification | null;
  normalizedOutput: JsonValue | null;
  usage: JsonObject | null;
  traceHash: string | null;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type PayloadRevisionOperation = "generated" | "refined" | "edited" | "transformed";

/** Immutable payload text plus its derivation and generation evidence. */
export interface PayloadRevision {
  id: Id;
  projectId: Id;
  sessionId: Id;
  generationId: Id | null;
  attemptId: Id | null;
  parentRevisionId: Id | null;
  ordinal: number;
  operation: PayloadRevisionOperation;
  text: string;
  contentHash: string;
  provenance: JsonObject;
  createdAt: IsoDateTime;
  deletedAt: IsoDateTime | null;
}

export interface TraceEvent {
  sequence: number;
  timestamp: IsoDateTime;
  direction: "request" | "response" | "internal";
  kind: "headers" | "body" | "sse" | "status" | "error" | "log";
  data: JsonValue;
}
