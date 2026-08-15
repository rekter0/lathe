import { describe, expect, it, vi } from "vitest";
import {
  discoverProviderModels,
  executeProviderRequest,
  redactJson,
  redactUrl,
} from "../src/index.js";
import type {
  CanonicalGenerationRequest,
  ModelCapabilities,
  ProviderProfile,
  ProviderStreamItem,
} from "../src/index.js";

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  images: false,
  files: false,
  jsonMode: false,
  maxContextTokens: null,
};

const profile: ProviderProfile = {
  id: "provider-1",
  label: "Gateway",
  protocol: "openai-chat",
  baseUrl: "https://gateway.example/v1",
  credential: "super-secret-key",
  headers: { "x-tenant-proof": "another-secret" },
  extraBody: {},
  models: [{ id: "manual-model", label: "Manual", capabilities, discovered: false }],
};

const request: CanonicalGenerationRequest = {
  model: "manual-model",
  messages: [{ role: "user", content: "hello" }],
};

async function collect(stream: AsyncIterable<ProviderStreamItem>): Promise<ProviderStreamItem[]> {
  const values: ProviderStreamItem[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("provider HTTP client", () => {
  it("streams normalized deltas, retains raw frames, redacts secrets, and makes one attempt", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"id":"r1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const values = await collect(
      executeProviderRequest(profile, request, { fetch: fetchMock as unknown as typeof fetch }),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(values.flatMap((value) => value.events)).toContainEqual({
      type: "content.delta",
      text: "hi",
      index: 0,
    });
    expect(values.flatMap((value) => value.events)).toContainEqual({ type: "response.completed" });
    expect(values.find((value) => value.trace.kind === "sse")?.trace.data).toMatchObject({
      raw: expect.stringContaining('"choices"'),
    });
    const serialized = JSON.stringify(values);
    expect(serialized).not.toContain("super-secret-key");
    expect(serialized).not.toContain("another-secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it("recognizes an OpenRouter-style midstream error after HTTP 200", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(['data: {"error":{"code":429,"message":"rate limit reached"}}\n\n']),
    );
    const values = await collect(
      executeProviderRequest(profile, request, { fetch: fetchMock as unknown as typeof fetch }),
    );
    expect(values.flatMap((value) => value.events)).toContainEqual(
      expect.objectContaining({
        type: "provider.error",
        error: expect.objectContaining({ classification: "rate-limit" }),
      }),
    );
  });

  it("classifies non-streaming HTTP failures without retrying", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "bad credential", type: "authentication_error" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const values = await collect(
      executeProviderRequest(profile, request, { fetch: fetchMock as unknown as typeof fetch }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(values.at(-1)?.events[0]).toMatchObject({
      type: "provider.error",
      error: { classification: "authentication", status: 401, retryable: false },
    });
  });

  it("classifies malformed and interrupted successful streams", async () => {
    const malformed = await collect(executeProviderRequest(profile, request, {
      fetch: (async () => sseResponse(["data: {not-json}\n\n"])) as typeof fetch,
    }));
    expect(malformed.flatMap((value) => value.events)).toContainEqual(expect.objectContaining({
      type: "provider.error",
      error: expect.objectContaining({ classification: "parse-failure" }),
    }));

    const interrupted = await collect(executeProviderRequest(profile, request, {
      fetch: (async () => sseResponse(['data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'])) as typeof fetch,
    }));
    expect(interrupted.flatMap((value) => value.events).at(-1)).toMatchObject({
      type: "provider.error",
      error: { classification: "interrupted-stream" },
    });
  });

  it("retains unknown event types as traceable normalized evidence", async () => {
    const unknown = await collect(executeProviderRequest({ ...profile, protocol: "openai-responses" }, request, {
      fetch: (async () => sseResponse([
        'event: response.future_event\ndata: {"type":"response.future_event","payload":{"value":1}}\n\n',
        "data: [DONE]\n\n",
      ])) as typeof fetch,
    }));
    expect(unknown.flatMap((value) => value.events)).toContainEqual({
      type: "provider.unknown",
      providerType: "response.future_event",
    });
    expect(JSON.stringify(unknown)).toContain("future_event");
  });

  it("classifies operator cancellation without retrying", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted === true) {
        reject(new DOMException("cancelled", "AbortError"));
        return;
      }
      init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));
    const collecting = collect(executeProviderRequest(profile, request, {
      fetch: fetchMock as unknown as typeof fetch,
      signal: controller.signal,
    }));
    controller.abort();
    const values = await collecting;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(values.flatMap((value) => value.events).at(-1)).toMatchObject({
      type: "provider.error",
      error: { classification: "cancelled" },
    });
  });
});

describe("model discovery and redaction", () => {
  it("merges discovered models with operator-maintained entries", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "remote-model", owned_by: "vendor" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await discoverProviderModels(profile, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result.warnings).toEqual([]);
    expect(result.models.map((model) => [model.id, model.source])).toEqual([
      ["manual-model", "manual"],
      ["remote-model", "discovered"],
    ]);
  });

  it("redacts nested credential-shaped fields", () => {
    expect(redactJson({ headers: { authorization: "Bearer x", okay: true } })).toEqual({
      headers: { authorization: "[REDACTED]", okay: true },
    });
    const url = redactUrl("https://operator:password@gateway.example/v1?api_key=query-secret");
    expect(url).not.toContain("operator");
    expect(url).not.toContain("password");
    expect(url).not.toContain("query-secret");
  });
});
