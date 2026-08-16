import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  CallToolResultSchema,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { captureCapabilitySnapshot } from "./capabilities.js";
import { resolveMcpTransport } from "./profile.js";
import { redactJson } from "./redaction.js";
import { TracingTransport } from "./tracing-transport.js";
import { DuplexStdioClientTransport, type McpStdioSpawner } from "./duplex-stdio-transport.js";
import type {
  JsonValue,
  McpApprovalBroker,
  McpApprovalDecision,
  McpApprovalRequest,
  McpCapabilitySnapshot,
  McpPolicy,
  McpServerProfile,
  McpTraceEvent,
  McpTraceSink,
  ResolvedMcpTransport,
  SecretResolver,
} from "./types.js";
import { DEFAULT_MCP_POLICY } from "./types.js";

type SamplingHandler = (params: JsonValue) => Promise<JsonValue>;
type ElicitationHandler = (params: JsonValue) => Promise<JsonValue>;

export interface McpInboundHandlers {
  sampling?: SamplingHandler;
  elicitation?: ElicitationHandler;
  onLoggingMessage?: (params: JsonValue) => void | Promise<void>;
  onProgress?: (params: JsonValue) => void | Promise<void>;
}

export interface ConnectMcpClientOptions {
  profile: McpServerProfile;
  resolveSecret: SecretResolver;
  approvals: McpApprovalBroker;
  policy?: McpPolicy;
  handlers?: McpInboundHandlers;
  trace?: McpTraceSink;
  clientInfo?: { name: string; version: string };
  /** Required when a stdio profile selects a container or SSH target. */
  spawnStdio?: McpStdioSpawner;
  /** Heuristic evidence redaction. Resolved secret values are always removed. */
  redactionEnabled?: boolean;
}

export interface CallMcpToolOptions {
  sessionId?: string;
  toolRevisionHash: string;
  name: string;
  arguments?: JsonValue;
}

