import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistence } from "@lathe/db";
import {
  emptyResolvedConfig,
  nowIso,
  sha256Json,
  uuidv7,
  type AssetRevision,
  type JsonObject,
} from "@lathe/domain";
import { EventHub } from "../src/events.js";
import { ProviderRunCoordinator } from "../src/provider-run-coordinator.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for refused run");
}

describe("provider refusal persistence", () => {
  it("preserves partial output and marks an HTTP-200 OpenRouter Fable refusal", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-refusal-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    try {
      const project = await persistence.repository.createProject({ name: "Project" });
      const profile = await persistence.repository.createProviderProfile({
        label: "OpenRouter fixture",
        protocol: "openai-chat",
        baseUrl: "https://openrouter.invalid/api/v1",
        models: [{
          id: "anthropic/claude-fable-5",
          label: "Fable",
          discovered: false,
          capabilities: { streaming: true, tools: true, images: false, files: false, jsonMode: false, maxContextTokens: null },
        }],
      });
      const { session, branch } = await persistence.repository.createSession({
        projectId: project.id,
        name: "Session",
        providerProfileId: profile.id,
        modelId: "anthropic/claude-fable-5",
      });
      const encoder = new TextEncoder();
      const fetchFixture: typeof fetch = async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"reasoning":"Checking request."},"finish_reason":null}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Partial answer."},"finish_reason":null}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"","refusal":"This request triggered restrictions on violative cyber content."},"finish_reason":null}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"content_filter","native_finish_reason":"refusal"}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
      const coordinator = new ProviderRunCoordinator(persistence.repository, persistence.contentStore, new EventHub(), fetchFixture);
      const started = await coordinator.start({ sessionId: session.id, branchId: branch.id, contextNodeId: null, userMessage: "test" });
      await waitFor(async () => (await persistence.repository.getRun(started.id))?.status === "completed");

      const run = await persistence.repository.getRun(started.id);
      const nodes = await persistence.repository.listNodes(session.id);
      const output = run?.normalizedOutput as JsonObject;
      expect(run).toMatchObject({ status: "completed", classification: "content-policy" });
      expect(nodes.map((node) => node.role)).toEqual(["user", "assistant"]);
      expect(nodes[1]?.parts).toEqual([{ type: "text", text: "Partial answer." }]);
      expect(output.reasoning).toBe("Checking request.");
      expect(output.providerOutcome).toMatchObject({
        status: "blocked",
        partialOutput: true,
        finishReason: "content_filter",
        nativeFinishReason: "refusal",
        refusalText: "This request triggered restrictions on violative cyber content.",
      });
    } finally {
      await persistence.repository.close();
    }
  });

  it("executes a captured tool call despite a simultaneous policy block and continues with its natural error", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-refusal-tool-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    try {
      const project = await persistence.repository.createProject({ name: "Project" });
      const profile = await persistence.repository.createProviderProfile({
        label: "OpenRouter fixture",
        protocol: "openai-chat",
        baseUrl: "https://openrouter.invalid/api/v1",
        models: [{
          id: "anthropic/claude-fable-5",
          label: "Fable",
          discovered: false,
          capabilities: { streaming: true, tools: true, images: false, files: false, jsonMode: false, maxContextTokens: null },
        }],
      });
      const specValue: JsonObject = {
        name: "bash",
        description: "Run a Bash command",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      };
      const source = `
        function build(input) {
          return { program: "/bin/sh", args: ["-c", input.arguments.command] };
        }
        function formatResult(input) {
          return {
            status: input.status,
            exitCode: input.exitCode,
            stdout: input.stdout.text,
            stderr: input.stderr.text
          };
        }
      `;
      const implementationValue: JsonObject = { source };
      const spec: AssetRevision = {
        id: uuidv7(), assetId: uuidv7(), kind: "tool-spec", revision: 1, name: "bash",
        description: "Run a Bash command", tags: [], provenance: { test: true }, value: specValue,
        contentHash: sha256Json(specValue), trusted: true, archivedAt: null, createdAt: nowIso(),
      };
      const implementation: AssetRevision = {
        id: uuidv7(), assetId: uuidv7(), kind: "tool-implementation", revision: 1, name: "bash handler",
        description: "Run a shell command", tags: [], provenance: { test: true }, value: implementationValue,
        contentHash: sha256Json(implementationValue), trusted: true, archivedAt: null, createdAt: nowIso(),
      };
      await persistence.repository.saveAssetRevision(spec);
      await persistence.repository.saveAssetRevision(implementation);
      const config = emptyResolvedConfig();
      config.toolApprovalMode = "bypass-approval";
      config.tools.push({
        toolRevisionId: spec.id,
        implementationRevisionId: implementation.id,
        name: "bash",
        description: "Run a Bash command",
        inputSchema: specValue.inputSchema as JsonObject,
        enabled: true,
        mode: "real",
        targetId: null,
        mcpServerId: null,
      });
      const { session, branch } = await persistence.repository.createSession({
        projectId: project.id,
        name: "Session",
        providerProfileId: profile.id,
        modelId: "anthropic/claude-fable-5",
        draftConfig: config,
      });
      await persistence.repository.updateSessionContinuation(session.id, true, 8);

      const encoder = new TextEncoder();
      const requestBodies: JsonObject[] = [];
      const incompleteCommand = 'for r in "/key/list"; do printf "=== %s -> " "$r"; cur';
      const toolArguments = JSON.stringify({ command: incompleteCommand });
      const argumentSplit = toolArguments.indexOf("printf");
      const toolCallFrame = (argumentsDelta: string): string => `data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-truncated",
              function: { name: "bash", arguments: argumentsDelta },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`;
      const fetchFixture: typeof fetch = async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)) as JsonObject);
        const frames = requestBodies.length === 1
          ? [
              'data: {"choices":[{"index":0,"delta":{"reasoning":"I will try the command."},"finish_reason":null}]}\n\n',
              toolCallFrame(toolArguments.slice(0, argumentSplit)),
              toolCallFrame(toolArguments.slice(argumentSplit)),
              'data: {"choices":[{"index":0,"delta":{"content":"","refusal":"This request was blocked by policy."},"finish_reason":null}]}\n\n',
              'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"content_filter","native_finish_reason":"refusal"}]}\n\n',
              "data: [DONE]\n\n",
            ]
          : [
              'data: {"choices":[{"index":0,"delta":{"content":"The attempted command was incomplete, so the shell reported the error."},"finish_reason":null}]}\n\n',
              'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
              "data: [DONE]\n\n",
            ];
        return new Response(new ReadableStream({
          start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.close();
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      };

      const coordinator = new ProviderRunCoordinator(persistence.repository, persistence.contentStore, new EventHub(), fetchFixture);
      const started = await coordinator.start({
        sessionId: session.id,
        branchId: branch.id,
        contextNodeId: null,
        userMessage: "Probe the service",
      });
      await waitFor(async () => requestBodies.length === 2, 12_000);
      await waitFor(async () => {
        const runs = await persistence.repository.listRuns(session.id);
        return runs.length === 2 && runs.every((run) => run.status === "completed");
      }, 12_000);

      const runs = await persistence.repository.listRuns(session.id);
      const originatingRun = runs.find((run) => run.id === started.id);
      expect(originatingRun).toMatchObject({
        status: "completed",
        classification: "content-policy",
        normalizedOutput: {
          providerOutcome: { status: "blocked", terminalPolicyBlock: true },
          toolResults: [{ callId: "call-truncated", isError: true }],
          autoContinuation: { status: "started", nextRunId: expect.any(String), hadToolErrors: true },
        },
      });

      const continuedMessages = requestBodies[1]?.messages as JsonObject[];
      expect(continuedMessages).toContainEqual(expect.objectContaining({
        role: "assistant",
        tool_calls: [expect.objectContaining({
          id: "call-truncated",
          function: expect.objectContaining({ name: "bash", arguments: toolArguments }),
        })],
      }));
      const continuedToolResult = continuedMessages.find((message) => message.role === "tool");
      expect(continuedToolResult).toMatchObject({ role: "tool", tool_call_id: "call-truncated" });
      const continuedResult = JSON.parse(String(continuedToolResult?.content)) as JsonObject;
      expect(continuedResult).toMatchObject({
        status: "failed",
        exitCode: expect.any(Number),
      });
      expect(continuedResult.exitCode).not.toBe(0);
      expect(String(continuedResult.stderr)).toMatch(/syntax|unexpected|expecting|done/i);

      const nodes = await persistence.repository.listNodes(session.id);
      expect(nodes.map((node) => node.role)).toEqual(["user", "assistant", "tool", "assistant"]);
      expect(nodes[1]?.parts).toEqual([{
        type: "tool-call",
        callId: "call-truncated",
        name: "bash",
        arguments: { command: incompleteCommand },
      }]);
    } finally {
      await persistence.repository.close();
    }
  }, 15_000);
});
