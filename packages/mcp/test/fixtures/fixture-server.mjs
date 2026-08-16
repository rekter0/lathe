import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTaskMessageQueue, InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const FIXTURE_RESOURCE_URI = "fixture://reports/current";

/**
 * An official-SDK fixture with every capability Lathe consumes. Keeping the
 * protocol implementation in one place ensures stdio and HTTP exercise the
 * same server behavior rather than transport-specific mocks.
 */
export function createFixtureServer(secret) {
  const taskStore = new InMemoryTaskStore();
  const server = new Server(
    { name: "lathe-mcp-fixture", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
      },
      instructions: `Fixture instructions contain ${secret}`,
      taskStore,
      taskMessageQueue: new InMemoryTaskMessageQueue(),
      defaultTaskPollInterval: 1,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "inspect-secret",
        description: `Checks a value against ${secret}`,
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
            password: { type: "string", description: "Synthetic red-team field" },
          },
          additionalProperties: false,
        },
        execution: { taskSupport: "optional" },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const supplied = request.params.arguments?.value;
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ matched: supplied === secret, revealed: secret }),
        },
      ],
    };

    if (request.params.task) {
      const task = await extra.taskStore.createTask({
        ttl: request.params.task.ttl,
        pollInterval: request.params.task.pollInterval ?? 1,
      });
      setTimeout(() => {
        void extra.taskStore.storeTaskResult(task.taskId, "completed", result);
      }, 5);
      return { task };
    }

    return result;
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "audit-template",
        description: `Prompt metadata contains ${secret}`,
        arguments: [{ name: "password", description: "Synthetic red-team field" }],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async () => ({
    description: "Fixture audit prompt",
    messages: [
      {
        role: "user",
        content: { type: "text", text: `Inspect ${secret} safely` },
      },
    ],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: FIXTURE_RESOURCE_URI,
        name: "current-report",
        description: `Resource metadata contains ${secret}`,
        mimeType: "text/plain",
      },
    ],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: "fixture://reports/{id}",
        name: "report-template",
        description: `Template metadata contains ${secret}`,
        mimeType: "text/plain",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
    contents: [
      {
        uri: request.params.uri,
        mimeType: "text/plain",
        text: `Report body contains ${secret}`,
      },
    ],
  }));

  return {
    server,
    cleanup() {
      taskStore.cleanup();
    },
  };
}