export interface CallMcpToolTaskOptions extends CallMcpToolOptions {
  /** How long the server may retain task state. */
  ttlMs?: number;
  /** Requested interval for task status polling. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

function clonePolicy(input: McpPolicy | undefined): McpPolicy {
  const policy = input ?? DEFAULT_MCP_POLICY;
  return { ...policy, roots: policy.roots.map((root) => ({ ...root })) };
}

function policyFor(options: Pick<ConnectMcpClientOptions, "policy" | "profile">): McpPolicy {
  if (options.policy) return clonePolicy(options.policy);
  return clonePolicy({ ...DEFAULT_MCP_POLICY, roots: options.profile.roots?.map((root) => ({ ...root })) ?? [] });
}

function assertPolicy(policy: McpPolicy): void {
  if (
    policy.samplingApproval !== "always" ||
    policy.elicitationApproval !== "always" ||
    policy.promptImport !== "explicit" ||
    policy.resourceImport !== "explicit"
  ) {
    throw new Error("MCP policy cannot disable sampling, elicitation, or content-import gates");
  }
  for (const root of policy.roots) {
    const uri = new URL(root.uri);
    if (uri.protocol !== "file:") throw new Error("MCP roots must use file: URIs");
  }
}

function asApprovedPayload(
  decision: McpApprovalDecision,
  original: JsonValue,
): JsonValue {
  if (decision.outcome !== "approved") {
    throw new McpError(
      ErrorCode.InvalidRequest,
      decision.reason ?? `Operator ${decision.outcome} the MCP request`,
    );
  }
  return decision.editedPayload ?? original;
}

function redactFor(
  options: Pick<ConnectMcpClientOptions, "redactionEnabled">,
  resolved: ResolvedMcpTransport,
  value: unknown,
): JsonValue {
  return redactJson(value, resolved.secretValues, options.redactionEnabled !== false);
}

export class LatheMcpClient {
  readonly profile: McpServerProfile;
  readonly policy: McpPolicy;

  readonly #client: Client;
  readonly #transport: Transport;
  readonly #resolved: ResolvedMcpTransport;
  readonly #approvals: McpApprovalBroker;
  readonly #trace?: McpTraceSink;
  readonly #redactionEnabled: boolean;

  private constructor(
    options: ConnectMcpClientOptions,
    client: Client,
    transport: Transport,
    resolved: ResolvedMcpTransport,
  ) {
    this.profile = structuredClone(options.profile);
    this.policy = policyFor(options);
    this.#client = client;
    this.#transport = transport;
    this.#resolved = resolved;
    this.#approvals = options.approvals;
    this.#redactionEnabled = options.redactionEnabled !== false;
    if (options.trace !== undefined) this.#trace = options.trace;
  }

  static async connect(options: ConnectMcpClientOptions): Promise<LatheMcpClient> {
    const policy = policyFor(options);
    assertPolicy(policy);
    const resolved = await resolveMcpTransport(options.profile, options.resolveSecret);
    await record(options, resolved, {
      direction: "internal",
      level: "info",
      event: "connect.start",
    });

    const handlers = options.handlers ?? {};
    const capabilities = {
      roots: { listChanged: false },
      ...(handlers.sampling ? { sampling: {} } : {}),
      ...(handlers.elicitation ? { elicitation: {} } : {}),
    };
    const client = new Client(options.clientInfo ?? { name: "lathe", version: "0.0.0" }, {
      capabilities,
    });

    installInboundHandlers(client, options, resolved, policy);
    const officialTransport = makeOfficialTransport(resolved, options.spawnStdio);
    attachStderrTrace(officialTransport, options, resolved);
    const transport = new TracingTransport(officialTransport, {
      profile: options.profile,
      secrets: resolved.secretValues,
      redactionEnabled: options.redactionEnabled !== false,
      ...(options.trace === undefined ? {} : { sink: options.trace }),
    });

    try {
      await client.connect(transport);
      await record(options, resolved, {
        direction: "internal",
        level: "info",
        event: "connect.ready",
        payload: {
          server: redactFor(options, resolved, client.getServerVersion()),
          capabilities: redactFor(options, resolved, client.getServerCapabilities()),
        },
      });
      return new LatheMcpClient(options, client, transport, resolved);
    } catch (error) {
      await record(options, resolved, {
        direction: "internal",
        level: "error",
        event: "connect.error",
        payload: errorPayload(error),
      });
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#client.close();
  }

  #redact(value: unknown): JsonValue {
    return redactJson(value, this.#resolved.secretValues, this.#redactionEnabled);
  }

  async captureCapabilities(): Promise<McpCapabilitySnapshot> {
    const protocolVersion = (this.#transport as TracingTransport).protocolVersion;
    return this.#operation("capabilities/snapshot", {}, async () =>
      captureCapabilitySnapshot(this.#client, {
        profileId: this.profile.id,
        profileRevision: this.profile.revision,
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
        secretValues: this.#resolved.secretValues,
        redactionEnabled: this.#redactionEnabled,
      }),
    );
  }

  async listTools(cursor?: string): Promise<JsonValue> {
    return this.#operation("tools/list", { cursor: cursor ?? null }, async () =>
      this.#redact(await this.#client.listTools(cursor ? { cursor } : undefined)),
    );
  }

  async listPrompts(cursor?: string): Promise<JsonValue> {
    return this.#operation("prompts/list", { cursor: cursor ?? null }, async () =>
      this.#redact(await this.#client.listPrompts(cursor ? { cursor } : undefined)),
    );
  }

  async listResources(cursor?: string): Promise<JsonValue> {
    return this.#operation("resources/list", { cursor: cursor ?? null }, async () =>
      this.#redact(await this.#client.listResources(cursor ? { cursor } : undefined)),
    );
  }

  async listResourceTemplates(cursor?: string): Promise<JsonValue> {
    return this.#operation("resources/templates/list", { cursor: cursor ?? null }, async () =>
      this.#redact(await this.#client.listResourceTemplates(cursor ? { cursor } : undefined)),
    );
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<JsonValue> {
    return this.#operation("prompts/get", { name, arguments: args ?? {} }, async () =>
      this.#redact(await this.#client.getPrompt({ name, arguments: args })),
    );
  }

  async readResource(uri: string): Promise<JsonValue> {
    return this.#operation("resources/read", { uri }, async () =>
      this.#redact(await this.#client.readResource({ uri })),
    );
  }

  async callTool(options: CallMcpToolOptions): Promise<JsonValue> {
    const original = { name: options.name, arguments: options.arguments ?? {} } satisfies JsonValue;
    const approvalPayload = this.#redact(original);
    const approval = await this.#approve({
      id: randomUUID(),
      kind: "toolCall",
      profileId: this.profile.id,
      profileRevision: this.profile.revision,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      createdAt: new Date().toISOString(),
      payload: approvalPayload,
      toolName: options.name,
      toolRevisionHash: options.toolRevisionHash,
    });
    const approved = asApprovedPayload(approval, original);
    if (approved === null || Array.isArray(approved) || typeof approved !== "object") {
      throw new Error("Approved MCP tool payload must be an object");
    }
    const approvedName = approved.name;
    const approvedArguments = approved.arguments;
    if (typeof approvedName !== "string") throw new Error("Approved MCP tool payload needs a name");

    return this.#operation("tools/call", approved, async () =>
      this.#redact(
        await this.#client.callTool({
          name: approvedName,
          arguments:
            approvedArguments !== null &&
            typeof approvedArguments === "object" &&
            !Array.isArray(approvedArguments)
              ? approvedArguments
              : {},
        }),
      ),
    );
  }

  /**
   * Execute a tool through MCP's negotiated task protocol. Every yielded task-state or
   * terminal message is redacted and traced. The tool invocation still passes through
   * the same explicit operator approval gate as a synchronous tool call.
   */
  async *callToolTask(options: CallMcpToolTaskOptions): AsyncGenerator<JsonValue> {
    const original = { name: options.name, arguments: options.arguments ?? {} } satisfies JsonValue;
    const approvalPayload = this.#redact(original);
    const approval = await this.#approve({
      id: randomUUID(),
      kind: "toolCall",
      profileId: this.profile.id,
      profileRevision: this.profile.revision,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      createdAt: new Date().toISOString(),
      payload: approvalPayload,
      toolName: options.name,
      toolRevisionHash: options.toolRevisionHash,
    });
    const approved = asApprovedPayload(approval, original);
    if (approved === null || Array.isArray(approved) || typeof approved !== "object") {
      throw new Error("Approved MCP task payload must be an object");
    }
    const approvedName = approved.name;
    const approvedArguments = approved.arguments;
    if (typeof approvedName !== "string") throw new Error("Approved MCP task payload needs a name");

    const request = {
      name: approvedName,
      arguments:
        approvedArguments !== null && typeof approvedArguments === "object" && !Array.isArray(approvedArguments)
          ? approvedArguments
          : {},
    };
    await this.#record("outbound", "debug", "operation.start", "tasks/tools/call", request);
    try {
      const stream = this.#client.experimental.tasks.callToolStream(request, CallToolResultSchema, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        task: {
          ...(options.ttlMs === undefined ? {} : { ttl: options.ttlMs }),
          ...(options.pollIntervalMs === undefined ? {} : { pollInterval: options.pollIntervalMs }),
        },
      });
      for await (const message of stream) {
        const safe = this.#redact(message);
        await this.#record("inbound", message.type === "error" ? "error" : "info", message.type === "error" ? "operation.error" : "operation.result", "tasks/tools/call", safe);
        yield safe;
      }
    } catch (error) {
      await this.#record("inbound", "error", "operation.error", "tasks/tools/call", errorPayload(error));
      throw error;
    }
  }

  async listTasks(cursor?: string): Promise<JsonValue> {
    return this.#operation("tasks/list", { cursor: cursor ?? null }, async () =>
      this.#redact(await this.#client.experimental.tasks.listTasks(cursor)),
    );
  }

  async getTask(taskId: string): Promise<JsonValue> {
    return this.#operation("tasks/get", { taskId }, async () =>
      this.#redact(await this.#client.experimental.tasks.getTask(taskId)),
    );
  }

  async getToolTaskResult(taskId: string): Promise<JsonValue> {
    return this.#operation("tasks/result", { taskId }, async () =>
      this.#redact(await this.#client.experimental.tasks.getTaskResult(taskId, CallToolResultSchema)),
    );
  }

  async cancelTask(taskId: string): Promise<JsonValue> {
    return this.#operation("tasks/cancel", { taskId }, async () =>
      this.#redact(await this.#client.experimental.tasks.cancelTask(taskId)),
    );
  }

  async #approve(request: McpApprovalRequest): Promise<McpApprovalDecision> {
    await this.#record("outbound", "info", "approval.requested", request.kind, request.payload);
    const decision = await this.#approvals.requestApproval(request);
    await this.#record(
      "inbound",
      "info",
      "approval.resolved",
      request.kind,
      this.#redact(decision),
    );
    return decision;
  }

  async #operation<T>(method: string, payload: unknown, run: () => Promise<T>): Promise<T> {
    await this.#record("outbound", "debug", "operation.start", method, payload);
    try {
      const result = await run();
      await this.#record("inbound", "debug", "operation.result", method, result);
      return result;
    } catch (error) {
      await this.#record("inbound", "error", "operation.error", method, errorPayload(error));
      throw error;
    }
  }

  async #record(
    direction: McpTraceEvent["direction"],
    level: McpTraceEvent["level"],
    event: McpTraceEvent["event"],
    method?: string,
    payload?: unknown,
  ): Promise<void> {
    if (!this.#trace) return;
    try {
      await this.#trace.record({
        at: new Date().toISOString(),
        profileId: this.profile.id,
        profileRevision: this.profile.revision,
        transport: this.profile.transport.kind,
        direction,
        level,
        event,
        ...(method === undefined ? {} : { method }),
        ...(payload === undefined
          ? {}
          : { payload: this.#redact(payload) }),
      });
    } catch {
      // Tracing is observational and may not alter protocol behavior.
    }
  }
}

