import {
  compileSystemPrompt,
  emptyResolvedConfig,
  pathToRoot,
  type JsonObject,
  type JsonValue,
  type MessageNode,
  type MessagePart,
  type ProviderProfile,
  type ResolvedConfig,
  type ToolApprovalMode,
  type ToolCallPart,
  type ToolResultPart
} from "@lathe/domain";
import type { ContentStore, LatheRepository } from "@lathe/db";
import {
  ExecutionTargets,
  QuickJsWorkerHandlerEvaluator,
  SessionTrustStore,
  createApprovalView,
  executionTargetForApproval,
  hashRevisionParts,
  requiresApproval,
  resolveApproval,
  serializableExecutionResult,
  type ExecutionRequest,
  type ExecutionTarget,
  type ToolCallApproval
} from "@lathe/execution";
import {
  DEFAULT_MCP_POLICY,
  LatheMcpClient,
  type McpApprovalBroker,
  type McpApprovalDecision,
  type McpApprovalRequest,
  type McpRoot,
  type McpServerProfile,
  type McpTraceEvent
} from "@lathe/mcp";
import {
  compileProviderRequest,
  executeProviderRequest,
  redactHeaders,
  redactJson as redactProviderJson,
  redactUrl,
  type CanonicalContentPart,
  type CanonicalGenerationRequest,
  type CanonicalMessage,
  type CanonicalToolCall,
  type NormalizedProviderEvent,
  type ProviderFailure,
  type ProviderUsage
} from "@lathe/providers";
import type { EventHub } from "./events.js";
import { ProviderOutcomeTracker } from "./provider-outcome.js";
import type { RunCoordinator, StartedRun, StartRunInput } from "./run-coordinator.js";

interface ToolAccumulator {
  id: string;
  name: string;
  argumentsText: string;
}

interface PendingToolRun {
  runId: string;
  sessionId: string;
  branchId: string;
  assistantNodeId: string;
  calls: ToolCallPart[];
  resolutions: Map<string, ToolResultPart>;
  prepared: Map<string, PreparedToolCall>;
  toolApprovalMode: ToolApprovalMode;
}

interface PreparedToolCall {
  call: ToolCallPart;
  mode: "manual" | "mock" | "real" | "mcp";
  toolRevisionHash: string;
  targetId: string;
  targetRevisionId: string;
  targetRevisionHash: string;
  mockResult?: JsonValue;
  source?: string;
  request?: ExecutionRequest;
  target?: ExecutionTarget;
  mcpProfile?: McpServerProfile;
  mcpServerRevisionId?: string;
  mcpServerRevisionHash?: string;
  mcpExecutionTarget?: ExecutionTarget;
  traceHash?: string;
  rawResultHash?: string;
  approvalEvidence?: JsonValue;
  formattedResult?: JsonValue;
  executionFailed?: boolean;
}

interface ResolvedExecutionTargetRevision {
  target: ExecutionTarget;
  revisionId: string;
  revisionHash: string;
}

interface PendingMcpApproval {
  runId: string;
  request: McpApprovalRequest;
  resolve(value: { decision: McpApprovalDecision; response?: JsonValue }): void;
}

interface ApprovedMcpSampling {
  request: McpApprovalRequest;
  payload: JsonValue;
}

export interface ParsedMcpSamplingRequest {
  messages: CanonicalMessage[];
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens: number;
  stopSequences?: string[];
  warnings: string[];
}

class ToolEvidenceError extends Error {
  constructor(message: string, readonly evidence: JsonObject) {
    super(message);
    this.name = "ToolEvidenceError";
  }
}

class ApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}

function asJsonObject(value: JsonValue | null): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function savedToolResults(value: JsonValue | null): ToolResultPart[] {
  const results = asJsonObject(value).toolResults;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    if (item.type !== "tool-result" || typeof item.callId !== "string" || typeof item.name !== "string" || typeof item.isError !== "boolean" || !("result" in item)) return [];
    return [item as unknown as ToolResultPart];
  });
}

function explicitMcpRoots(value: JsonValue | undefined, fallback: McpRoot[] = []): McpRoot[] {
  if (value === undefined) return fallback.map((root) => ({ ...root }));
  if (!Array.isArray(value)) throw new Error("MCP roots must be an array of file: URIs");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.uri !== "string") throw new Error("Each MCP root requires a file: URI");
    const uri = new URL(item.uri);
    if (uri.protocol !== "file:") throw new Error("MCP roots must use file: URIs");
    return { uri: item.uri, ...(typeof item.name === "string" ? { name: item.name } : {}) };
  });
}

function textFromNode(node: MessageNode): string {
  return node.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function samplingObject(value: JsonValue, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function samplingTextContent(value: JsonValue, messageIndex: number): string | CanonicalContentPart[] {
  const blocks = Array.isArray(value) ? value : [value];
  if (blocks.length === 0) throw new Error(`MCP sampling message ${messageIndex} must contain at least one text block`);
  if (blocks.length > 1_000) throw new Error(`MCP sampling message ${messageIndex} has too many content blocks`);
  const parts = blocks.map((block, blockIndex): CanonicalContentPart => {
    const content = samplingObject(block, `MCP sampling message ${messageIndex} content block ${blockIndex}`);
    if (content.type !== "text") {
      const type = typeof content.type === "string" ? content.type : "unknown";
      throw new Error(`Unsupported MCP sampling content type \"${type}\" in message ${messageIndex}; Lathe sampling currently accepts text only`);
    }
    if (typeof content.text !== "string") throw new Error(`MCP sampling message ${messageIndex} text content must be a string`);
    if (content.text.length > 1_000_000) throw new Error(`MCP sampling message ${messageIndex} text content is too large`);
    return { type: "text", text: content.text };
  });
  return parts.length === 1 ? (parts[0] as { type: "text"; text: string }).text : parts;
}

/** Convert the deliberately small, text-only MCP sampling subset into Lathe's canonical request. */
export function parseMcpSamplingRequest(payload: JsonValue): ParsedMcpSamplingRequest {
  const input = samplingObject(payload, "MCP sampling request");
  const supportedFields = new Set([
    "messages", "systemPrompt", "includeContext", "temperature", "maxTokens",
    "stopSequences", "modelPreferences", "metadata", "_meta"
  ]);
  for (const field of Object.keys(input)) {
    if (field === "tools" || field === "toolChoice") {
      throw new Error("MCP sampling tools and tool choice are not supported by Lathe's nested sampling runtime");
    }
    if (!supportedFields.has(field)) throw new Error(`Unsupported MCP sampling field \"${field}\"`);
  }
  if (!Array.isArray(input.messages)) throw new Error("MCP sampling messages must be an array");
  if (input.messages.length > 1_000) throw new Error("MCP sampling request has too many messages");
  const messages = input.messages.map((value, index): CanonicalMessage => {
    const message = samplingObject(value, `MCP sampling message ${index}`);
    if (message.role !== "user" && message.role !== "assistant") {
      throw new Error(`MCP sampling message ${index} role must be user or assistant`);
    }
    if (!("content" in message)) throw new Error(`MCP sampling message ${index} is missing content`);
    return { role: message.role, content: samplingTextContent(message.content, index) };
  });
  const totalText = messages.reduce((sum, message) => sum + (typeof message.content === "string"
    ? message.content.length
    : message.content.reduce((partSum, part) => partSum + (part.type === "text" ? part.text.length : 0), 0)), 0);
  if (totalText > 4_000_000) throw new Error("MCP sampling request text is too large");

  if (input.systemPrompt !== undefined && typeof input.systemPrompt !== "string") throw new Error("MCP sampling systemPrompt must be a string");
  if (typeof input.systemPrompt === "string" && input.systemPrompt.length > 1_000_000) throw new Error("MCP sampling systemPrompt is too large");
  if (input.includeContext !== undefined && input.includeContext !== "none") {
    throw new Error("MCP sampling includeContext is unsupported; Lathe does not silently import MCP server context");
  }
  if (typeof input.maxTokens !== "number" || !Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 10_000_000) {
    throw new Error("MCP sampling maxTokens must be an integer from 1 to 10000000");
  }
  if (input.temperature !== undefined && (typeof input.temperature !== "number" || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)) {
    throw new Error("MCP sampling temperature must be a finite number from 0 to 2");
  }
  let stopSequences: string[] | undefined;
  if (input.stopSequences !== undefined) {
    if (!Array.isArray(input.stopSequences) || input.stopSequences.length > 100 || input.stopSequences.some((item) => typeof item !== "string" || item.length === 0 || item.length > 10_000)) {
      throw new Error("MCP sampling stopSequences must contain at most 100 non-empty strings");
    }
    stopSequences = input.stopSequences as string[];
  }
  const warnings: string[] = [];
  if (input.modelPreferences !== undefined) warnings.push("MCP model preferences were not applied; Lathe used the session's active provider and model");
  if (input.metadata !== undefined) warnings.push("MCP sampling metadata was retained as evidence but not sent to the provider");
  return {
    messages,
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt as string }),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature as number }),
    maxOutputTokens: input.maxTokens,
    ...(stopSequences === undefined ? {} : { stopSequences }),
    warnings
  };
}

