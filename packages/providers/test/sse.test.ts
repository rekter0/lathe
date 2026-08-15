import { describe, expect, it } from "vitest";
import { parseSseChunks } from "../src/index.js";

async function* chunks(values: readonly string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const value of values) yield encoder.encode(value);
}

describe("SSE parser", () => {
  it("handles UTF-8 data fragmented across arbitrary chunks", async () => {
    const result = [];
    for await (const event of parseSseChunks(chunks([
      "event: message\r\ndata: {\"text\":\"",
      "hel",
      "lo 👋\"}\r\n",
      "id: 7\r\n\r\n",
      ": heartbeat\n\ndata: [DONE]\n\n",
    ]))) {
      result.push(event);
    }

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      event: "message",
      data: '{"text":"hello 👋"}',
      id: "7",
    });
    expect(result[0]?.raw).toContain("\r\n\r\n");
    expect(result[1]?.data).toBe("[DONE]");
  });

  it("joins repeated data fields and dispatches a final unterminated frame", async () => {
    const result = [];
    for await (const event of parseSseChunks(chunks(["data: first\ndata: second"]))) result.push(event);
    expect(result).toEqual([{ data: "first\nsecond", raw: "data: first\ndata: second" }]);
  });
});
