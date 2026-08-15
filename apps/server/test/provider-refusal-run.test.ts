import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistence } from "@lathe/db";
import type { JsonObject } from "@lathe/domain";
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
});