function mcpStopReason(finishReason: string | undefined): string {
  if (!finishReason || finishReason === "stop" || finishReason === "end_turn") return "endTurn";
  if (finishReason === "length" || finishReason === "max_tokens") return "maxTokens";
  if (finishReason === "stop_sequence") return "stopSequence";
  return finishReason;
}

function mcpServerForApproval(prepared: PreparedToolCall): JsonObject {
  if (!prepared.mcpProfile) throw new Error("MCP server was not prepared");
  const transport = prepared.mcpProfile.transport;
  return {
    revisionId: prepared.mcpServerRevisionId ?? null,
    revisionHash: prepared.mcpServerRevisionHash ?? null,
    profileId: prepared.mcpProfile.id,
    profileRevision: prepared.mcpProfile.revision,
    name: prepared.mcpProfile.name,
    transport: transport.kind === "stdio"
      ? {
          kind: transport.kind,
          command: transport.command,
          args: transport.args ?? [],
          cwd: transport.cwd ?? null,
          environmentNames: Object.keys(transport.env ?? {}).sort()
        }
      : {
          kind: transport.kind,
          url: redactUrl(transport.url),
          headerNames: Object.keys(transport.headers ?? {}).sort()
        }
  };
}

function safeProviderSnapshot(profile: ProviderProfile, modelId: string, config: ResolvedConfig): ResolvedConfig {
  const knownSecrets = [profile.credential, ...Object.values(profile.headers)].filter(Boolean);
  const headers = redactHeaders(profile.headers, knownSecrets);
  const model = profile.models.find((entry) => entry.id === modelId);
  return {
    ...structuredClone(config),
    toolApprovalMode: config.toolApprovalMode ?? "manual",
    provider: {
      profileId: profile.id,
      profileRevision: profile.revision,
      protocol: profile.protocol,
      label: profile.label,
      baseUrl: redactUrl(profile.baseUrl, knownSecrets),
      endpointOverride: profile.endpointOverride === null
        ? null
        : redactUrl(profile.endpointOverride, knownSecrets),
      modelId,
      headers,
      extraBody: redactProviderJson(profile.extraBody, knownSecrets) as JsonObject,
      capabilities: model?.capabilities ?? {
        streaming: true,
        tools: true,
        images: false,
        files: false,
        jsonMode: false,
        maxContextTokens: null
      }
    }
  };
}

function providerProfile(profile: ProviderProfile) {
  return {
    id: profile.id,
    label: profile.label,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    credential: profile.credential,
    headers: profile.headers,
    extraBody: profile.extraBody,
    endpointOverride: profile.endpointOverride,
    models: profile.models
  } as const;
}

export class ProviderRunCoordinator implements RunCoordinator {
  private readonly controllers = new Map<string, AbortController>();
  private readonly pendingTools = new Map<string, PendingToolRun>();
  private readonly pendingMcpApprovals = new Map<string, PendingMcpApproval>();
  private readonly resolvingToolCalls = new Set<string>();
  private readonly resolvingToolRuns = new Set<string>();
  private readonly toolControllers = new Map<string, AbortController>();
  private readonly trust = new SessionTrustStore();
  private readonly evaluator = new QuickJsWorkerHandlerEvaluator();
  private readonly executionTargets = new ExecutionTargets();

  constructor(
    private readonly repository: LatheRepository,
    private readonly contentStore: ContentStore,
    private readonly events: EventHub,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch
  ) {}

  async start(input: StartRunInput): Promise<StartedRun> {
    const session = await this.repository.getSession(input.sessionId);
    if (!session) throw new Error("Session not found");
    const branch = (await this.repository.listBranches(session.id)).find((item) => item.id === input.branchId);
    if (!branch) throw new Error("Branch not found");
    let contextNodeId = input.contextNodeId ?? branch.headNodeId;
    if (branch.headNodeId !== contextNodeId) throw new Error("Run context must be the current branch head; fork or rewind first");
    if (input.userMessage) {
      let sourcePayloadRevisionId = input.sourcePayloadRevisionId ?? null;
      if (sourcePayloadRevisionId) {
        const source = await this.repository.getPayloadRevision(sourcePayloadRevisionId);
        if (!source || source.sessionId !== session.id) throw new Error("Source payload revision does not belong to this session");
        if (source.text !== input.userMessage) {
          const edited = await this.repository.createPayloadRevision({
            projectId: session.projectId,
            sessionId: session.id,
            generationId: source.generationId,
            attemptId: null,
            parentRevisionId: source.id,
            ordinal: source.ordinal,
            operation: "edited",
            text: input.userMessage,
            provenance: { kind: "composer-edit", parentHash: source.contentHash }
          });
          sourcePayloadRevisionId = edited.id;
        }
      }
      const userNode = await this.repository.appendNode({
        sessionId: session.id,
        branchId: branch.id,
        parentId: contextNodeId,
        role: "user",
        parts: [{ type: "text", text: input.userMessage }],
        sourcePayloadRevisionId
      });
      contextNodeId = userNode.id;
      this.events.publish(`session:${session.id}`, "node.created", userNode as unknown as JsonValue);
    }
    if (!session.providerProfileId || !session.modelId) throw new Error("Select a provider and model before starting a run");
    const profile = await this.repository.getProviderProfile(session.providerProfileId);
    if (!profile) throw new Error("Provider profile not found");
    const config = safeProviderSnapshot(profile, session.modelId, input.configOverride ?? session.draftConfig);
    const snapshot = await this.repository.createConfigSnapshot(session.id, config);
    const run = await this.repository.createRun({
      sessionId: session.id,
      branchId: branch.id,
      contextNodeId,
      configSnapshotId: snapshot.id
    });
    this.events.publish(`run:${run.id}`, "run.queued", run as unknown as JsonValue);
    void this.perform(run.id, profile, config, contextNodeId);
    return { id: run.id, status: run.status };
  }

  async cancel(runId: string): Promise<boolean> {
    const controller = this.controllers.get(runId);
    if (controller) controller.abort(new DOMException("Cancelled by operator", "AbortError"));
    const toolController = this.toolControllers.get(runId);
    if (toolController) toolController.abort(new DOMException("Cancelled by operator", "AbortError"));
    let cancelledApproval = false;
    for (const [id, pending] of this.pendingMcpApprovals) {
      if (pending.runId !== runId) continue;
      pending.resolve({ decision: { outcome: "cancelled", reason: "Cancelled by operator" } });
      this.pendingMcpApprovals.delete(id);
      cancelledApproval = true;
    }
    const run = await this.repository.getRun(runId);
    const awaitingTool = run?.status === "awaiting-tool";
    if (awaitingTool) {
      await this.repository.updateRun(runId, { status: "cancelled", classification: "cancelled", finishedAt: new Date().toISOString() });
      if (!this.resolvingToolRuns.has(runId)) this.pendingTools.delete(runId);
      this.events.publish(`run:${runId}`, "run.cancelled", { runId });
    }
    return Boolean(controller) || Boolean(toolController) || cancelledApproval || awaitingTool;
  }