function makeOfficialTransport(resolved: ResolvedMcpTransport, spawnStdio?: McpStdioSpawner): Transport {
  if (resolved.kind === "stdio") {
    if (resolved.executionTargetId !== undefined) {
      if (!spawnStdio) throw new Error(`MCP stdio target '${resolved.executionTargetId}' requires an execution-target spawner`);
      return new DuplexStdioClientTransport(resolved, spawnStdio) as unknown as Transport;
    }
    return new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      ...(resolved.cwd === undefined ? {} : { cwd: resolved.cwd }),
      env: resolved.env,
      stderr: "pipe",
    }) as unknown as Transport;
  }
  return new StreamableHTTPClientTransport(resolved.url, {
    requestInit: { headers: resolved.headers },
  }) as unknown as Transport;
}

function installInboundHandlers(
  client: Client,
  options: ConnectMcpClientOptions,
  resolved: ResolvedMcpTransport,
  policy: McpPolicy,
): void {
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: policy.roots.map((root) => ({ ...root })),
  }));

  if (options.handlers?.sampling) {
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      const original = request.params as JsonValue;
      const approvalPayload = redactFor(options, resolved, original);
      const decision = await requestInboundApproval(options, resolved, "sampling", approvalPayload);
      const approved = asApprovedPayload(decision, original);
      return (await options.handlers?.sampling?.(approved)) as never;
    });
  }

  if (options.handlers?.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const original = request.params as JsonValue;
      const approvalPayload = redactFor(options, resolved, original);
      const decision = await requestInboundApproval(options, resolved, "elicitation", approvalPayload);
      const approved = asApprovedPayload(decision, original);
      return (await options.handlers?.elicitation?.(approved)) as never;
    });
  }

  if (options.handlers?.onLoggingMessage) {
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
      const payload = redactFor(options, resolved, notification.params);
      await record(options, resolved, {
        direction: "inbound",
        level: "info",
        event: "operation.result",
        method: "notifications/message",
        payload,
      });
      await options.handlers?.onLoggingMessage?.(payload);
    });
  }

  if (options.handlers?.onProgress) {
    client.setNotificationHandler(ProgressNotificationSchema, async (notification) => {
      const payload = redactFor(options, resolved, notification.params);
      await record(options, resolved, {
        direction: "inbound",
        level: "debug",
        event: "operation.result",
        method: "notifications/progress",
        payload,
      });
      await options.handlers?.onProgress?.(payload);
    });
  }
}

