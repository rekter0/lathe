import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { DEFAULT_MCP_POLICY, LatheMcpClient, type McpApprovalBroker, type McpRoot, type McpServerProfile, type McpTraceEvent } from "@lathe/mcp";
import { nowIso, sha256Json, uuidv7, type JsonObject, type JsonValue } from "@lathe/domain";
import type { ContentStore, LatheRepository, TraceWriter } from "@lathe/db";
import { ExecutionTargets, type ExecutionTarget } from "@lathe/execution";
import { sanitizeAssetRevision } from "./security.js";

const executionTargets = new ExecutionTargets();

function profileFrom(value: JsonValue): McpServerProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HTTPException(422, { message: "MCP profile asset is invalid" });
  const profile = value as unknown as McpServerProfile;
  if (!profile.id || !profile.revision || !profile.name || !profile.transport) throw new HTTPException(422, { message: "MCP profile requires id, revision, name, and transport" });
  return profile;
}

async function profileAsset(repository: LatheRepository, revisionId: string) {
  const asset = (await repository.listAssetRevisions("mcp-server")).find((item) => item.id === revisionId);
  if (!asset) throw new HTTPException(404, { message: "MCP server revision not found" });
  if (!asset.trusted) {
    throw new HTTPException(409, {
      message: "MCP server revision is disabled until the operator trusts it as a new immutable revision"
    });
  }
  const profile = profileFrom(asset.value);
  const executionTargetId = profile.transport.kind === "stdio"
    ? profile.transport.executionTargetId
    : undefined;
  if (executionTargetId) {
    const target = (await repository.listAssetRevisions("target")).find((item) => item.id === executionTargetId);
    if (!target) throw new HTTPException(422, { message: `MCP execution target '${executionTargetId}' was not found` });
    if (!target.trusted) {
      throw new HTTPException(409, {
        message: `MCP execution target '${executionTargetId}' is disabled until trusted as a new immutable revision`
      });
    }
  }
  return { asset, profile };
}

function traceSink(writer: TraceWriter) {
  return {
    async record(event: McpTraceEvent) {
      await writer.append({
        direction: event.direction === "outbound" ? "request" : event.direction === "inbound" ? "response" : "internal",
        kind: event.level === "error" ? "error" : "log",
        timestamp: event.at,
        data: event as unknown as JsonValue
      });
    }
  };
}

async function stdioSpawner(repository: LatheRepository, profile: McpServerProfile) {
  if (profile.transport.kind !== "stdio" || !profile.transport.executionTargetId) return {};
  const revisionId = profile.transport.executionTargetId;
  const asset = (await repository.listAssetRevisions("target")).find((item) => item.id === revisionId);
  if (!asset || !asset.value || typeof asset.value !== "object" || Array.isArray(asset.value)) {
    throw new HTTPException(422, { message: `MCP execution target '${revisionId}' was not found` });
  }
  if (!asset.trusted) {
    throw new HTTPException(409, {
      message: `MCP execution target '${revisionId}' is disabled until trusted as a new immutable revision`
    });
  }
  const target = asset.value as unknown as ExecutionTarget;
  return {
    spawnStdio: (request: { command: string; args: string[]; cwd?: string; env: Record<string, string> }) => executionTargets.spawnDuplex(target, {
      program: request.command,
      args: request.args,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      environment: request.env
    })
  };
}

async function mcpOperation<T>(
  repository: LatheRepository,
  contentStore: ContentStore,
  profile: McpServerProfile,
  approvals: McpApprovalBroker,
  operation: (client: LatheMcpClient) => Promise<T>,
  roots: McpRoot[] = []
): Promise<{ value: T; traceHash: string }> {
  const writer = await contentStore.createTraceWriter();
  let client: LatheMcpClient | undefined;
  try {
    const { redactionEnabled } = await repository.getApplicationSettings();
    client = await LatheMcpClient.connect({
      profile,
      resolveSecret: (id) => repository.resolveSecret(id),
      approvals,
      policy: { ...DEFAULT_MCP_POLICY, roots },
      redactionEnabled,
      trace: traceSink(writer),
      ...await stdioSpawner(repository, profile)
    });
    const value = await operation(client);
    const stored = await writer.finalize();
    return { value, traceHash: stored.sha256 };
  } catch (error) {
    await writer.append({ direction: "internal", kind: "error", data: { message: "MCP operation failed; see preceding captured transport events" } });
    const stored = await writer.finalize();
    throw new HTTPException(502, { message: `MCP operation failed; inspect trace ${stored.sha256}` });
  } finally {
    await client?.close().catch(() => undefined);
  }
}

