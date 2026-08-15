import { describe, expect, it } from "vitest";
import {
  anthropicMessagesAdapter,
  classifyProviderError,
  executeProviderRequest,
  openAiChatAdapter,
  openAiResponsesAdapter,
  type CanonicalGenerationRequest,
  type NormalizedProviderEvent,
  type ProviderProfile,
  type ProviderStreamItem,
  type ServerSentEvent,
} from "../src/index.js";

const request: CanonicalGenerationRequest = {
  model: "anthropic/claude-fable-5",
  messages: [{ role: "user", content: "test" }],
  stream: true,
};

const profile: ProviderProfile = {
  id: "openrouter",
  label: "OpenRouter",
  protocol: "openai-chat",
  baseUrl: "https://openrouter.ai/api/v1",
  credential: "fixture-secret",
};

function frame(data: unknown, event?: string): ServerSentEvent {
  const serialized = typeof data === "string" ? data : JSON.stringify(data);
  return {
    data: serialized,
    raw: `${event ? `event: ${event}\n` : ""}data: ${serialized}\n\n`,
    ...(event === undefined ? {} : { event }),
  };
}

function sseResponse(frames: readonly ServerSentEvent[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const item of frames) controller.enqueue(encoder.encode(item.raw));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collectEvents(frames: readonly ServerSentEvent[]): Promise<NormalizedProviderEvent[]> {
  const items: ProviderStreamItem[] = [];
  for await (const item of executeProviderRequest(profile, request, {
    fetch: (async () => sseResponse(frames)) as typeof fetch,
  })) items.push(item);
  return items.flatMap((item) => item.events);
}

describe("provider refusal and policy normalization", () => {
  it("normalizes the OpenRouter Fable refusal shape without losing native finish evidence", async () => {
    const events = await collectEvents([
      frame({
        id: "generation-1",
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "", refusal: "Blocked under Anthropic's Usage Policy." },
          finish_reason: null,
          native_finish_reason: null,
        }],
      }),
      frame({
        id: "generation-1",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "content_filter", native_finish_reason: "refusal" }],
      }),
      frame("[DONE]"),
    ]);

    expect(events).toContainEqual({ type: "refusal.delta", text: "Blocked under Anthropic's Usage Policy.", index: 0 });
    expect(events).toContainEqual({ type: "response.completed", finishReason: "content_filter", nativeFinishReason: "refusal" });
    expect(events.filter((event) => event.type === "response.completed")).toHaveLength(2);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "provider.error", error: expect.objectContaining({ classification: "interrupted-stream" }) }));
  });

  it("retains a policy warning, later output, and the final stop as separate ordered events", async () => {
    const events = await collectEvents([
      frame({ choices: [{ index: 0, delta: { refusal: "Primary model declined." }, finish_reason: "content_filter", native_finish_reason: "refusal" }] }),
      frame({ choices: [{ index: 0, delta: { content: "Fallback answer" }, finish_reason: null }] }),
      frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "end_turn" }] }),
      frame("[DONE]"),
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "refusal.delta",
      "response.completed",
      "content.delta",
      "response.completed",
      "response.completed",
    ]);
  });

  it("normalizes OpenRouter reasoning_details when no string alias is present", () => {
    expect(openAiChatAdapter.normalizeSse(frame({
      choices: [{ index: 0, delta: { reasoning_details: [
        { type: "reasoning.summary", summary: "Checked policy scope." },
        { type: "reasoning.text", text: "Then evaluated the request." },
        { type: "reasoning.encrypted", data: "opaque" },
      ] } }],
    }))).toEqual([
      { type: "reasoning.delta", text: "Checked policy scope.", index: 0 },
      { type: "reasoning.delta", text: "Then evaluated the request.", index: 0 },
    ]);
  });

  it("normalizes native Anthropic mid-stream refusal details and partial output", () => {
    const text = anthropicMessagesAdapter.normalizeSse(frame({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial answer" },
    }, "content_block_delta"));
    const stop = anthropicMessagesAdapter.normalizeSse(frame({
      type: "message_delta",
      delta: {
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: "Could enable cyber harm.", classifier_revision: "2026-08" },
      },
      usage: { output_tokens: 12 },
    }, "message_delta"));

    expect(text).toEqual([{ type: "content.delta", text: "partial answer", index: 0 }]);
    expect(stop).toContainEqual(expect.objectContaining({
      type: "response.completed",
      finishReason: "refusal",
      stopDetails: expect.objectContaining({
        type: "refusal",
        category: "cyber",
        explanation: "Could enable cyber harm.",
        providerData: expect.objectContaining({ classifier_revision: "2026-08" }),
      }),
    }));
  });

  it("normalizes Anthropic's in-stream fallback boundary", () => {
    expect(anthropicMessagesAdapter.normalizeSse(frame({
      type: "content_block_start",
      index: 1,
      content_block: { type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
    }, "content_block_start"))).toEqual([{
      type: "response.fallback",
      index: 1,
      fromModel: "claude-fable-5",
      toModel: "claude-opus-4-8",
    }]);
  });

  it("normalizes Responses refusal deltas, completed refusal parts, and incomplete reasons", () => {
    expect(openAiResponsesAdapter.normalizeSse(frame({
      type: "response.refusal.delta",
      output_index: 0,
      delta: "I can't help",
    }, "response.refusal.delta"))).toEqual([{ type: "refusal.delta", text: "I can't help", index: 0 }]);

    const events = openAiResponsesAdapter.normalizeJson({
      id: "resp-1",
      model: "gpt-test",
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      output: [{ type: "message", content: [{ type: "refusal", refusal: "Request blocked." }] }],
    });
    expect(events).toContainEqual({ type: "refusal.done", text: "Request blocked.", index: 0 });
    expect(events).toContainEqual({ type: "response.completed", finishReason: "incomplete", incompleteReason: "content_filter" });
  });

  it("uses OpenRouter's stable metadata.error_type classification", () => {
    expect(classifyProviderError({ payload: {
      error: { message: "Upstream rejected output", metadata: { error_type: "content_policy_violation" } },
    } })).toMatchObject({ classification: "content-policy", retryable: false });
  });

  it("reads OpenRouter error_type from each protocol skin", () => {
    const chat = openAiChatAdapter.normalizeSse(frame({
      error: { code: 429, message: "Rate limited", metadata: { error_type: "rate_limit_exceeded" } },
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
    }));
    const anthropic = anthropicMessagesAdapter.normalizeSse(frame({
      type: "error",
      error: { type: "api_error", message: "Provider overloaded", error_type: "provider_overloaded" },
    }, "error"));
    const responses = openAiResponsesAdapter.normalizeSse(frame({
      type: "response.failed",
      response: {
        id: "resp-1",
        status: "failed",
        error: { code: "server_error", message: "Invalid credentials" },
        error_type: "authentication",
      },
    }, "response.failed"));

    expect(chat).toContainEqual(expect.objectContaining({
      type: "provider.error",
      error: expect.objectContaining({ classification: "rate-limit" }),
    }));
    expect(chat).toContainEqual({ type: "response.completed", finishReason: "error" });
    expect(anthropic).toEqual([expect.objectContaining({
      type: "provider.error",
      error: expect.objectContaining({ classification: "unavailable" }),
    })]);
    expect(responses).toEqual([expect.objectContaining({
      type: "provider.error",
      error: expect.objectContaining({ classification: "authentication" }),
    })]);
  });

  it.each([
    ["authentication", "authentication"],
    ["permission_denied", "authentication"],
    ["payment_required", "authentication"],
    ["rate_limit_exceeded", "rate-limit"],
    ["provider_overloaded", "unavailable"],
    ["provider_unavailable", "unavailable"],
    ["timeout", "timeout"],
    ["context_length_exceeded", "invalid-request"],
    ["max_tokens_exceeded", "invalid-request"],
    ["token_limit_exceeded", "invalid-request"],
    ["string_too_long", "invalid-request"],
    ["invalid_request", "invalid-request"],
    ["invalid_prompt", "invalid-request"],
    ["not_found", "invalid-request"],
    ["precondition_failed", "invalid-request"],
    ["payload_too_large", "invalid-request"],
    ["unprocessable", "invalid-request"],
    ["invalid_image", "invalid-request"],
    ["image_too_large", "invalid-request"],
    ["image_too_small", "invalid-request"],
    ["unsupported_image_format", "invalid-request"],
    ["image_not_found", "invalid-request"],
    ["image_download_failed", "invalid-request"],
    ["content_policy_violation", "content-policy"],
    ["refusal", "content-policy"],
    ["server", "unavailable"],
    ["unmapped", "unavailable"],
  ] as const)("maps OpenRouter error_type %s to %s", (errorType, classification) => {
    expect(classifyProviderError({ payload: {
      error: { message: "Typed provider failure", metadata: { error_type: errorType } },
    } }).classification).toBe(classification);
  });
});
