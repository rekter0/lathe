import { createServer, type Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  LatheMcpClient,
  type McpApprovalRequest,
  type McpServerProfile,
  type McpTraceEvent,
} from "../src/index.js";
import { createFixtureServer, FIXTURE_RESOURCE_URI } from "./fixtures/fixture-server.mjs";

type TransportKind = "stdio" | "streamableHttp";

interface ConnectedFixture {
  client: LatheMcpClient;
  secret: string;
  approvals: McpApprovalRequest[];
  traces: McpTraceEvent[];
  denyNext(): void;
  observedAuthorization(): string | undefined;
  close(): Promise<void>;
}

const openFixtures: ConnectedFixture[] = [];

afterEach(async () => {
  await Promise.allSettled(openFixtures.splice(0).map((fixture) => fixture.close()));
});

async function connectFixture(kind: TransportKind, redactionEnabled = true): Promise<ConnectedFixture> {
  const secret = `fixture-secret-${kind}`;
  const traces: McpTraceEvent[] = [];
  const approvals: McpApprovalRequest[] = [];
  let shouldDeny = false;
  let httpServer: HttpServer | undefined;
  let httpFixture: ReturnType<typeof createFixtureServer> | undefined;
  let authorization: string | undefined;

  let profile: McpServerProfile;
  if (kind === "stdio") {
    profile = {
      id: "stdio-fixture",
      revision: "rev-1",
      name: "SDK stdio fixture",
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url))],
        env: {
          FIXTURE_SECRET: { kind: "secret", secretId: "fixture-secret" },
        },
      },
    };
  } else {
    httpFixture = createFixtureServer(secret);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await httpFixture.server.connect(transport);
    httpServer = createServer((request, response) => {
      authorization = request.headers.authorization;
      if (authorization !== `Bearer ${secret}`) {
        response.writeHead(401).end("unauthorized");
        return;
      }
      void transport.handleRequest(request, response).catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500);
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer?.once("error", reject);
      httpServer?.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Fixture HTTP server has no port");
    profile = {
      id: "http-fixture",
      revision: "rev-1",
      name: "SDK Streamable HTTP fixture",
      transport: {
        kind: "streamableHttp",
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: {
          Authorization: {
            kind: "secret",
            secretId: "fixture-secret",
            prefix: "Bearer ",
          },
        },
      },
    };
  }

  const client = await LatheMcpClient.connect({
    profile,
    resolveSecret: async (id) => (id === "fixture-secret" ? secret : undefined),
    approvals: {
      async requestApproval(request) {
        approvals.push(structuredClone(request));
        if (shouldDeny) {
          shouldDeny = false;
          return { outcome: "denied", reason: "fixture denial" };
        }
        return { outcome: "approved" };
      },
    },
    trace: {
      record(event) {
        traces.push(structuredClone(event));
      },
    },
    redactionEnabled,
  });

  let closed = false;
  const connected: ConnectedFixture = {
    client,
    secret,
    approvals,
    traces,
    denyNext() {
      shouldDeny = true;
    },
    observedAuthorization() {
      return authorization;
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close().catch(() => undefined);
      await httpFixture?.server.close().catch(() => undefined);
      httpFixture?.cleanup();
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
      }
    },
  };
  openFixtures.push(connected);
  return connected;
}

