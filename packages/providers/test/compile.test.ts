import { describe, expect, it } from "vitest";
import {
  anthropicMessagesAdapter,
  openAiChatAdapter,
  openAiResponsesAdapter,
  ProviderCompileError,
} from "../src/index.js";
import type {
  CanonicalGenerationRequest,
  ModelCapabilities,
  ProviderProfile,
  ProviderProtocol,
} from "../src/index.js";

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  images: true,
  files: true,
  jsonMode: false,
  maxContextTokens: null,
};

function profile(protocol: ProviderProtocol, values: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: "provider-1",
    label: "Test",
    protocol,
    baseUrl: "https://gateway.example/v1",
    credential: "top-secret-key",
    headers: {},
    extraBody: {},
    models: [{ id: "model-1", label: "Model 1", capabilities, discovered: false }],
    ...values,
  };
}

const request: CanonicalGenerationRequest = {
  model: "model-1",
  systemPrompt: "Be precise.",
  messages: [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "lookup", arguments: { query: "x" } }],
    },
    { role: "tool", toolCallId: "call-1", content: "result" },
  ],
  tools: [{ name: "lookup", description: "Look something up", inputSchema: { type: "object" } }],
  temperature: 0.2,
  stream: true,
};

describe("provider compilers", () => {
  it("compiles Responses input items and strips a duplicate /v1 prefix", () => {
    const compiled = openAiResponsesAdapter.compile(profile("openai-responses"), request);
    expect(compiled.url).toBe("https://gateway.example/v1/responses");
    expect(compiled.headers.authorization).toBe("Bearer top-secret-key");
    expect(compiled.body).toMatchObject({
      model: "model-1",
      instructions: "Be precise.",
      stream: true,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "function_call", call_id: "call-1", name: "lookup", arguments: '{"query":"x"}' },
        { type: "function_call_output", call_id: "call-1", output: "result" },
      ],
    });
  });

  it("compiles Chat Completions messages and function schema", () => {
    const compiled = openAiChatAdapter.compile(profile("openai-chat"), request);
    expect(compiled.url).toBe("https://gateway.example/v1/chat/completions");
    expect(compiled.body.messages).toMatchObject([
      { role: "system", content: "Be precise." },
      { role: "user", content: "hello" },
      {
        role: "assistant",
        tool_calls: [{ id: "call-1", function: { name: "lookup", arguments: '{"query":"x"}' } }],
      },
      { role: "tool", tool_call_id: "call-1", content: "result" },
    ]);
    expect(compiled.body.tools).toMatchObject([
      { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
    ]);
  });

  it("compiles Anthropic blocks and reports its max_tokens default", () => {
    const compiled = anthropicMessagesAdapter.compile(profile("anthropic-messages"), request);
    expect(compiled.headers["x-api-key"]).toBe("top-secret-key");
    expect(compiled.body).toMatchObject({
      model: "model-1",
      system: "Be precise.",
      max_tokens: 4096,
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "lookup" }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "result" }] },
      ],
    });
    expect(compiled.warnings).toContainEqual(expect.objectContaining({ code: "default-max-tokens" }));
  });

  it("rejects protected core fields from profile and per-run options", () => {
    expect(() =>
      openAiChatAdapter.compile(profile("openai-chat", { extraBody: { messages: [] } }), request),
    ).toThrow(ProviderCompileError);
    expect(() =>
      openAiResponsesAdapter.compile(profile("openai-responses"), {
        ...request,
        extraBody: { stream: false },
      }),
    ).toThrowError(/owned by Lathe/);
  });
});
