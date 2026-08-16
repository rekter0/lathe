import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistence } from "@lathe/db";
import { emptyResolvedConfig, nowIso, sha256Json, uuidv7, type AssetRevision, type JsonObject } from "@lathe/domain";
import { EventHub } from "../src/events.js";
import { ProviderRunCoordinator, parseMcpSamplingRequest } from "../src/provider-run-coordinator.js";
import { LatheMcpClient, type McpApprovalRequest } from "@lathe/mcp";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for model run");
}

describe("provider run coordinator", () => {
  it("conservatively parses text-only MCP sampling requests", () => {
    expect(parseMcpSamplingRequest({
      messages: [
        { role: "user", content: { type: "text", text: "first" } },
        { role: "assistant", content: [{ type: "text", text: "second" }, { type: "text", text: "third" }] }
      ],
      systemPrompt: "Stay concise",
      maxTokens: 64,
      temperature: 0.4,
      stopSequences: ["END"],
      includeContext: "none"
    })).toMatchObject({
      messages: [{ role: "user", content: "first" }, { role: "assistant" }],
      systemPrompt: "Stay concise",
      maxOutputTokens: 64,
      temperature: 0.4,
      stopSequences: ["END"]
    });
    expect(() => parseMcpSamplingRequest({
      messages: [{ role: "user", content: { type: "image", data: "AA==", mimeType: "image/png" } }],
      maxTokens: 64
    })).toThrow(/text only/);
    expect(() => parseMcpSamplingRequest({ messages: [], maxTokens: 64, tools: [] })).toThrow(/tools and tool choice/);
    expect(() => parseMcpSamplingRequest({ messages: [], maxTokens: 64, includeContext: "allServers" })).toThrow(/does not silently import/);
  });

  it("persists a streamed response as an immutable assistant node and trace", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-run-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    try {
      const project = await persistence.repository.createProject({ name: "Project" });
      const profile = await persistence.repository.createProviderProfile({
        label: "Fixture",
        protocol: "openai-chat",
        baseUrl: "https://fixture.invalid",
        endpointOverride: "https://fixture.invalid/custom/chat?token=fixture-secret",
        credential: "fixture-secret",
        headers: { "x-tenant-proof": "header-secret" },
        extraBody: { routingHint: "header-secret" },
        models: [{
          id: "fixture-model", label: "Fixture model", discovered: false,
          capabilities: { streaming: true, tools: true, images: false, files: false, jsonMode: false, maxContextTokens: null }
        }]
      });
      const { session, branch } = await persistence.repository.createSession({
        projectId: project.id, name: "Session", providerProfileId: profile.id, modelId: "fixture-model"
      });
      const encoder = new TextEncoder();
      const fetchFixture: typeof fetch = async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"id":"response-1","model":"fixture-model","choices":[{"index":0,"delta":{"content":"hello "}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"operator"},"finish_reason":"stop"}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
      const coordinator = new ProviderRunCoordinator(persistence.repository, persistence.contentStore, new EventHub(), fetchFixture);
      const started = await coordinator.start({ sessionId: session.id, branchId: branch.id, contextNodeId: null, userMessage: "test" });
      await waitFor(async () => (await persistence.repository.getRun(started.id))?.status === "completed");
      const run = await persistence.repository.getRun(started.id);
      const nodes = await persistence.repository.listNodes(session.id);
      expect(nodes.map((node) => node.role)).toEqual(["user", "assistant"]);
      expect(nodes[1]?.parts).toEqual([{ type: "text", text: "hello operator" }]);
      expect(run?.traceHash).toMatch(/^[a-f0-9]{64}$/);
      expect((await persistence.contentStore.get(run!.traceHash!)).toString()).not.toContain("fixture-secret");
      expect((await persistence.contentStore.get(run!.traceHash!)).toString()).not.toContain("header-secret");
      const snapshot = await persistence.repository.getConfigSnapshot(run!.configSnapshotId);
      expect(JSON.stringify(snapshot?.config)).not.toContain("header-secret");
      expect(snapshot?.config.provider?.endpointOverride).toContain("/custom/chat");
      expect(snapshot?.config.provider?.endpointOverride).toContain("REDACTED");
      expect(snapshot?.config.provider?.endpointOverride).not.toContain("fixture-secret");
    } finally {
      await persistence.repository.close();
    }
  });

  it("applies a persisted redaction change only to new runs and still protects configured credentials", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-redaction-run-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    try {
      const project = await persistence.repository.createProject({ name: "Project" });
      const profile = await persistence.repository.createProviderProfile({
        label: "Fixture",
        protocol: "openai-chat",
        baseUrl: "https://fixture.invalid",
        credential: "x",
        models: [{
          id: "fixture-model", label: "Fixture model", discovered: false,
          capabilities: { streaming: true, tools: true, images: false, files: false, jsonMode: false, maxContextTokens: null }
        }]
      });
      const { session, branch } = await persistence.repository.createSession({
        projectId: project.id,
        name: "Session",
        providerProfileId: profile.id,
        modelId: "fixture-model"
      });
      const evidenceText = "example text | Bearer fake-red-team-token | exact=x";
      const fetchFixture: typeof fetch = async () => new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: evidenceText }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
      const coordinator = new ProviderRunCoordinator(persistence.repository, persistence.contentStore, new EventHub(), fetchFixture);

      const strict = await coordinator.start({ sessionId: session.id, branchId: branch.id, userMessage: "strict" });
      await waitFor(async () => (await persistence.repository.getRun(strict.id))?.status === "completed");
      const strictRun = await persistence.repository.getRun(strict.id);
      const strictNodes = await persistence.repository.listNodes(session.id);
      expect(JSON.stringify(strictNodes.at(-1)?.parts)).not.toContain("fake-red-team-token");
      expect(strictRun?.normalizedOutput).toMatchObject({ redactionEnabled: true });

      await persistence.repository.upsertApplicationSettings({ redactionEnabled: false });
      const currentBranch = (await persistence.repository.listBranches(session.id)).find((item) => item.id === branch.id)!;
      const relaxed = await coordinator.start({
        sessionId: session.id,
        branchId: branch.id,
        contextNodeId: currentBranch.headNodeId,
        userMessage: "relaxed"
      });
      await waitFor(async () => (await persistence.repository.getRun(relaxed.id))?.status === "completed");
      const relaxedRun = await persistence.repository.getRun(relaxed.id);
      const relaxedNodes = await persistence.repository.listNodes(session.id);
      const relaxedText = JSON.stringify(relaxedNodes.at(-1)?.parts);
      expect(relaxedText).toContain("example text");
      expect(relaxedText).toContain("Bearer fake-red-team-token");
      expect(relaxedText).not.toContain("exact=x");
      expect(relaxedRun?.normalizedOutput).toMatchObject({ redactionEnabled: false });
      const relaxedTrace = (await persistence.contentStore.get(relaxedRun!.traceHash!)).toString();
      expect(relaxedTrace).toContain("example text");
      expect(relaxedTrace).not.toContain("exact=x");
      expect(relaxedTrace).not.toContain('"authorization":"Bearer x"');

      expect(JSON.stringify(strictNodes.at(-1)?.parts)).not.toContain("fake-red-team-token");
    } finally {
      await persistence.repository.close();
    }
  });

  it("prepares, approves, executes, and formats a real QuickJS-backed tool call", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-tool-run-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    try {
      const project = await persistence.repository.createProject({ name: "Project" });
      const profile = await persistence.repository.createProviderProfile({
        label: "Fixture", protocol: "openai-chat", baseUrl: "https://fixture.invalid", models: [{
          id: "fixture-model", label: "Fixture model", discovered: false,
          capabilities: { streaming: true, tools: true, images: false, files: false, jsonMode: false, maxContextTokens: null }
        }]
      });
      const specValue: JsonObject = { name: "echo_value", description: "Echo a value", inputSchema: { type: "object", properties: { value: { type: "string" } } } };
      const source = `
        function build(input) { return { program: "/bin/echo", args: [String(input.arguments.value)] }; }
        function formatResult(input) { return { output: input.stdout.text.trim(), exitCode: input.exitCode }; }
      `;
      const implementationValue: JsonObject = { source };
      const spec: AssetRevision = { id: uuidv7(), assetId: uuidv7(), kind: "tool-spec", revision: 1, name: "echo_value", description: "Echo", tags: [], provenance: { test: true }, value: specValue, contentHash: sha256Json(specValue), trusted: true, archivedAt: null, createdAt: nowIso() };
      const implementation: AssetRevision = { id: uuidv7(), assetId: uuidv7(), kind: "tool-implementation", revision: 1, name: "echo_value host handler", description: "Echo", tags: [], provenance: { test: true }, value: implementationValue, contentHash: sha256Json(implementationValue), trusted: true, archivedAt: null, createdAt: nowIso() };
      await persistence.repository.saveAssetRevision(spec);
      await persistence.repository.saveAssetRevision(implementation);
      const config = emptyResolvedConfig();
      config.tools.push({
        toolRevisionId: spec.id, implementationRevisionId: implementation.id, name: "echo_value", description: "Echo a value",
        inputSchema: specValue.inputSchema as JsonObject, enabled: true, mode: "real", targetId: null, mcpServerId: null
      });
      const { session, branch } = await persistence.repository.createSession({ projectId: project.id, name: "Session", providerProfileId: profile.id, modelId: "fixture-model", draftConfig: config });
      const encoder = new TextEncoder();
      const fetchFixture: typeof fetch = async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"echo_value","arguments":"{\\"value\\":\\"lathe\\"}"}}]}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
      const coordinator = new ProviderRunCoordinator(persistence.repository, persistence.contentStore, new EventHub(), fetchFixture);
      const started = await coordinator.start({ sessionId: session.id, branchId: branch.id, contextNodeId: null, userMessage: "echo" });
      await waitFor(async () => (await persistence.repository.getRun(started.id))?.status === "awaiting-tool", 12_000);
      const awaiting = await persistence.repository.getRun(started.id);
      expect(JSON.stringify(awaiting?.normalizedOutput)).toContain("/bin/echo");
      expect(JSON.stringify(awaiting?.normalizedOutput)).toContain(session.id);
      // A fresh coordinator has no in-memory pending map and must reconstruct
      // the call from the immutable assistant node and config snapshot.
      const restartedCoordinator = new ProviderRunCoordinator(persistence.repository, persistence.contentStore, new EventHub(), fetchFixture);
      await expect(restartedCoordinator.resolveToolCall(started.id, "call-1", {})).rejects.toThrow(/requires/);
      expect((await persistence.repository.getRun(started.id))?.status).toBe("awaiting-tool");
      const firstResolution = restartedCoordinator.resolveToolCall(started.id, "call-1", {
        decision: "approve-once",
        overrideArguments: { value: "operator-edited" }
      });
      await expect(restartedCoordinator.resolveToolCall(started.id, "call-1", { decision: "approve-once" })).rejects.toThrow(/already in progress/);
      await firstResolution;
      await waitFor(async () => (await persistence.repository.getRun(started.id))?.status === "completed", 12_000);
      const nodes = await persistence.repository.listNodes(session.id);
      expect(nodes.map((node) => node.role)).toEqual(["user", "assistant", "tool"]);
      expect(JSON.stringify(nodes.at(-1)?.parts)).toContain("operator-edited");
      const completed = await persistence.repository.getRun(started.id);
      const evidence = JSON.stringify(completed?.normalizedOutput);
      expect(evidence).toContain("originalCommand");
      expect(evidence).toContain("effectiveCommand");
      expect(evidence).toContain("lathe");
      expect(evidence).toContain("operator-edited");
      expect(evidence).toContain("builtin:host:v1");
      expect(evidence).toContain('"inheritsProcessEnvironment":false');
      expect(evidence).toContain('"kind":"direct"');
      expect(evidence).toMatch(/[a-f0-9]{64}/);
      await expect(restartedCoordinator.resolveToolCall(started.id, "call-1", { decision: "approve-once" })).rejects.toThrow(/no pending|already been resolved/);

      config.toolApprovalMode = "bypass-approval";
      await persistence.repository.updateSessionDraft(session.id, config);
      const currentBranch = (await persistence.repository.listBranches(session.id)).find((item) => item.id === branch.id)!;
      const bypassed = await restartedCoordinator.start({
        sessionId: session.id,
        branchId: currentBranch.id,
        contextNodeId: currentBranch.headNodeId,
        userMessage: "echo without a prompt"
      });
      await waitFor(async () => (await persistence.repository.getRun(bypassed.id))?.status === "completed", 12_000);
      const bypassedRun = await persistence.repository.getRun(bypassed.id);
      expect(JSON.stringify(bypassedRun?.normalizedOutput)).toContain('"decision":"bypass-approval"');
      const bypassedSnapshot = await persistence.repository.getConfigSnapshot(bypassedRun!.configSnapshotId);
      expect(bypassedSnapshot?.config.toolApprovalMode).toBe("bypass-approval");
      expect(JSON.stringify((await persistence.repository.listNodes(session.id)).at(-1)?.parts)).toContain("lathe");
    } finally {
      await persistence.repository.close();
    }
  }, 15_000);

  it("stops automatic tool continuation at the configured boundary", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-tool-limit-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    try {
      const project = await persistence.repository.createProject({ name: "Project" });
      const profile = await persistence.repository.createProviderProfile({
        label: "Fixture", protocol: "openai-chat", baseUrl: "https://fixture.invalid", models: [{
          id: "fixture-model", label: "Fixture model", discovered: false,
          capabilities: { streaming: true, tools: true, images: false, files: false, jsonMode: false, maxContextTokens: null }
        }]
      });
      const { session, branch } = await persistence.repository.createSession({ projectId: project.id, name: "Session", providerProfileId: profile.id, modelId: "fixture-model" });
      await persistence.repository.updateSessionContinuation(session.id, true, 1);
      let fetchCalls = 0;
      const encoder = new TextEncoder();
      const fetchFixture: typeof fetch = async () => {
        fetchCalls += 1;
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-limit","function":{"name":"manual_tool","arguments":"{}"}}]}}]}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      };
      const coordinator = new ProviderRunCoordinator(persistence.repository, persistence.contentStore, new EventHub(), fetchFixture);
      const started = await coordinator.start({ sessionId: session.id, branchId: branch.id, contextNodeId: null, userMessage: "run" });
      await waitFor(async () => (await persistence.repository.getRun(started.id))?.status === "awaiting-tool");
      await coordinator.resolveToolCall(started.id, "call-limit", { result: { ok: true } });
      await waitFor(async () => (await persistence.repository.getRun(started.id))?.status === "completed");
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(fetchCalls).toBe(1);
      expect(await persistence.repository.getRun(started.id)).toMatchObject({ normalizedOutput: { autoContinuation: { status: "stopped", reason: "limit", limit: 1 } } });
    } finally {
      await persistence.repository.close();
    }
  });

  it("reports a failed real command to the model and automatically continues", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-tool-error-continuation-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    try {
      const project = await persistence.repository.createProject({ name: "Project" });
      const profile = await persistence.repository.createProviderProfile({
        label: "Fixture", protocol: "openai-chat", baseUrl: "https://fixture.invalid", models: [{
          id: "fixture-model", label: "Fixture model", discovered: false,
          capabilities: { streaming: true, tools: true, images: false, files: false, jsonMode: false, maxContextTokens: null }
        }]
      });
      const specValue: JsonObject = {
        name: "read_protected_file",
        description: "Read a protected file",
        inputSchema: { type: "object", properties: {} }
      };
      const source = `
        function build() {
          return {
            program: "/bin/sh",
            args: ["-c", "printf 'Permission denied\\n' >&2; exit 1"]
          };
        }
        function formatResult(input) {
          return {
            status: input.status,
            exitCode: input.exitCode,
            stderr: input.stderr.text
          };
        }
      `;
      const implementationValue: JsonObject = { source };
      const spec: AssetRevision = {
        id: uuidv7(), assetId: uuidv7(), kind: "tool-spec", revision: 1, name: "read_protected_file",
        description: "Read a protected file", tags: [], provenance: { test: true }, value: specValue,
        contentHash: sha256Json(specValue), trusted: true, archivedAt: null, createdAt: nowIso()
      };
      const implementation: AssetRevision = {
        id: uuidv7(), assetId: uuidv7(), kind: "tool-implementation", revision: 1, name: "protected file handler",
        description: "Returns a nonzero command result", tags: [], provenance: { test: true }, value: implementationValue,
        contentHash: sha256Json(implementationValue), trusted: true, archivedAt: null, createdAt: nowIso()
      };
      await persistence.repository.saveAssetRevision(spec);
      await persistence.repository.saveAssetRevision(implementation);
      const config = emptyResolvedConfig();
      config.toolApprovalMode = "bypass-approval";
      config.tools.push({
        toolRevisionId: spec.id,
        implementationRevisionId: implementation.id,
        name: "read_protected_file",
        description: "Read a protected file",
        inputSchema: specValue.inputSchema as JsonObject,
        enabled: true,
        mode: "real",
        targetId: null,
        mcpServerId: null
      });
      const { session, branch } = await persistence.repository.createSession({
        projectId: project.id,
        name: "Session",
        providerProfileId: profile.id,
        modelId: "fixture-model",
        draftConfig: config
      });
      await persistence.repository.updateSessionContinuation(session.id, true, 8);

      const encoder = new TextEncoder();
      const requestBodies: JsonObject[] = [];
      const fetchFixture: typeof fetch = async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)) as JsonObject);
        const frames = requestBodies.length === 1
          ? [
              'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-permission","function":{"name":"read_protected_file","arguments":"{}"}}]}}]}\n\n',
              'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
              "data: [DONE]\n\n"
            ]
          : [
              'data: {"choices":[{"index":0,"delta":{"content":"I could not read the file because permission was denied."}}]}\n\n',
              'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
              "data: [DONE]\n\n"
            ];
        return new Response(new ReadableStream({
          start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.close();
          }
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      };

      const coordinator = new ProviderRunCoordinator(persistence.repository, persistence.contentStore, new EventHub(), fetchFixture);
      const started = await coordinator.start({
        sessionId: session.id,
        branchId: branch.id,
        contextNodeId: null,
        userMessage: "Read the protected file"
      });
      await waitFor(async () => requestBodies.length === 2, 12_000);
      await waitFor(async () => {
        const runs = await persistence.repository.listRuns(session.id);
        return runs.length === 2 && runs.every((run) => run.status === "completed");
      }, 12_000);

      const runs = await persistence.repository.listRuns(session.id);
      const originatingRun = runs.find((run) => run.id === started.id);
      expect(originatingRun?.classification).toBe("tool-failure");
      expect(originatingRun?.normalizedOutput).toMatchObject({
        autoContinuation: { status: "started", nextRunId: expect.any(String), hadToolErrors: true }
      });
      const continuedMessages = requestBodies[1]?.messages as JsonObject[];
      expect(continuedMessages).toContainEqual(expect.objectContaining({
        role: "tool",
        tool_call_id: "call-permission",
        content: expect.stringContaining("Permission denied")
      }));
      const continuedToolResult = continuedMessages.find((message) => message.role === "tool");
      expect(JSON.parse(String(continuedToolResult?.content))).toMatchObject({
        status: "failed",
        exitCode: 1,
        stderr: expect.stringContaining("Permission denied")
      });

      const nodes = await persistence.repository.listNodes(session.id);
      expect(nodes.map((node) => node.role)).toEqual(["user", "assistant", "tool", "assistant"]);
      expect(nodes.at(-1)?.parts).toEqual([{
        type: "text",
        text: "I could not read the file because permission was denied."
      }]);
    } finally {
      await persistence.repository.close();
    }
  }, 15_000);

  it("retains a finalized redacted trace when an integrated MCP tool fails", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-mcp-failure-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const connect = vi.spyOn(LatheMcpClient, "connect").mockRejectedValue(new Error("remote failure containing provider-secret"));
    try {
      const project = await persistence.repository.createProject({ name: "Project" });
      const profile = await persistence.repository.createProviderProfile({
        label: "Fixture", protocol: "openai-chat", baseUrl: "https://fixture.invalid", models: [{
          id: "fixture-model", label: "Fixture model", discovered: false,
          capabilities: { streaming: true, tools: true, images: false, files: false, jsonMode: false, maxContextTokens: null }
        }]
      });
      const specValue: JsonObject = { name: "remote_tool", description: "Remote", inputSchema: { type: "object" } };
      const spec: AssetRevision = { id: uuidv7(), assetId: uuidv7(), kind: "tool-spec", revision: 1, name: "remote_tool", description: "Remote", tags: [], provenance: { test: true }, value: specValue, contentHash: sha256Json(specValue), trusted: true, archivedAt: null, createdAt: nowIso() };
      const mcpValue: JsonObject = { id: "fixture-mcp", revision: "1", name: "Fixture MCP", transport: { kind: "streamableHttp", url: "http://127.0.0.1:65535/mcp" } };
      const mcp: AssetRevision = { id: uuidv7(), assetId: uuidv7(), kind: "mcp-server", revision: 1, name: "Fixture MCP", description: "Remote", tags: [], provenance: { test: true }, value: mcpValue, contentHash: sha256Json(mcpValue), trusted: true, archivedAt: null, createdAt: nowIso() };
      await persistence.repository.saveAssetRevision(spec);
      await persistence.repository.saveAssetRevision(mcp);
      const config = emptyResolvedConfig();
      config.tools.push({ toolRevisionId: spec.id, implementationRevisionId: null, name: "remote_tool", description: "Remote", inputSchema: specValue.inputSchema as JsonObject, enabled: true, mode: "mcp", targetId: null, mcpServerId: mcp.id });
      const { session, branch } = await persistence.repository.createSession({ projectId: project.id, name: "Session", providerProfileId: profile.id, modelId: "fixture-model", draftConfig: config });
      const encoder = new TextEncoder();
      const fetchFixture: typeof fetch = async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"mcp-call","function":{"name":"remote_tool","arguments":"{}"}}]}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
      const coordinator = new ProviderRunCoordinator(persistence.repository, persistence.contentStore, new EventHub(), fetchFixture);
      const started = await coordinator.start({ sessionId: session.id, branchId: branch.id, contextNodeId: null, userMessage: "call" });
      await waitFor(async () => (await persistence.repository.getRun(started.id))?.status === "awaiting-tool");
      await coordinator.resolveToolCall(started.id, "mcp-call", { decision: "reject", reason: "Rejected by operator" });
      const rejectedRun = await persistence.repository.getRun(started.id);
      expect(rejectedRun?.status).toBe("completed");
      expect(rejectedRun?.classification).toBe("tool-failure");
      expect(JSON.stringify(rejectedRun?.normalizedOutput)).toContain("Rejected by operator");
      expect(JSON.stringify(rejectedRun?.normalizedOutput)).toContain("http://127.0.0.1:65535/mcp");
      expect(JSON.stringify(rejectedRun?.normalizedOutput)).toContain(mcp.id);
      expect(connect).not.toHaveBeenCalled();

      const approved = await coordinator.start({ sessionId: session.id, branchId: branch.id, contextNodeId: null, userMessage: "call again" });
      await waitFor(async () => (await persistence.repository.getRun(approved.id))?.status === "awaiting-tool");
      await coordinator.resolveToolCall(approved.id, "mcp-call", { decision: "approve-once" });
      const run = await persistence.repository.getRun(approved.id);
      expect(run?.classification).toBe("tool-failure");
      const output = run?.normalizedOutput as JsonObject;
      const results = output.toolResults as JsonObject[];
      const result = results[0]?.result as JsonObject;
      expect(result.error).not.toContain("provider-secret");
      expect(result.traceHash).toMatch(/^[a-f0-9]{64}$/);
      expect((await persistence.contentStore.get(String(result.traceHash))).toString()).toContain("MCP tool operation failed");
    } finally {
      connect.mockRestore();
      await persistence.repository.close();
    }
  });

  it("runs approved MCP sampling through the active provider as a traced nested model run", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-mcp-sampling-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const samplingRequest: McpApprovalRequest = {
      id: "sampling-approval-1",
      kind: "sampling",
      profileId: "fixture-mcp",
      profileRevision: "1",
      sessionId: "session-will-be-bound-by-lathe",
      createdAt: nowIso(),
      payload: {
        messages: [{ role: "user", content: { type: "text", text: "nested question" } }],
        systemPrompt: "nested system",
        temperature: 0.25,
        maxTokens: 64,
        stopSequences: ["END"],
        modelPreferences: { hints: [{ name: "ignored-model" }] }
      }
    };
    const connect = vi.spyOn(LatheMcpClient, "connect").mockImplementation(async (options) => ({
      callTool: async () => {
        const decision = await options.approvals.requestApproval(samplingRequest);
        if (decision.outcome !== "approved") throw new Error("Sampling was not approved");
        return options.handlers!.sampling!(decision.editedPayload ?? samplingRequest.payload);
      },
      close: async () => undefined
    }) as unknown as Promise<LatheMcpClient>);
    try {
      const project = await persistence.repository.createProject({ name: "Project" });
      const profile = await persistence.repository.createProviderProfile({
        label: "Active fixture",
        protocol: "openai-chat",
        baseUrl: "https://fixture.invalid",
        credential: "nested-provider-secret",
        headers: { "x-secret-proof": "nested-header-secret" },
        models: [{
          id: "active-model", label: "Active model", discovered: false,
          capabilities: { streaming: true, tools: true, images: false, files: false, jsonMode: false, maxContextTokens: null }
        }]
      });
      const specValue: JsonObject = { name: "remote_tool", description: "Remote", inputSchema: { type: "object" } };
      const spec: AssetRevision = { id: uuidv7(), assetId: uuidv7(), kind: "tool-spec", revision: 1, name: "remote_tool", description: "Remote", tags: [], provenance: { test: true }, value: specValue, contentHash: sha256Json(specValue), trusted: true, archivedAt: null, createdAt: nowIso() };
      const mcpValue: JsonObject = { id: "fixture-mcp", revision: "1", name: "Fixture MCP", transport: { kind: "streamableHttp", url: "http://127.0.0.1:65535/mcp" } };
      const mcp: AssetRevision = { id: uuidv7(), assetId: uuidv7(), kind: "mcp-server", revision: 1, name: "Fixture MCP", description: "Remote", tags: [], provenance: { test: true }, value: mcpValue, contentHash: sha256Json(mcpValue), trusted: true, archivedAt: null, createdAt: nowIso() };
      await persistence.repository.saveAssetRevision(spec);
      await persistence.repository.saveAssetRevision(mcp);
      const config = emptyResolvedConfig();
      config.tools.push({ toolRevisionId: spec.id, implementationRevisionId: null, name: "remote_tool", description: "Remote", inputSchema: specValue.inputSchema as JsonObject, enabled: true, mode: "mcp", targetId: null, mcpServerId: mcp.id });
      config.toolApprovalMode = "bypass-approval";
      const { session, branch } = await persistence.repository.createSession({ projectId: project.id, name: "Session", providerProfileId: profile.id, modelId: "active-model", draftConfig: config });
      const encoder = new TextEncoder();
      const requestBodies: string[] = [];
      let fetchCount = 0;
      const fetchFixture: typeof fetch = async (_input, init) => {
        fetchCount += 1;
        requestBodies.push(String(init?.body ?? ""));
        const frames = fetchCount === 1
          ? [
              'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"mcp-call","function":{"name":"remote_tool","arguments":"{}"}}]}}]}\n\n',
              "data: [DONE]\n\n"
            ]
          : [
              'data: {"id":"nested-response","model":"active-model","choices":[{"index":0,"delta":{"content":"nested answer"}}]}\n\n',
              'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
              "data: [DONE]\n\n"
            ];
        return new Response(new ReadableStream({
          start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.close();
          }
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      };
      const coordinator = new ProviderRunCoordinator(persistence.repository, persistence.contentStore, new EventHub(), fetchFixture);
      const started = await coordinator.start({ sessionId: session.id, branchId: branch.id, contextNodeId: null, userMessage: "call" });
      await waitFor(async () => JSON.stringify((await persistence.repository.getRun(started.id))?.normalizedOutput).includes(samplingRequest.id));
      await expect(coordinator.resolveMcpApproval(started.id, samplingRequest.id, { outcome: "approved", response: { type: "text", text: "operator-authored" } })).rejects.toThrow(/must not include an operator response/);
      expect(fetchCount).toBe(1);
      await coordinator.resolveMcpApproval(started.id, samplingRequest.id, { outcome: "approved" });
      await waitFor(async () => (await persistence.repository.getRun(started.id))?.status === "completed");

      const runs = await persistence.repository.listRuns(session.id);
      const nested = runs.find((run) => (run.normalizedOutput as JsonObject | null)?.kind === "mcp-sampling");
      expect(nested).toMatchObject({ status: "completed", classification: null, resultNodeId: null, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } });
      expect(nested?.startedAt).toBeTruthy();
      expect(nested?.finishedAt).toBeTruthy();
      expect(nested?.traceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(nested?.normalizedOutput).toMatchObject({
        parentRunId: started.id,
        approvalId: samplingRequest.id,
        text: "nested answer",
        response: { model: "active-model", role: "assistant", content: { type: "text", text: "nested answer" }, stopReason: "endTurn" },
        timings: { durationMs: expect.any(Number) }
      });
      expect(JSON.stringify((await persistence.repository.getRun(started.id))?.normalizedOutput)).toContain(nested!.id);
      expect(JSON.stringify((await persistence.repository.getRun(started.id))?.normalizedOutput)).toContain('"decision":"bypass-approval"');
      expect(requestBodies[1]).toContain("nested question");
      expect(requestBodies[1]).toContain("nested system");
      expect(requestBodies[1]).toContain("END");
      const trace = (await persistence.contentStore.get(nested!.traceHash!)).toString();
      expect(trace).not.toContain("nested-provider-secret");
      expect(trace).not.toContain("nested-header-secret");
      expect((await persistence.repository.listNodes(session.id)).map((node) => node.role)).toEqual(["user", "assistant", "tool"]);
    } finally {
      connect.mockRestore();
      await persistence.repository.close();
    }
  });
});
