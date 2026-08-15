import { describe, expect, it } from "vitest";

import {
  InvalidExecutionRequestError,
  normalizeExecutionRequest,
} from "../src/validation.js";

describe("execution request validation", () => {
  it("normalizes defaults and freezes nested command values", () => {
    const request = normalizeExecutionRequest({ program: "printf" });
    expect(request.args).toEqual([]);
    expect(request.timeoutMs).toBe(60_000);
    expect(request.maxOutputBytes).toBe(10 * 1024 * 1024);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.args)).toBe(true);
  });

  it.each([
    { program: "" },
    { program: "x\0y" },
    { program: "x", environment: { "BAD-NAME": "value" } },
    { program: "x", timeoutMs: 0 },
    { program: "x", timeoutMs: 15 * 60_000 + 1 },
    { program: "x", maxOutputBytes: 100 * 1024 * 1024 + 1 },
  ])("rejects an unsafe request: %j", (request) => {
    expect(() => normalizeExecutionRequest(request)).toThrow(
      InvalidExecutionRequestError,
    );
  });
});
