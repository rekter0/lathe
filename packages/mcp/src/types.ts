import type { JsonValue as DomainJsonValue } from "@lathe/domain";

export type JsonValue = DomainJsonValue;

export type StaticValue =
  | { kind: "literal"; value: string }
  | { kind: "secret"; secretId: string; prefix?: string; suffix?: string };

interface McpProfileBase {
  id: string;
  revision: string;
  name: string;
  description?: string;
  archived?: boolean;
  /** Explicitly selected roots; omitted and empty both mean no roots. */
  roots?: McpRoot[];
}

export interface StdioMcpTransportProfile {
  kind: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, StaticValue>;
  /** Optional immutable Lathe execution-target revision for container/SSH stdio. */
  executionTargetId?: string;
}

export interface StreamableHttpMcpTransportProfile {
  kind: "streamableHttp";
  url: string;
  headers?: Record<string, StaticValue>;
}

export type McpTransportProfile =
  | StdioMcpTransportProfile
  | StreamableHttpMcpTransportProfile;

export interface McpServerProfile extends McpProfileBase {
  transport: McpTransportProfile;
}

export interface ResolvedStdioMcpTransport {
  kind: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  secretValues: string[];
  executionTargetId?: string;
}

export interface ResolvedStreamableHttpMcpTransport {
  kind: "streamableHttp";
  url: URL;
  headers: Record<string, string>;
  secretValues: string[];
}

export type ResolvedMcpTransport =
  | ResolvedStdioMcpTransport
  | ResolvedStreamableHttpMcpTransport;

export type SecretResolver = (secretId: string) => Promise<string | undefined>;

export interface McpRoot {
  uri: string;
  name?: string;
}

/**
 * Safety policy applied to every MCP connection. Roots are opt-in, and
 * sampling/elicitation can never silently bypass the operator.
 */
export interface McpPolicy {
  roots: McpRoot[];
  toolApproval: "perCall" | "sessionTrust";
  samplingApproval: "always";
  elicitationApproval: "always";
  promptImport: "explicit";
  resourceImport: "explicit";
}

export const DEFAULT_MCP_POLICY: Readonly<McpPolicy> = Object.freeze({
  roots: Object.freeze([]) as unknown as McpRoot[],
  toolApproval: "perCall",
  samplingApproval: "always",
  elicitationApproval: "always",
  promptImport: "explicit",
  resourceImport: "explicit",
});

export type McpApprovalKind = "toolCall" | "sampling" | "elicitation";

interface McpApprovalRequestBase {
  id: string;
  kind: McpApprovalKind;
  profileId: string;
  profileRevision: string;
  sessionId?: string;
  createdAt: string;
  payload: JsonValue;
}

export interface McpToolCallApprovalRequest extends McpApprovalRequestBase {
  kind: "toolCall";
  toolName: string;
  toolRevisionHash: string;
}

export interface McpSamplingApprovalRequest extends McpApprovalRequestBase {
  kind: "sampling";
}

export interface McpElicitationApprovalRequest extends McpApprovalRequestBase {
  kind: "elicitation";
}

export type McpApprovalRequest =
  | McpToolCallApprovalRequest
  | McpSamplingApprovalRequest
  | McpElicitationApprovalRequest;

export type McpApprovalDecision =
  | { outcome: "approved"; editedPayload?: JsonValue; rememberForSession?: boolean }
  | { outcome: "denied"; reason?: string }
  | { outcome: "cancelled"; reason?: string };

export interface McpApprovalBroker {
  requestApproval(request: McpApprovalRequest): Promise<McpApprovalDecision>;
}

export type McpTraceDirection = "inbound" | "outbound" | "internal";
export type McpTraceLevel = "debug" | "info" | "warning" | "error";

export interface McpTraceEvent {
  at: string;
  profileId: string;
  profileRevision: string;
  transport: McpTransportProfile["kind"];
  direction: McpTraceDirection;
  level: McpTraceLevel;
  event:
    | "connect.start"
    | "connect.ready"
    | "connect.error"
    | "transport.message"
    | "transport.error"
    | "transport.closed"
    | "stdio.stderr"
    | "operation.start"
    | "operation.result"
    | "operation.error"
    | "approval.requested"
    | "approval.resolved";
  method?: string;
  payload?: JsonValue;
}

export interface McpTraceSink {
  record(event: McpTraceEvent): void | Promise<void>;
}

export interface McpToolSnapshot {
  name: string;
  description?: string;
  inputSchema: JsonValue;
  outputSchema?: JsonValue;
  annotations?: JsonValue;
}

export interface McpPromptSnapshot {
  name: string;
  description?: string;
  arguments?: JsonValue;
}

export interface McpResourceSnapshot {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplateSnapshot {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpCapabilitySnapshot {
  capturedAt: string;
  profileId: string;
  profileRevision: string;
  protocolVersion?: string;
  server?: JsonValue;
  instructions?: string;
  declared: JsonValue;
  tools: McpToolSnapshot[];
  prompts: McpPromptSnapshot[];
  resources: McpResourceSnapshot[];
  resourceTemplates: McpResourceTemplateSnapshot[];
  sha256: string;
}