function explicitRoots(value: unknown, fallback: McpRoot[] = []): McpRoot[] {
  if (value === undefined) return fallback.map((root) => ({ ...root }));
  if (!Array.isArray(value)) throw new HTTPException(400, { message: "roots must be an array" });
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.uri !== "string") throw new HTTPException(400, { message: "Each root requires a file: URI" });
    let uri: URL;
    try { uri = new URL(item.uri); } catch { throw new HTTPException(400, { message: "Each root requires a valid file: URI" }); }
    if (uri.protocol !== "file:") throw new HTTPException(400, { message: "MCP roots must use file: URIs" });
    return { uri: item.uri, ...(typeof item.name === "string" ? { name: item.name } : {}) };
  });
}

const denyApprovals: McpApprovalBroker = {
  requestApproval: async (request) => ({ outcome: "denied", reason: `This MCP operation cannot approve ${request.kind}` })
};

function promptText(value: JsonValue): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const messages = Array.isArray(value.messages) ? value.messages : [];
  const chunks: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const content = message.content;
    const parts = Array.isArray(content) ? content : [content];
    for (const part of parts) {
      if (part && typeof part === "object" && !Array.isArray(part) && part.type === "text" && typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n\n");
}

function resourceFileName(uri: string, fallback: string, index: number): string {
  try {
    const name = decodeURIComponent(new URL(uri).pathname.split("/").filter(Boolean).at(-1) ?? "");
    if (name && !name.includes("/") && !name.includes("\\")) return name;
  } catch {
    // Fall through to an operator-provided or deterministic name.
  }
  return index === 0 ? fallback : `${fallback}-${index + 1}`;
}

export function registerMcpRoutes(app: Hono, repository: LatheRepository, contentStore: ContentStore): void {
  app.get("/api/mcp/profiles", async (context) => context.json({ profiles: (await repository.listAssetRevisions("mcp-server")).map(sanitizeAssetRevision) }));

  app.post("/api/mcp/:revisionId/capabilities", async (context) => {
    const { profile } = await profileAsset(repository, context.req.param("revisionId"));
    const body = await context.req.json().catch(() => ({})) as { roots?: unknown };
    const result = await mcpOperation(repository, contentStore, profile, denyApprovals, (client) => client.captureCapabilities(), explicitRoots(body.roots, profile.roots ?? []));
    return context.json({ snapshot: result.value, traceHash: result.traceHash });
  });

  app.post("/api/mcp/:revisionId/prompts/list", async (context) => {
    const { profile } = await profileAsset(repository, context.req.param("revisionId"));
    const body = await context.req.json().catch(() => ({})) as { cursor?: string; roots?: unknown };
    const result = await mcpOperation(repository, contentStore, profile, denyApprovals, (client) => client.listPrompts(body.cursor), explicitRoots(body.roots, profile.roots ?? []));
    return context.json({ result: result.value, traceHash: result.traceHash });
  });

  app.post("/api/mcp/:revisionId/resources/list", async (context) => {
    const { profile } = await profileAsset(repository, context.req.param("revisionId"));
    const body = await context.req.json().catch(() => ({})) as { cursor?: string; roots?: unknown };
    const result = await mcpOperation(repository, contentStore, profile, denyApprovals, (client) => client.listResources(body.cursor), explicitRoots(body.roots, profile.roots ?? []));
    return context.json({ result: result.value, traceHash: result.traceHash });
  });

  app.post("/api/mcp/:revisionId/prompts/:name/import", async (context) => {
    const { asset: serverAsset, profile } = await profileAsset(repository, context.req.param("revisionId"));
    const body = await context.req.json() as { approve?: boolean; arguments?: Record<string, string>; label?: string; description?: string; roots?: unknown };
    if (body.approve !== true) throw new HTTPException(409, { message: "MCP prompt imports require an explicit approve=true decision" });
    const remoteName = context.req.param("name");
    const result = await mcpOperation(repository, contentStore, profile, denyApprovals, (client) => client.getPrompt(remoteName, body.arguments), explicitRoots(body.roots, profile.roots ?? []));
    const content = promptText(result.value);
    if (!content) throw new HTTPException(422, { message: "MCP prompt contained no importable text content" });
    const value: JsonObject = { content, mcpPrompt: result.value as JsonValue };
    const imported = await repository.saveAssetRevision({
      id: uuidv7(), assetId: uuidv7(), kind: "prompt", revision: 1,
      name: body.label?.trim() || remoteName,
      description: body.description ?? `Explicitly imported from MCP server ${profile.name}`,
      tags: ["mcp-import"],
      provenance: { mcpServerRevisionId: serverAsset.id, remoteName, arguments: (body.arguments ?? {}) as unknown as JsonValue, traceHash: result.traceHash },
      value, contentHash: sha256Json(value), trusted: false, archivedAt: null, createdAt: nowIso()
    });
    return context.json({ asset: imported, traceHash: result.traceHash, trusted: false }, 201);
  });

  app.post("/api/mcp/:revisionId/resources/import", async (context) => {
    const { asset: serverAsset, profile } = await profileAsset(repository, context.req.param("revisionId"));
    const body = await context.req.json() as { approve?: boolean; uri?: string; projectId?: string; fileName?: string; roots?: unknown };
    if (body.approve !== true) throw new HTTPException(409, { message: "MCP resource imports require an explicit approve=true decision" });
    if (!body.uri || !body.projectId) throw new HTTPException(400, { message: "uri and projectId are required" });
    if (!await repository.getProject(body.projectId)) throw new HTTPException(404, { message: "Project not found" });
    const result = await mcpOperation(repository, contentStore, profile, denyApprovals, (client) => client.readResource(body.uri!), explicitRoots(body.roots, profile.roots ?? []));
    const response = result.value;
    const contents = response && typeof response === "object" && !Array.isArray(response) && Array.isArray(response.contents) ? response.contents : [];
    if (contents.length === 0) throw new HTTPException(422, { message: "MCP resource response contained no content" });
    const attachments = [];
    for (const [index, entry] of contents.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new HTTPException(422, { message: "MCP resource content is malformed" });
      const uri = typeof entry.uri === "string" ? entry.uri : body.uri;
      let bytes: Uint8Array;
      if (typeof entry.text === "string") bytes = new TextEncoder().encode(entry.text);
      else if (typeof entry.blob === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(entry.blob)) bytes = Buffer.from(entry.blob, "base64");
      else throw new HTTPException(422, { message: "MCP resource content must contain text or base64 blob data" });
      if (bytes.byteLength > 100 * 1024 * 1024) throw new HTTPException(413, { message: "MCP resource exceeds the 100 MiB attachment limit" });
      const stored = await contentStore.put(bytes);
      attachments.push(await repository.saveAttachment({
        projectId: body.projectId,
        fileName: resourceFileName(uri, body.fileName?.trim() || "mcp-resource", index),
        mediaType: typeof entry.mimeType === "string" ? entry.mimeType : "application/octet-stream",
        size: stored.size,
        sha256: stored.sha256
      }));
    }
    return context.json({ attachments, traceHash: result.traceHash, source: { mcpServerRevisionId: serverAsset.id, uri: body.uri } }, 201);
  });

  app.post("/api/mcp/:revisionId/tools/:name/call", async (context) => {
    const { asset, profile } = await profileAsset(repository, context.req.param("revisionId"));
    const body = await context.req.json() as { arguments?: JsonValue; sessionId?: string; approve?: boolean; roots?: unknown };
    if (body.approve !== true) throw new HTTPException(409, { message: "MCP tool calls require an explicit approve=true decision" });
    const approvals: McpApprovalBroker = {
      requestApproval: async (request) => request.kind === "toolCall"
        ? { outcome: "approved" }
        : { outcome: "denied", reason: `${request.kind} requires a separate operator approval` }
    };
    const result = await mcpOperation(repository, contentStore, profile, approvals, (client) => client.callTool({
        name: context.req.param("name"),
        toolRevisionHash: asset.contentHash,
        ...(body.arguments === undefined ? {} : { arguments: body.arguments }),
        ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId })
      }), explicitRoots(body.roots, profile.roots ?? []));
    return context.json({ result: result.value, traceHash: result.traceHash });
  });

  app.post("/api/mcp/:revisionId/tools/:name/task", async (context) => {
    const { asset, profile } = await profileAsset(repository, context.req.param("revisionId"));
    const body = await context.req.json() as { arguments?: JsonValue; sessionId?: string; approve?: boolean; roots?: unknown; ttlMs?: number; pollIntervalMs?: number };
    if (body.approve !== true) throw new HTTPException(409, { message: "MCP task tool calls require an explicit approve=true decision" });
    const approvals: McpApprovalBroker = { requestApproval: async (request) => request.kind === "toolCall" ? { outcome: "approved" } : { outcome: "denied", reason: `${request.kind} requires a separate operator approval` } };
    const result = await mcpOperation(repository, contentStore, profile, approvals, async (client) => {
      const messages: JsonValue[] = [];
      for await (const message of client.callToolTask({
        name: context.req.param("name"), toolRevisionHash: asset.contentHash,
        ...(body.arguments === undefined ? {} : { arguments: body.arguments }),
        ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
        ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
        ...(body.pollIntervalMs === undefined ? {} : { pollIntervalMs: body.pollIntervalMs })
      })) messages.push(message);
      return messages;
    }, explicitRoots(body.roots, profile.roots ?? []));
    return context.json({ messages: result.value, traceHash: result.traceHash });
  });

  app.post("/api/mcp/:revisionId/tasks/list", async (context) => {
    const { profile } = await profileAsset(repository, context.req.param("revisionId"));
    const body = await context.req.json().catch(() => ({})) as { cursor?: string; roots?: unknown };
    const result = await mcpOperation(repository, contentStore, profile, denyApprovals, (client) => client.listTasks(body.cursor), explicitRoots(body.roots, profile.roots ?? []));
    return context.json({ result: result.value, traceHash: result.traceHash });
  });

  app.post("/api/mcp/:revisionId/tasks/:taskId/get", async (context) => {
    const { profile } = await profileAsset(repository, context.req.param("revisionId"));
    const body = await context.req.json().catch(() => ({})) as { roots?: unknown };
    const result = await mcpOperation(repository, contentStore, profile, denyApprovals, (client) => client.getTask(context.req.param("taskId")), explicitRoots(body.roots, profile.roots ?? []));
    return context.json({ result: result.value, traceHash: result.traceHash });
  });

  app.post("/api/mcp/:revisionId/tasks/:taskId/result", async (context) => {
    const { profile } = await profileAsset(repository, context.req.param("revisionId"));
    const body = await context.req.json().catch(() => ({})) as { roots?: unknown };
    const result = await mcpOperation(repository, contentStore, profile, denyApprovals, (client) => client.getToolTaskResult(context.req.param("taskId")), explicitRoots(body.roots, profile.roots ?? []));
    return context.json({ result: result.value, traceHash: result.traceHash });
  });

  app.post("/api/mcp/:revisionId/tasks/:taskId/cancel", async (context) => {
    const { profile } = await profileAsset(repository, context.req.param("revisionId"));
    const body = await context.req.json() as { approve?: boolean; roots?: unknown };
    if (body.approve !== true) throw new HTTPException(409, { message: "MCP task cancellation requires an explicit approve=true decision" });
    const result = await mcpOperation(repository, contentStore, profile, denyApprovals, (client) => client.cancelTask(context.req.param("taskId")), explicitRoots(body.roots, profile.roots ?? []));
    return context.json({ result: result.value, traceHash: result.traceHash });
  });
}