async function requestInboundApproval(
  options: ConnectMcpClientOptions,
  resolved: ResolvedMcpTransport,
  kind: "sampling" | "elicitation",
  payload: JsonValue,
): Promise<McpApprovalDecision> {
  const request: McpApprovalRequest = {
    id: randomUUID(),
    kind,
    profileId: options.profile.id,
    profileRevision: options.profile.revision,
    createdAt: new Date().toISOString(),
    payload,
  };
  await record(options, resolved, {
    direction: "outbound",
    level: "info",
    event: "approval.requested",
    method: kind,
    payload,
  });
  const decision = await options.approvals.requestApproval(request);
  await record(options, resolved, {
    direction: "inbound",
    level: "info",
    event: "approval.resolved",
    method: kind,
    payload: redactFor(options, resolved, decision),
  });
  return decision;
}

function attachStderrTrace(
  transport: Transport,
  options: ConnectMcpClientOptions,
  resolved: ResolvedMcpTransport,
): void {
  if (resolved.kind !== "stdio") return;
  const stderr = (transport as unknown as {
    stderr?: { on(event: "data", listener: (chunk: Uint8Array | string) => void): void };
  }).stderr;
  stderr?.on("data", (chunk) => {
    void record(options, resolved, {
      direction: "inbound",
      level: "warning",
      event: "stdio.stderr",
      payload: redactFor(
        options,
        resolved,
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      ),
    });
  });
}

async function record(
  options: Pick<ConnectMcpClientOptions, "profile" | "trace" | "redactionEnabled">,
  resolved: ResolvedMcpTransport,
  event: Omit<McpTraceEvent, "at" | "profileId" | "profileRevision" | "transport">,
): Promise<void> {
  if (!options.trace) return;
  try {
    await options.trace.record({
      at: new Date().toISOString(),
      profileId: options.profile.id,
      profileRevision: options.profile.revision,
      transport: options.profile.transport.kind,
      ...event,
      ...(event.payload === undefined
        ? {}
        : { payload: redactFor(options, resolved, event.payload) }),
    });
  } catch {
    // Trace persistence failure must not mutate MCP behavior.
  }
}

function errorPayload(error: unknown): JsonValue {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };
}