describe.each<TransportKind>(["stdio", "streamableHttp"])(
  "Lathe MCP client over %s",
  (kind) => {
    it("preserves sensitive-looking approval data when heuristic redaction is disabled", async () => {
      const fixture = await connectFixture(kind, false);
      await fixture.client.callTool({
        toolRevisionHash: "tool-rev-raw",
        name: "inspect-secret",
        arguments: {
          value: fixture.secret,
          password: "test-only-password",
          note: "Bearer fake-red-team-token"
        }
      });

      expect(fixture.approvals[0]?.payload).toMatchObject({
        arguments: {
          value: "[REDACTED]",
          password: "test-only-password",
          note: "Bearer fake-red-team-token"
        }
      });
      expect(JSON.stringify(fixture.traces)).not.toContain(fixture.secret);

      const capabilities = await fixture.client.captureCapabilities();
      expect(capabilities.tools[0]?.inputSchema).toMatchObject({
        properties: { password: { type: "string", description: "Synthetic red-team field" } }
      });
      expect(capabilities.prompts[0]?.arguments).toContainEqual({
        name: "password",
        description: "Synthetic red-team field"
      });
      expect(JSON.stringify(capabilities)).not.toContain(fixture.secret);
    });

    it("negotiates capabilities and performs explicitly approved, redacted operations", async () => {
      const fixture = await connectFixture(kind);

      const snapshot = await fixture.client.captureCapabilities();
      expect(snapshot.protocolVersion).toMatch(/^2025-/);
      expect(snapshot.tools.map((tool) => tool.name)).toEqual(["inspect-secret"]);
      expect(snapshot.prompts.map((prompt) => prompt.name)).toEqual(["audit-template"]);
      expect(snapshot.resources.map((resource) => resource.uri)).toEqual([FIXTURE_RESOURCE_URI]);
      expect(snapshot.resourceTemplates).toHaveLength(1);
      expect(snapshot.declared).toMatchObject({ tasks: { requests: { tools: { call: {} } } } });

      const prompts = await fixture.client.listPrompts();
      const resources = await fixture.client.listResources();
      const templates = await fixture.client.listResourceTemplates();
      const prompt = await fixture.client.getPrompt("audit-template");
      const resource = await fixture.client.readResource(FIXTURE_RESOURCE_URI);
      for (const value of [snapshot, prompts, resources, templates, prompt, resource]) {
        expect(JSON.stringify(value)).not.toContain(fixture.secret);
      }
      expect(JSON.stringify(prompt)).toContain("[REDACTED]");
      expect(JSON.stringify(resource)).toContain("[REDACTED]");

      const result = await fixture.client.callTool({
        sessionId: "session-1",
        toolRevisionHash: "tool-rev-1",
        name: "inspect-secret",
        arguments: { value: fixture.secret },
      });
      const resultText = (result as { content: Array<{ text: string }> }).content[0]?.text;
      expect(resultText).toContain('"matched":true');
      expect(resultText).toContain("[REDACTED]");
      expect(resultText).not.toContain(fixture.secret);

      expect(fixture.approvals).toHaveLength(1);
      expect(fixture.approvals[0]).toMatchObject({
        kind: "toolCall",
        sessionId: "session-1",
        toolName: "inspect-secret",
        toolRevisionHash: "tool-rev-1",
        payload: {
          name: "inspect-secret",
          arguments: { value: "[REDACTED]" },
        },
      });

      fixture.denyNext();
      await expect(
        fixture.client.callTool({
          toolRevisionHash: "tool-rev-1",
          name: "inspect-secret",
          arguments: { value: "not-authorized" },
        }),
      ).rejects.toThrow("fixture denial");
      expect(fixture.approvals).toHaveLength(2);

      const taskMessages = [];
      for await (const message of fixture.client.callToolTask({
        toolRevisionHash: "tool-rev-1",
        name: "inspect-secret",
        arguments: { value: fixture.secret },
        ttlMs: 5_000,
        pollIntervalMs: 1,
      })) {
        taskMessages.push(message);
      }
      expect(taskMessages.some((message) => (message as { type?: string }).type === "taskCreated")).toBe(true);
      expect(taskMessages.some((message) => (message as { type?: string }).type === "result")).toBe(true);
      expect(JSON.stringify(taskMessages)).toContain('\\"matched\\":true');
      expect(JSON.stringify(taskMessages)).not.toContain(fixture.secret);

      const listedTasks = await fixture.client.listTasks();
      const task = (listedTasks as { tasks: Array<{ taskId: string; status: string }> }).tasks[0];
      expect(task).toMatchObject({ status: "completed" });
      if (!task) throw new Error("Expected fixture task");
      expect(await fixture.client.getTask(task.taskId)).toMatchObject({ status: "completed" });
      expect(JSON.stringify(await fixture.client.getToolTaskResult(task.taskId))).not.toContain(
        fixture.secret,
      );

      await new Promise((resolve) => setImmediate(resolve));
      const serializedTraces = JSON.stringify(fixture.traces);
      expect(serializedTraces).not.toContain(fixture.secret);
      expect(fixture.traces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "connect.ready" }),
          expect.objectContaining({ event: "approval.requested", method: "toolCall" }),
          expect.objectContaining({ event: "approval.resolved", method: "toolCall" }),
          expect.objectContaining({ event: "transport.message", direction: "outbound" }),
          expect.objectContaining({ event: "transport.message", direction: "inbound" }),
        ]),
      );
      if (kind === "stdio") {
        expect(fixture.traces).toContainEqual(
          expect.objectContaining({ event: "stdio.stderr", payload: expect.stringContaining("[REDACTED]") }),
        );
      } else {
        expect(fixture.observedAuthorization()).toBe(`Bearer ${fixture.secret}`);
      }
    }, 20_000);
  },
);