  async resolveMcpApproval(runId: string, approvalId: string, resolution: JsonValue): Promise<void> {
    const pending = this.pendingMcpApprovals.get(approvalId);
    if (!pending || pending.runId !== runId) throw new Error("MCP approval is not active in this server process; retry the parent tool call after restart");
    if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) throw new Error("MCP approval resolution must be an object");
    const outcome = resolution.outcome;
    if (outcome !== "approved" && outcome !== "denied" && outcome !== "cancelled") throw new Error("MCP approval outcome must be approved, denied, or cancelled");
    const decision: McpApprovalDecision = outcome === "approved"
      ? { outcome, ...(resolution.editedPayload === undefined ? {} : { editedPayload: resolution.editedPayload }) }
      : { outcome, ...(typeof resolution.reason === "string" ? { reason: resolution.reason } : {}) };
    const response = resolution.response;
    if (outcome === "approved" && pending.request.kind === "elicitation" && response === undefined) {
      throw new Error("Approved MCP elicitation requires an explicit operator JSON response");
    }
    if (outcome === "approved" && pending.request.kind === "sampling" && response !== undefined) {
      throw new Error("Approved MCP sampling must not include an operator response; Lathe invokes the active provider");
    }
    await this.recordMcpApproval(runId, pending.request, "resolved", {
      outcome,
      ...(resolution.editedPayload === undefined ? {} : { editedPayload: resolution.editedPayload }),
      ...(response === undefined ? {} : { response })
    });
    this.pendingMcpApprovals.delete(approvalId);
    pending.resolve({ decision, ...(response === undefined ? {} : { response }) });
  }

  async resolveToolCall(runId: string, callId: string, resolution: JsonValue): Promise<void> {
    const key = `${runId}\u0000${callId}`;
    if (this.resolvingToolCalls.has(key)) throw new Error("Tool call resolution is already in progress");
    if (this.resolvingToolRuns.has(runId)) throw new Error("Another tool call resolution for this run is already in progress");
    this.resolvingToolCalls.add(key);
    this.resolvingToolRuns.add(runId);
    this.toolControllers.set(runId, new AbortController());
    try {
      await this.resolveToolCallOnce(runId, callId, resolution);
    } finally {
      this.resolvingToolCalls.delete(key);
      this.resolvingToolRuns.delete(runId);
      this.toolControllers.delete(runId);
    }
  }

  private async resolveToolCallOnce(runId: string, callId: string, resolution: JsonValue): Promise<void> {
    const pending = this.pendingTools.get(runId) ?? await this.restorePendingToolRun(runId);
    const call = pending.calls.find((item) => item.callId === callId);
    if (!call) throw new Error("Tool call not found");
    if (pending.resolutions.has(callId)) throw new Error("Tool call has already been resolved");
    const prepared = pending.prepared.get(callId);
    if (!prepared) throw new Error("Tool call was not prepared");
    const wrapped = resolution && typeof resolution === "object" && !Array.isArray(resolution) ? resolution as JsonObject : { result: resolution };
    let result: JsonValue;
    let isError = wrapped.isError === true;
    if (prepared.mode === "real") {
      try {
        result = await this.executeRealTool(pending, prepared, wrapped);
      } catch (error) {
        if (error instanceof ApprovalRequiredError) throw error;
        result = error instanceof ToolEvidenceError ? error.evidence : { error: error instanceof Error ? error.message : String(error) };
        isError = true;
      }
    } else if (prepared.mode === "mcp") {
      try {
        result = await this.executeMcpTool(pending, prepared, wrapped);
      } catch (error) {
        if (error instanceof ApprovalRequiredError) throw error;
        result = error instanceof ToolEvidenceError ? error.evidence : { error: error instanceof Error ? error.message : String(error) };
        isError = true;
      }
    } else if (prepared.mode === "mock") {
      result = wrapped.result ?? prepared.mockResult ?? null;
    } else {
      result = wrapped.result ?? resolution;
    }
    if (prepared.executionFailed || (result && typeof result === "object" && !Array.isArray(result) && result.isError === true)) isError = true;
    prepared.formattedResult = result;
    pending.resolutions.set(callId, {
      type: "tool-result",
      callId,
      name: call.name,
      result,
      isError
    });
    const currentRun = await this.repository.getRun(runId);
    if (!currentRun) throw new Error("Run disappeared while resolving a tool call");
    await this.repository.updateRun(runId, {
      normalizedOutput: {
        ...asJsonObject(currentRun.normalizedOutput),
        toolResults: pending.calls
          .map((item) => pending.resolutions.get(item.callId))
          .filter((item): item is ToolResultPart => Boolean(item)) as unknown as JsonValue,
        toolEvidence: pending.calls.map((item) => {
          const preparedCall = pending.prepared.get(item.callId);
          return {
            callId: item.callId,
            mode: preparedCall?.mode ?? "manual",
            approval: preparedCall?.approvalEvidence ?? null,
            traceHash: preparedCall?.traceHash ?? null,
            rawResultHash: preparedCall?.rawResultHash ?? null,
            formattedResult: preparedCall?.formattedResult ?? null
          };
        })
      }
    });
    if (currentRun.status === "cancelled" || this.toolControllers.get(runId)?.signal.aborted) {
      this.pendingTools.delete(runId);
      this.events.publish(`run:${runId}`, "tool.resolution.discarded", { callId, reason: "run-cancelled" });
      return;
    }
    this.events.publish(`run:${runId}`, "tool.resolved", { callId, resolution } as JsonValue);
    if (pending.resolutions.size !== pending.calls.length) return;
    const parts = pending.calls.map((item) => pending.resolutions.get(item.callId)).filter((item): item is ToolResultPart => Boolean(item));
    const node = await this.repository.appendNode({
      sessionId: pending.sessionId,
      branchId: pending.branchId,
      parentId: pending.assistantNodeId,
      role: "tool",
      parts,
      sourceRunId: runId
    });
    await this.repository.updateRun(runId, {
      status: "completed",
      classification: parts.some((part) => part.isError) ? "tool-failure" : null,
      finishedAt: new Date().toISOString()
    });
    this.pendingTools.delete(runId);
    this.events.publish(`session:${pending.sessionId}`, "node.created", node as unknown as JsonValue);
    this.events.publish(`run:${runId}`, "run.completed", { resultNodeId: pending.assistantNodeId, toolResultNodeId: node.id });
    await this.maybeAutoContinue(pending, node, parts);
  }

  private async restorePendingToolRun(runId: string): Promise<PendingToolRun> {
    const run = await this.repository.getRun(runId);
    if (!run || run.status !== "awaiting-tool" || !run.resultNodeId) throw new Error("Run has no pending tool calls");
    const assistant = await this.repository.getNode(run.resultNodeId);
    if (!assistant || assistant.role !== "assistant") throw new Error("Pending run assistant node is missing");
    const calls = assistant.parts.filter((part): part is ToolCallPart => part.type === "tool-call");
    if (calls.length === 0) throw new Error("Pending run contains no tool calls");
    const snapshot = await this.repository.getConfigSnapshot(run.configSnapshotId);
    if (!snapshot) throw new Error("Pending run configuration snapshot is missing");
    const prepared = new Map<string, PreparedToolCall>();
    for (const call of calls) prepared.set(call.callId, await this.prepareToolCall(snapshot.config, call));
    const resolutions = new Map(savedToolResults(run.normalizedOutput).map((part) => [part.callId, part]));
    const output = asJsonObject(run.normalizedOutput);
    if (Array.isArray(output.mcpApprovalRequests)) {
      const restoredApprovals = output.mcpApprovalRequests.map((item) => item && typeof item === "object" && !Array.isArray(item) && item.status === "pending"
        ? { ...item, status: "interrupted", reason: "server-restart" }
        : item);
      await this.repository.updateRun(runId, { normalizedOutput: { ...output, mcpApprovalRequests: restoredApprovals } });
    }
    const pending: PendingToolRun = {
      runId,
      sessionId: run.sessionId,
      branchId: run.branchId,
      assistantNodeId: assistant.id,
      calls,
      resolutions,
      prepared,
      toolApprovalMode: snapshot.config.toolApprovalMode ?? "manual"
    };
    this.pendingTools.set(runId, pending);
    this.events.publish(`run:${runId}`, "run.awaiting-tool.restored", {
      calls: calls.map((call) => call.callId),
      resolved: [...resolutions.keys()]
    });
    return pending;
  }

  private async annotateRun(runId: string, key: string, value: JsonValue): Promise<void> {
    const run = await this.repository.getRun(runId);
    if (!run) return;
    await this.repository.updateRun(runId, { normalizedOutput: { ...asJsonObject(run.normalizedOutput), [key]: value } });
  }

  private async recordMcpApproval(runId: string, request: McpApprovalRequest, status: "pending" | "resolved" | "interrupted", resolution?: JsonValue): Promise<void> {
    const run = await this.repository.getRun(runId);
    if (!run) return;
    const output = asJsonObject(run.normalizedOutput);
    const prior = Array.isArray(output.mcpApprovalRequests) ? output.mcpApprovalRequests : [];
    const record: JsonObject = {
      id: request.id,
      kind: request.kind,
      status,
      request: this.toJson(request),
      ...(resolution === undefined ? {} : { resolution })
    };
    const records = [...prior.filter((item) => !item || typeof item !== "object" || Array.isArray(item) || item.id !== request.id), record];
    await this.repository.updateRun(runId, { normalizedOutput: { ...output, mcpApprovalRequests: records } });
    this.events.publish(`run:${runId}`, `mcp.approval.${status}`, record);
  }

  private async awaitMcpApproval(runId: string, request: McpApprovalRequest): Promise<{ decision: McpApprovalDecision; response?: JsonValue }> {
    await this.recordMcpApproval(runId, request, "pending");
    return new Promise((resolve) => {
      this.pendingMcpApprovals.set(request.id, { runId, request, resolve });
    });
  }

  private async linkNestedSamplingRun(parentRunId: string, request: McpApprovalRequest, nestedRunId: string): Promise<void> {
    const parent = await this.repository.getRun(parentRunId);
    if (!parent) return;
    const output = asJsonObject(parent.normalizedOutput);
    const approvals = Array.isArray(output.mcpApprovalRequests) ? output.mcpApprovalRequests : [];
    const records = approvals.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item) || item.id !== request.id) return item;
      return {
        ...item,
        resolution: { ...asJsonObject(item.resolution ?? null), nestedRunId }
      };
    });
    await this.repository.updateRun(parentRunId, { normalizedOutput: { ...output, mcpApprovalRequests: records } });
  }

  private async executeNestedSampling(parentRunId: string, request: McpApprovalRequest, payload: JsonValue): Promise<JsonValue> {
    const parsed = parseMcpSamplingRequest(payload);
    const parent = await this.repository.getRun(parentRunId);
    if (!parent) throw new Error("MCP sampling parent run no longer exists");
    const session = await this.repository.getSession(parent.sessionId);
    if (!session?.providerProfileId || !session.modelId) throw new Error("MCP sampling requires an active provider and model on the session");
    const profile = await this.repository.getProviderProfile(session.providerProfileId);
    if (!profile) throw new Error("MCP sampling active provider profile was not found");

    const draft = emptyResolvedConfig();
    draft.temperature = parsed.temperature ?? null;
    draft.maxOutputTokens = parsed.maxOutputTokens;
    draft.compileWarnings = [...parsed.warnings];
    if (parsed.systemPrompt !== undefined) {
      draft.promptBlocks = [{
        revisionId: `mcp-sampling:${request.id}`,
        name: "MCP sampling system prompt",
        content: parsed.systemPrompt,
        enabled: true,
        order: 0
      }];
    }
    const config = safeProviderSnapshot(profile, session.modelId, draft);
    const snapshot = await this.repository.createConfigSnapshot(session.id, config);
    const nested = await this.repository.createRun({
      sessionId: parent.sessionId,
      branchId: parent.branchId,
      contextNodeId: parent.resultNodeId ?? parent.contextNodeId,
      configSnapshotId: snapshot.id
    });
    await this.linkNestedSamplingRun(parentRunId, request, nested.id);
    this.events.publish(`run:${parentRunId}`, "mcp.sampling.started", { nestedRunId: nested.id, approvalId: request.id });
    this.events.publish(`run:${nested.id}`, "run.queued", { parentRunId, approvalId: request.id });

    const generation: CanonicalGenerationRequest = {
      model: session.modelId,
      messages: parsed.messages,
      ...(parsed.systemPrompt === undefined ? {} : { systemPrompt: parsed.systemPrompt }),
      ...(parsed.temperature === undefined ? {} : { temperature: parsed.temperature }),
      maxOutputTokens: parsed.maxOutputTokens,
      ...(parsed.stopSequences === undefined ? {} : { stopSequences: parsed.stopSequences }),
      stream: true
    };
    const compileWarnings: JsonValue[] = parsed.warnings.map((message) => ({ code: "mcp-sampling", message }));
    const controller = new AbortController();
    const parentSignal = this.toolControllers.get(parentRunId)?.signal;
    const abortFromParent = () => controller.abort(parentSignal?.reason ?? new DOMException("Parent run cancelled", "AbortError"));
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    this.controllers.set(nested.id, controller);
    const trace = await this.contentStore.createTraceWriter();
    const startedAt = new Date();
    let finalized = false;
    let storedTraceHash: string | null = null;
    let recordedFailure = false;
    let text = "";
    let reasoning = "";
    let usage: ProviderUsage | undefined;
    let providerFailure: ProviderFailure | undefined;
    let responseModel = session.modelId;
    let finishReason: string | undefined;
    let unsupportedToolOutput = false;
    const providerOutcome = new ProviderOutcomeTracker();
    try {
      await this.repository.updateRun(nested.id, { status: "streaming", startedAt: startedAt.toISOString() });
      this.events.publish(`run:${nested.id}`, "run.started", { parentRunId, approvalId: request.id });
      const compiled = compileProviderRequest(providerProfile(profile), generation);
      compileWarnings.push(...compiled.warnings.map((warning) => ({ code: warning.code, message: warning.message })));
      if (compileWarnings.length > 0) this.events.publish(`run:${nested.id}`, "provider.compile-warnings", compileWarnings);
      for await (const item of executeProviderRequest(providerProfile(profile), generation, { signal: controller.signal, fetch: this.fetchImpl })) {
        await trace.append({
          direction: item.trace.kind === "request" ? "request" : item.trace.kind === "error" ? "internal" : "response",
          kind: item.trace.kind === "sse" ? "sse" : item.trace.kind === "error" ? "error" : "body",
          timestamp: item.trace.occurredAt,
          data: item.trace.data
        });
        this.events.publish(`run:${nested.id}`, "provider.trace", item as unknown as JsonValue);
        for (const event of item.events) {
          providerOutcome.consume(event);
          if (event.type === "content.delta") text += event.text;
          if (event.type === "reasoning.delta") reasoning += event.text;
          if (event.type === "usage") usage = event.usage;
          if (event.type === "response.start" && event.model) responseModel = event.model;
          if (event.type === "response.fallback" && event.toModel) responseModel = event.toModel;
          if (event.type === "response.completed" && event.finishReason !== undefined) finishReason = event.finishReason;
          if (event.type === "provider.error") providerFailure = event.error;
          if (event.type === "tool_call.start" || event.type === "tool_call.delta") unsupportedToolOutput = true;
          this.events.publish(`run:${nested.id}`, event.type, event as unknown as JsonValue);
        }
      }
      const stored = await trace.finalize();
      finalized = true;
      storedTraceHash = stored.sha256;
      const finishedAt = new Date();
      const timings: JsonObject = { durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()) };
      const usageValue = usage ? this.toJson(usage) as JsonObject : null;
      const evidence: JsonObject = {
        kind: "mcp-sampling",
        parentRunId,
        approvalId: request.id,
        request: payload,
        text,
        reasoning,
        providerOutcome: providerOutcome.toJson(),
        compileWarnings,
        timings
      };
      const outcomeClassification = providerOutcome.classification();
      if (providerFailure || unsupportedToolOutput || outcomeClassification) {
        const classification = providerFailure?.classification ?? outcomeClassification ?? "parse-failure";
        const error: JsonValue = providerFailure
          ? this.toJson(providerFailure)
          : outcomeClassification
            ? { classification, message: "The provider blocked the MCP sampling generation" }
            : { classification, message: "The provider returned a tool call for a text-only MCP sampling request" };
        await this.repository.updateRun(nested.id, {
          status: classification === "cancelled" ? "cancelled" : "failed",
          classification,
          normalizedOutput: { ...evidence, error },
          usage: usageValue,
          traceHash: stored.sha256,
          finishedAt: finishedAt.toISOString()
        });
        recordedFailure = true;
        this.events.publish(`run:${nested.id}`, "run.failed", { parentRunId, classification, traceHash: stored.sha256 });
        this.events.publish(`run:${parentRunId}`, "mcp.sampling.failed", { nestedRunId: nested.id, approvalId: request.id, classification });
        throw new Error(`MCP sampling provider run ${nested.id} failed; inspect its redacted trace`);
      }
      const response: JsonObject = {
        model: responseModel,
        role: "assistant",
        content: { type: "text", text },
        stopReason: mcpStopReason(finishReason)
      };
      await this.repository.updateRun(nested.id, {
        status: "completed",
        normalizedOutput: { ...evidence, response },
        usage: usageValue,
        traceHash: stored.sha256,
        finishedAt: finishedAt.toISOString()
      });
      this.events.publish(`run:${nested.id}`, "run.completed", { parentRunId, traceHash: stored.sha256 });
      this.events.publish(`run:${parentRunId}`, "mcp.sampling.completed", { nestedRunId: nested.id, approvalId: request.id, traceHash: stored.sha256 });
      return response;
    } catch (error) {
      if (!finalized) {
        await trace.append({ direction: "internal", kind: "error", data: { message: "MCP sampling provider execution failed" } });
        const stored = await trace.finalize();
        finalized = true;
        storedTraceHash = stored.sha256;
      }
      if (!recordedFailure && storedTraceHash) {
        const finishedAt = new Date();
        const classification = controller.signal.aborted ? "cancelled" : "unknown";
        await this.repository.updateRun(nested.id, {
          status: classification === "cancelled" ? "cancelled" : "failed",
          classification,
          normalizedOutput: {
            kind: "mcp-sampling",
            parentRunId,
            approvalId: request.id,
            request: payload,
            text,
            reasoning,
            providerOutcome: providerOutcome.toJson(),
            compileWarnings,
            timings: { durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()) },
            error: { classification, message: "MCP sampling provider execution failed" }
          },
          usage: usage ? this.toJson(usage) as JsonObject : null,
          traceHash: storedTraceHash,
          finishedAt: finishedAt.toISOString()
        });
        this.events.publish(`run:${nested.id}`, "run.failed", { parentRunId, classification, traceHash: storedTraceHash });
        this.events.publish(`run:${parentRunId}`, "mcp.sampling.failed", { nestedRunId: nested.id, approvalId: request.id, classification });
      }
      if (recordedFailure) throw error;
      throw new Error(`MCP sampling provider run ${nested.id} failed; inspect its redacted trace`);
    } finally {
      this.controllers.delete(nested.id);
      parentSignal?.removeEventListener("abort", abortFromParent);
      if (!finalized) await trace.abort();
    }
  }

  private async maybeAutoContinue(pending: PendingToolRun, node: MessageNode, parts: ToolResultPart[]): Promise<void> {
    const session = await this.repository.getSession(pending.sessionId);
    if (!session?.autoContinueTools) return;
    const history = pathToRoot(await this.repository.listNodes(pending.sessionId), node.id);
    const lastUser = history.findLastIndex((item) => item.role === "user");
    const completedToolTurns = history.slice(lastUser + 1).filter((item) => item.role === "tool").length;
    const limit = Math.min(32, Math.max(1, Math.trunc(session.autoContinueLimit || 8)));
    if (completedToolTurns >= limit) {
      await this.annotateRun(pending.runId, "autoContinuation", { status: "stopped", reason: "limit", limit, completedToolTurns });
      this.events.publish(`run:${pending.runId}`, "tool.continuation.limit", { limit, completedToolTurns });
      return;
    }
    try {
      const next = await this.start({ sessionId: pending.sessionId, branchId: pending.branchId, contextNodeId: node.id });
      await this.annotateRun(pending.runId, "autoContinuation", {
        status: "started",
        nextRunId: next.id,
        turn: completedToolTurns,
        limit,
        hadToolErrors: parts.some((part) => part.isError)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.annotateRun(pending.runId, "autoContinuation", { status: "stopped", reason: "start-error", message });
      this.events.publish(`run:${pending.runId}`, "tool.continuation.failed", { message });
    }
  }

  private async canonicalContent(node: MessageNode, config: ResolvedConfig): Promise<string | CanonicalContentPart[]> {
    const parts: CanonicalContentPart[] = [];
    for (const part of node.parts) {
      if (part.type === "text") parts.push({ type: "text", text: part.text });
      if (part.type === "attachment") {
        const attachment = await this.repository.getAttachment(part.attachmentId);
        if (!attachment) continue;
        const bytes = await this.contentStore.get(attachment.sha256);
        const data = bytes.toString("base64");
        if (attachment.mediaType.startsWith("image/") && config.provider?.capabilities.images) {
          parts.push({ type: "image", mediaType: attachment.mediaType, data });
        } else if (config.provider?.capabilities.files) {
          parts.push({ type: "file", name: attachment.fileName, mediaType: attachment.mediaType, data });
        } else {
          parts.push({ type: "text", text: `[Stored attachment not supported by this model: ${attachment.fileName} (${attachment.mediaType}, sha256:${attachment.sha256})]` });
        }
      }
    }
    return parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts;
  }

  private async canonicalMessages(nodes: MessageNode[], config: ResolvedConfig): Promise<CanonicalMessage[]> {
    const messages: CanonicalMessage[] = [];
    for (const node of nodes) {
      if (node.role === "tool") {
        for (const part of node.parts) {
          if (part.type !== "tool-result") continue;
          messages.push({ role: "tool", content: JSON.stringify(part.result), toolCallId: part.callId, isError: part.isError });
        }
        continue;
      }
      const toolCalls: CanonicalToolCall[] = node.parts.filter((part): part is ToolCallPart => part.type === "tool-call").map((part) => ({
        id: part.callId, name: part.name, arguments: part.arguments
      }));
      messages.push({
        id: node.id,
        role: node.role,
        content: await this.canonicalContent(node, config),
        ...(toolCalls.length > 0 ? { toolCalls } : {})
      });
    }
    return messages;
  }

  private async perform(runId: string, profile: ProviderProfile, config: ResolvedConfig, contextNodeId: string | null): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const trace = await this.contentStore.createTraceWriter();
    let finalized = false;
    let providerFailure: ProviderFailure | undefined;
    let text = "";
    let reasoning = "";
    let usage: ProviderUsage | undefined;
    let compileWarnings: JsonValue[] = [];
    const calls = new Map<number, ToolAccumulator>();
    const providerOutcome = new ProviderOutcomeTracker();
    const run = await this.repository.getRun(runId);
    if (!run) {
      await trace.abort({ message: "Run disappeared before execution" });
      this.controllers.delete(runId);
      return;
    }

    try {
      await this.repository.updateRun(runId, { status: "streaming", startedAt: new Date().toISOString() });
      this.events.publish(`run:${runId}`, "run.started", { runId });
      const allNodes = await this.repository.listNodes(run.sessionId);
      const history = pathToRoot(allNodes, contextNodeId);
      const request: CanonicalGenerationRequest = {
        model: config.provider?.modelId ?? "",
        messages: await this.canonicalMessages(history, config),
        systemPrompt: compileSystemPrompt(config.promptBlocks),
        tools: config.tools.filter((tool) => tool.enabled).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        stream: true,
        ...(config.temperature === null ? {} : { temperature: config.temperature }),
        ...(config.maxOutputTokens === null ? {} : { maxOutputTokens: config.maxOutputTokens }),
        extraBody: config.protocolOverrides[profile.protocol] ?? {}
      };
      compileWarnings = compileProviderRequest(providerProfile(profile), request).warnings.map((warning) => ({
        code: warning.code,
        message: warning.message
      }));
      if (compileWarnings.length > 0) this.events.publish(`run:${runId}`, "provider.compile-warnings", compileWarnings);

      for await (const item of executeProviderRequest(providerProfile(profile), request, { signal: controller.signal, fetch: this.fetchImpl })) {
        await trace.append({
          direction: item.trace.kind === "request" ? "request" : item.trace.kind === "error" ? "internal" : "response",
          kind: item.trace.kind === "sse" ? "sse" : item.trace.kind === "error" ? "error" : "body",
          timestamp: item.trace.occurredAt,
          data: item.trace.data
        });
        this.events.publish(`run:${runId}`, "provider.trace", item as unknown as JsonValue);
        for (const event of item.events) {
          providerOutcome.consume(event);
          this.consumeEvent(event, calls, (delta) => { text += delta; }, (delta) => { reasoning += delta; });
          if (event.type === "usage") usage = event.usage;
          if (event.type === "provider.error") {
            providerFailure = event.error;
          }
          this.events.publish(`run:${runId}`, event.type, event as unknown as JsonValue);
        }
      }

      const stored = await trace.finalize();
      finalized = true;
      const toolParts: ToolCallPart[] = Array.from(calls.values()).map((call, index) => ({
        type: "tool-call",
        callId: call.id || `call-${runId}-${index}`,
        name: call.name || "unknown_tool",
        arguments: this.parseArguments(call.argumentsText)
      }));
      const providerOutcomeJson = providerOutcome.toJson();
      const outcomeClassification = providerOutcome.classification();
      const usageValue = usage ? JSON.parse(JSON.stringify(usage)) as JsonObject : null;
      const inertToolCallEvidence: JsonValue[] = toolParts.map((call) => ({
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
        executable: false,
        reason: providerFailure ? "provider-error" : "provider-policy-block",
      }));
      if (providerFailure) {
        let resultNode: MessageNode | null = null;
        if (text || reasoning || toolParts.length > 0 || providerFailure.classification === "content-policy") {
          resultNode = await this.repository.appendNode({
            sessionId: run.sessionId,
            branchId: run.branchId,
            parentId: contextNodeId,
            role: "assistant",
            parts: [{ type: "text", text }],
            sourceRunId: runId,
            configSnapshotId: run.configSnapshotId
          });
        }
        await this.repository.updateRun(runId, {
          ...(resultNode === null ? {} : { resultNodeId: resultNode.id }),
          status: providerFailure.classification === "cancelled" ? "cancelled" : "failed",
          classification: providerFailure.classification,
          normalizedOutput: {
            text,
            reasoning,
            toolCalls: inertToolCallEvidence,
            providerOutcome: providerOutcomeJson,
            compileWarnings,
            error: providerFailure as unknown as JsonValue,
          },
          usage: usageValue,
          traceHash: stored.sha256,
          finishedAt: new Date().toISOString()
        });
        if (resultNode) this.events.publish(`session:${run.sessionId}`, "node.created", resultNode as unknown as JsonValue);
        this.events.publish(`run:${runId}`, "run.failed", {
          classification: providerFailure.classification,
          ...(resultNode === null ? {} : { resultNodeId: resultNode.id }),
          traceHash: stored.sha256,
        });
        return;
      }
      const parts: MessagePart[] = [];
      if (text) parts.push({ type: "text", text });
      if (outcomeClassification === null) parts.push(...toolParts);
      if (parts.length === 0) parts.push({ type: "text", text: "" });
      const node = await this.repository.appendNode({
        sessionId: run.sessionId,
        branchId: run.branchId,
        parentId: contextNodeId,
        role: "assistant",
        parts,
        sourceRunId: runId,
        configSnapshotId: run.configSnapshotId
      });
      const prepared = new Map<string, PreparedToolCall>();
      const toolCallEvidence: JsonValue[] = [];
      for (const call of outcomeClassification === null ? toolParts : []) {
        const item = await this.prepareToolCall(config, call);
        prepared.set(call.callId, item);
        toolCallEvidence.push(this.preparedEvidence(item, run.sessionId, config.toolApprovalMode ?? "manual"));
      }
      if (outcomeClassification !== null) toolCallEvidence.push(...inertToolCallEvidence);
      const normalized: JsonObject = {
        text,
        reasoning,
        toolCalls: toolCallEvidence,
        providerOutcome: providerOutcomeJson,
        compileWarnings,
      };
      const awaitingTools = outcomeClassification === null && toolParts.length > 0;
      await this.repository.updateRun(runId, {
        resultNodeId: node.id,
        status: awaitingTools ? "awaiting-tool" : "completed",
        classification: outcomeClassification,
        normalizedOutput: normalized,
        usage: usageValue,
        traceHash: stored.sha256,
        finishedAt: awaitingTools ? null : new Date().toISOString()
      });
      this.events.publish(`session:${run.sessionId}`, "node.created", node as unknown as JsonValue);
      if (awaitingTools) {
        const pending: PendingToolRun = {
          runId,
          sessionId: run.sessionId,
          branchId: run.branchId,
          assistantNodeId: node.id,
          calls: toolParts,
          resolutions: new Map(),
          prepared,
          toolApprovalMode: config.toolApprovalMode ?? "manual"
        };
        this.pendingTools.set(runId, pending);
        this.events.publish(`run:${runId}`, "run.awaiting-tool", { calls: toolParts } as unknown as JsonValue);
        if (pending.toolApprovalMode === "bypass-approval") {
          void this.resolveBypassedToolCalls(pending).catch(async (error) => {
            const message = error instanceof Error ? error.message : String(error);
            await this.annotateRun(runId, "bypassApprovalError", message);
            this.events.publish(`run:${runId}`, "tool.bypass.failed", { message });
          });
        }
      } else {
        this.events.publish(`run:${runId}`, "run.completed", {
          resultNodeId: node.id,
          traceHash: stored.sha256,
          ...(outcomeClassification === null ? {} : { classification: outcomeClassification }),
          providerOutcome: providerOutcomeJson,
        });
      }
    } catch (error) {
      if (!finalized) {
        await trace.append({ direction: "internal", kind: "error", data: { message: error instanceof Error ? error.message : String(error) } });
        const stored = await trace.finalize();
        finalized = true;
        await this.repository.updateRun(runId, { traceHash: stored.sha256 });
      }
      await this.repository.updateRun(runId, {
        status: controller.signal.aborted ? "cancelled" : "failed",
        classification: controller.signal.aborted ? "cancelled" : providerOutcome.classification() ?? "unknown",
        normalizedOutput: { text, reasoning, providerOutcome: providerOutcome.toJson(), compileWarnings, error: error instanceof Error ? error.message : String(error) },
        finishedAt: new Date().toISOString()
      });
      this.events.publish(`run:${runId}`, "run.failed", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.controllers.delete(runId);
      if (!finalized) await trace.abort();
    }
  }

  private consumeEvent(
    event: NormalizedProviderEvent,
    calls: Map<number, ToolAccumulator>,
    addText: (delta: string) => void,
    addReasoning: (delta: string) => void
  ): void {
    if (event.type === "content.delta") addText(event.text);
    if (event.type === "reasoning.delta") addReasoning(event.text);
    if (event.type === "tool_call.start") {
      calls.set(event.index, { id: event.id ?? "", name: event.name ?? "", argumentsText: "" });
    }
    if (event.type === "tool_call.delta") {
      const call = calls.get(event.index) ?? { id: "", name: "", argumentsText: "" };
      if (event.id) call.id = event.id;
      if (event.name) call.name = event.name;
      call.argumentsText += event.argumentsDelta;
      calls.set(event.index, call);
    }
  }

  private parseArguments(value: string): JsonValue {
    if (!value) return {};
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return value;
    }
  }

  private async resolveBypassedToolCalls(pending: PendingToolRun): Promise<void> {
    for (const call of pending.calls) {
      if (pending.resolutions.has(call.callId)) continue;
      const prepared = pending.prepared.get(call.callId);
      if (prepared?.mode !== "real" && prepared?.mode !== "mcp") continue;
      this.events.publish(`run:${pending.runId}`, "tool.bypass.started", {
        callId: call.callId,
        mode: prepared.mode
      });
      await this.resolveToolCall(pending.runId, call.callId, {});
    }
  }

  private async prepareToolCall(config: ResolvedConfig, call: ToolCallPart): Promise<PreparedToolCall> {
    const binding = config.tools.find((tool) => tool.enabled && tool.name === call.name);
    if (!binding) return {
      call,
      mode: "manual",
      toolRevisionHash: hashRevisionParts([call.name]),
      targetId: "manual",
      targetRevisionId: "builtin:manual:v1",
      targetRevisionHash: hashRevisionParts(["builtin:manual:v1"])
    };
    const assets = await this.repository.listAssetRevisions();
    const spec = assets.find((asset) => asset.id === binding.toolRevisionId);
    const implementation = binding.implementationRevisionId
      ? assets.find((asset) => asset.id === binding.implementationRevisionId)
      : undefined;
    const toolRevisionHash = hashRevisionParts([spec?.contentHash ?? binding.toolRevisionId, implementation?.contentHash ?? ""]);
    if (binding.mode === "mock") {
      const value = implementation?.value;
      const mockResult = value && typeof value === "object" && !Array.isArray(value) && "result" in value ? value.result : value ?? null;
      return {
        call,
        mode: "mock",
        toolRevisionHash,
        targetId: "mock",
        targetRevisionId: "builtin:mock:v1",
        targetRevisionHash: hashRevisionParts(["builtin:mock:v1"]),
        mockResult
      };
    }
    if (binding.mode === "real") {
      if (!implementation || implementation.kind !== "tool-implementation") throw new Error(`Real tool ${call.name} has no implementation revision`);
      if (!implementation.trusted) throw new Error(`Tool implementation ${implementation.name} is disabled until trusted`);
      const value = implementation.value;
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.source !== "string") throw new Error(`Tool implementation ${implementation.name} has no JavaScript source`);
      const resolvedTarget = await this.resolveExecutionTarget(binding.targetId, assets);
      const request = await this.evaluator.build(value.source, {
        arguments: call.arguments,
        call: { id: call.callId, name: call.name }
      });
      return {
        call,
        mode: "real",
        toolRevisionHash,
        targetId: resolvedTarget.target.id,
        targetRevisionId: resolvedTarget.revisionId,
        targetRevisionHash: resolvedTarget.revisionHash,
        source: value.source,
        request,
        target: resolvedTarget.target
      };
    }
    if (binding.mode === "mcp") {
      const mcpAsset = binding.mcpServerId ? assets.find((asset) => asset.id === binding.mcpServerId && asset.kind === "mcp-server") : undefined;
      if (!mcpAsset || !mcpAsset.value || typeof mcpAsset.value !== "object" || Array.isArray(mcpAsset.value)) throw new Error(`MCP tool ${call.name} has no server revision`);
      if (!mcpAsset.trusted) throw new Error(`MCP server revision ${mcpAsset.name} is disabled until trusted`);
      const mcpProfile = mcpAsset.value as unknown as McpServerProfile;
      const executionTargetId = mcpProfile.transport.kind === "stdio" ? mcpProfile.transport.executionTargetId : undefined;
      const resolvedTarget = mcpProfile.transport.kind === "stdio"
        ? await this.resolveExecutionTarget(executionTargetId ?? null, assets)
        : undefined;
      return {
        call,
        mode: "mcp",
        toolRevisionHash: hashRevisionParts([toolRevisionHash, mcpAsset.contentHash]),
        targetId: resolvedTarget?.target.id ?? mcpProfile.id,
        targetRevisionId: resolvedTarget?.revisionId ?? mcpAsset.id,
        targetRevisionHash: resolvedTarget?.revisionHash ?? mcpAsset.contentHash,
        mcpProfile,
        mcpServerRevisionId: mcpAsset.id,
        mcpServerRevisionHash: mcpAsset.contentHash,
        ...(resolvedTarget ? { mcpExecutionTarget: resolvedTarget.target } : {})
      };
    }
    return {
      call,
      mode: "manual",
      toolRevisionHash,
      targetId: "manual",
      targetRevisionId: "builtin:manual:v1",
      targetRevisionHash: hashRevisionParts(["builtin:manual:v1"])
    };
  }

  private preparedEvidence(prepared: PreparedToolCall, sessionId: string, toolApprovalMode: ToolApprovalMode): JsonValue {
    const base: JsonObject = {
      ...prepared.call,
      mode: prepared.mode,
      toolApprovalMode,
      toolRevisionHash: prepared.toolRevisionHash,
      targetId: prepared.targetId,
      targetRevisionId: prepared.targetRevisionId,
      targetRevisionHash: prepared.targetRevisionHash
    };
    if (prepared.mode === "mock") base.mockResult = prepared.mockResult ?? null;
    if (prepared.mode === "real" && prepared.request && prepared.source && prepared.target) {
      const approval: ToolCallApproval = {
        sessionId,
        callId: prepared.call.callId,
        toolName: prepared.call.name,
        toolRevisionHash: prepared.toolRevisionHash,
        targetId: prepared.targetId,
        targetRevisionId: prepared.targetRevisionId,
        targetRevisionHash: prepared.targetRevisionHash,
        target: prepared.target,
        originalArguments: prepared.call.arguments,
        originalRequest: prepared.request
      };
      base.approval = JSON.parse(JSON.stringify(createApprovalView(approval))) as JsonValue;
      base.handlerSource = prepared.source;
    }
    if (prepared.mode === "mcp" && prepared.mcpProfile) {
      base.approval = this.toJson({
        sessionId,
        callId: prepared.call.callId,
        toolName: prepared.call.name,
        toolRevisionHash: prepared.toolRevisionHash,
        targetId: prepared.targetId,
        targetRevisionId: prepared.targetRevisionId,
        targetRevisionHash: prepared.targetRevisionHash,
        originalArguments: prepared.call.arguments,
        effectiveArguments: prepared.call.arguments,
        edited: false,
        mcpServer: mcpServerForApproval(prepared),
        target: prepared.mcpExecutionTarget
          ? executionTargetForApproval(prepared.mcpExecutionTarget)
          : null
      });
    }
    return base;
  }

  private async resolveExecutionTarget(targetRevisionId: string | null, assets: Awaited<ReturnType<LatheRepository["listAssetRevisions"]>>): Promise<ResolvedExecutionTargetRevision> {
    if (!targetRevisionId) {
      const target: ExecutionTarget = { id: "host", label: "Local host", kind: "host", inheritEnvironment: false };
      return {
        target,
        revisionId: "builtin:host:v1",
        revisionHash: hashRevisionParts(["builtin:host:v1", JSON.stringify(target)])
      };
    }
    const asset = assets.find((item) => item.id === targetRevisionId && item.kind === "target");
    if (!asset || !asset.value || typeof asset.value !== "object" || Array.isArray(asset.value)) throw new Error("Execution target revision not found");
    if (!asset.trusted) throw new Error(`Execution target revision ${asset.name} is disabled until trusted`);
    return {
      target: asset.value as unknown as ExecutionTarget,
      revisionId: asset.id,
      revisionHash: asset.contentHash
    };
  }

  private async executeRealTool(pending: PendingToolRun, prepared: PreparedToolCall, resolution: JsonObject): Promise<JsonValue> {
    if (!prepared.request || !prepared.source || !prepared.target) throw new Error("Real tool was not prepared");
    const overrideArguments = resolution.overrideArguments;
    const effectiveRequest = overrideArguments === undefined
      ? prepared.request
      : await this.evaluator.build(prepared.source, {
          arguments: overrideArguments,
          call: { id: prepared.call.callId, name: prepared.call.name }
        });
    const approval: ToolCallApproval = {
      sessionId: pending.sessionId,
      callId: prepared.call.callId,
      toolName: prepared.call.name,
      toolRevisionHash: prepared.toolRevisionHash,
      targetId: prepared.targetId,
      targetRevisionId: prepared.targetRevisionId,
      targetRevisionHash: prepared.targetRevisionHash,
      target: prepared.target,
      originalArguments: prepared.call.arguments,
      originalRequest: prepared.request,
      ...(overrideArguments === undefined ? {} : {
        overrideArguments,
        overrideRequest: effectiveRequest
      })
    };
    const bypassApproval = pending.toolApprovalMode === "bypass-approval";
    const trusted = !requiresApproval(approval, this.trust);
    const decisionValue = typeof resolution.decision === "string" ? resolution.decision : undefined;
    if (!bypassApproval && !trusted && !["approve-once", "approve-session", "reject"].includes(decisionValue ?? "")) {
      throw new ApprovalRequiredError("Real tool execution requires approve-once, approve-session, or reject");
    }
    const decision = decisionValue === "reject"
      ? { kind: "reject" as const, reason: typeof resolution.reason === "string" ? resolution.reason : "Rejected by operator" }
      : bypassApproval || trusted
        ? { kind: "approve-once" as const }
        : decisionValue === "approve-session"
        ? { kind: "approve-session" as const }
        : { kind: "approve-once" as const };
    const resolved = resolveApproval(approval, decision, this.trust);
    prepared.approvalEvidence = this.toJson({
      ...createApprovalView(approval),
      decision: decision.kind === "reject" ? "reject" : bypassApproval ? "bypass-approval" : decision.kind,
      trustedForSession: resolved.approved ? resolved.trustedForSession : false
    });
    if (!resolved.approved) throw new Error(resolved.reason ?? "Tool call rejected");
    const writer = await this.contentStore.createTraceWriter();
    const events: JsonValue[] = [];
    let eventsWritten = false;
    try {
      const approvalView = this.toJson(createApprovalView(approval));
      await writer.append({ direction: "internal", kind: "log", data: { event: "approval", value: approvalView } });
      this.events.publish(`run:${pending.runId}`, "tool.execution.started", this.toJson({ callId: prepared.call.callId, targetId: prepared.targetId, approval: approvalView }));
      const toolSignal = this.toolControllers.get(pending.runId)?.signal;
      const execution = await this.executionTargets.execute(prepared.target, resolved.effectiveRequest, {
        ...(toolSignal ? { signal: toolSignal } : {}),
        onEvent: (event) => {
          const value = this.toJson(event);
          events.push(value);
          this.events.publish(`run:${pending.runId}`, `tool.execution.${event.type}`, value);
        }
      });
      for (const event of events) await writer.append({ direction: "internal", kind: "log", data: event });
      eventsWritten = true;
      const raw = await this.contentStore.put(new TextEncoder().encode(JSON.stringify(execution)));
      prepared.rawResultHash = raw.sha256;
      prepared.executionFailed = execution.status !== "completed" || execution.exitCode !== 0;
      await writer.append({ direction: "internal", kind: "body", data: this.toJson({ rawResultHash: raw.sha256, execution: serializableExecutionResult(execution) }) });
      const result = await this.evaluator.formatResult(prepared.source, serializableExecutionResult(execution) as unknown as JsonValue);
      const stored = await writer.finalize();
      prepared.traceHash = stored.sha256;
      this.events.publish(`run:${pending.runId}`, "tool.execution.completed", this.toJson({ callId: prepared.call.callId, rawResultHash: raw.sha256, traceHash: stored.sha256, execution }));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!eventsWritten) for (const event of events) await writer.append({ direction: "internal", kind: "log", data: event });
      await writer.append({ direction: "internal", kind: "error", data: { message } });
      const stored = await writer.finalize();
      prepared.traceHash = stored.sha256;
      throw new ToolEvidenceError(message, { error: message, traceHash: stored.sha256, rawResultHash: prepared.rawResultHash ?? null });
    }
  }

  private async executeMcpTool(pending: PendingToolRun, prepared: PreparedToolCall, resolution: JsonObject): Promise<JsonValue> {
    if (!prepared.mcpProfile) throw new Error("MCP server was not prepared");
    const decision = typeof resolution.decision === "string" ? resolution.decision : "";
    const binding = {
      sessionId: pending.sessionId,
      toolRevisionHash: prepared.toolRevisionHash,
      targetRevisionId: prepared.targetRevisionId,
      targetRevisionHash: prepared.targetRevisionHash
    };
    const bypassApproval = pending.toolApprovalMode === "bypass-approval";
    const trusted = this.trust.isTrusted(binding);
    const effectiveArguments = resolution.overrideArguments ?? prepared.call.arguments;
    prepared.approvalEvidence = this.toJson({
      sessionId: pending.sessionId,
      callId: prepared.call.callId,
      toolName: prepared.call.name,
      toolRevisionHash: prepared.toolRevisionHash,
      targetId: prepared.targetId,
      targetRevisionId: prepared.targetRevisionId,
      targetRevisionHash: prepared.targetRevisionHash,
      originalArguments: prepared.call.arguments,
      effectiveArguments,
      edited: resolution.overrideArguments !== undefined,
      decision: decision === "reject" ? "reject" : bypassApproval ? "bypass-approval" : trusted ? "session-trust" : decision,
      mcpServer: mcpServerForApproval(prepared),
      target: prepared.mcpExecutionTarget
        ? executionTargetForApproval(prepared.mcpExecutionTarget)
        : null
    });
    if (decision === "reject") {
      throw new Error(typeof resolution.reason === "string" ? resolution.reason : "MCP tool call rejected by operator");
    }
    if (!bypassApproval && !trusted && !["approve-once", "approve-session"].includes(decision)) throw new ApprovalRequiredError("MCP tool call requires explicit approval");
    if (!bypassApproval && decision === "approve-session") this.trust.grant(binding);
    const writer = await this.contentStore.createTraceWriter();
    const approvedSampling: ApprovedMcpSampling[] = [];
    const elicitationResponses: JsonValue[] = [];
    const approvals: McpApprovalBroker = {
      requestApproval: async (request) => {
        if (request.kind === "toolCall") {
          return { outcome: "approved", ...(resolution.overrideArguments === undefined ? {} : { editedPayload: { name: prepared.call.name, arguments: resolution.overrideArguments } }) };
        }
        const operator = await this.awaitMcpApproval(pending.runId, request);
        if (operator.decision.outcome === "approved" && request.kind === "sampling") {
          approvedSampling.push({ request, payload: operator.decision.editedPayload ?? request.payload });
        }
        if (operator.decision.outcome === "approved" && request.kind === "elicitation" && operator.response !== undefined) {
          elicitationResponses.push(operator.response);
        }
        return operator.decision;
      }
    };
    let client: LatheMcpClient | undefined;
    try {
      client = await LatheMcpClient.connect({
        profile: prepared.mcpProfile,
        resolveSecret: (id) => this.repository.resolveSecret(id),
        approvals,
        policy: { ...DEFAULT_MCP_POLICY, roots: explicitMcpRoots(resolution.roots, prepared.mcpProfile.roots ?? []) },
        handlers: {
          sampling: async () => {
            const approved = approvedSampling.shift();
            if (!approved) throw new Error("Approved MCP sampling request has no active provider invocation context");
            return this.executeNestedSampling(pending.runId, approved.request, approved.payload);
          },
          elicitation: async () => {
            const response = elicitationResponses.shift();
            if (response === undefined) throw new Error("Approved MCP elicitation request has no operator response");
            return response;
          },
          onProgress: (value) => { this.events.publish(`run:${pending.runId}`, "mcp.progress", value); },
          onLoggingMessage: (value) => { this.events.publish(`run:${pending.runId}`, "mcp.log", value); }
        },
        ...(prepared.mcpExecutionTarget ? {
          spawnStdio: (request) => this.executionTargets.spawnDuplex(prepared.mcpExecutionTarget!, {
            program: request.command,
            args: request.args,
            ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
            environment: request.env
          })
        } : {}),
        trace: {
          record: async (event: McpTraceEvent) => {
            await writer.append({
              direction: event.direction === "outbound" ? "request" : event.direction === "inbound" ? "response" : "internal",
              kind: event.level === "error" ? "error" : "log",
              timestamp: event.at,
              data: this.toJson(event)
            });
          }
        }
      });
      const result = await client.callTool({
        sessionId: pending.sessionId,
        toolRevisionHash: prepared.toolRevisionHash,
        name: prepared.call.name,
        arguments: prepared.call.arguments
      });
      const stored = await writer.finalize();
      prepared.traceHash = stored.sha256;
      this.events.publish(`run:${pending.runId}`, "mcp.tool.completed", { callId: prepared.call.callId, traceHash: stored.sha256 });
      return result;
    } catch (error) {
      const message = "MCP tool operation failed; inspect the redacted trace";
      await writer.append({ direction: "internal", kind: "error", data: { message } });
      const stored = await writer.finalize();
      prepared.traceHash = stored.sha256;
      this.events.publish(`run:${pending.runId}`, "mcp.tool.failed", {
        callId: prepared.call.callId,
        traceHash: stored.sha256,
        message
      });
      throw new ToolEvidenceError(message, { error: message, traceHash: stored.sha256 });
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  private toJson(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  }
}
