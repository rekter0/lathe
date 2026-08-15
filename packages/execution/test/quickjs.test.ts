import { describe, expect, it } from "vitest";

import {
  evaluateBuildHandler,
  evaluateHandlerInQuickJs,
  HandlerEvaluationError,
  QuickJsWorkerHandlerEvaluator,
} from "../src/handler/index.js";

const source = `
  function build(input) {
    return {
      program: "/usr/bin/printf",
      args: ["%s", input.text],
      timeoutMs: 1234
    };
  }
  function formatResult(result) {
    return { output: result.stdout.text, exitCode: result.exitCode };
  }
`;

describe("QuickJS handler runtime", () => {
  it("evaluates a synchronous build handler and validates its request", async () => {
    await expect(
      evaluateBuildHandler(source, { text: "hello" }),
    ).resolves.toMatchObject({
      program: "/usr/bin/printf",
      args: ["%s", "hello"],
      timeoutMs: 1234,
    });
  });

  it("supports CommonJS exports and formatResult", async () => {
    await expect(
      evaluateHandlerInQuickJs(
        {
          source: `exports.formatResult = (value) => ({ seen: value.code });`,
          method: "formatResult",
          input: { code: 7 },
        },
        { cpuTimeMs: 500 },
      ),
    ).resolves.toEqual({ seen: 7 });
  });

  it("does not inject Node process or require globals", async () => {
    await expect(
      evaluateHandlerInQuickJs({
        source: `function build() { return { process: typeof process, require: typeof require, fetch: typeof fetch }; }`,
        method: "build",
        input: null,
      }),
    ).resolves.toEqual({ process: "undefined", require: "undefined", fetch: "undefined" });
  });

  it("interrupts an infinite loop", async () => {
    await expect(
      evaluateHandlerInQuickJs(
        {
          source: `function build() { while (true) {} }`,
          method: "build",
          input: null,
        },
        { cpuTimeMs: 25 },
      ),
    ).rejects.toMatchObject<Partial<HandlerEvaluationError>>({ code: "timeout" });
  });

  it("rejects oversized serialized results", async () => {
    await expect(evaluateHandlerInQuickJs({
      source: `function formatResult() { return { value: "x".repeat(4096) }; }`,
      method: "formatResult",
      input: null,
    }, { maximumOutputBytes: 128 }))
      .rejects.toMatchObject<Partial<HandlerEvaluationError>>({ code: "output_too_large" });
  });

  it("captures handler exceptions without crossing the sandbox boundary", async () => {
    await expect(evaluateHandlerInQuickJs({
      source: `function build() { throw new Error("synthetic failure"); }`,
      method: "build",
      input: null,
    })).rejects.toMatchObject<Partial<HandlerEvaluationError>>({ code: "evaluation_error" });
  });

  it("contains oversized allocations within the QuickJS memory budget", async () => {
    await expect(evaluateHandlerInQuickJs({
      source: `function build() { const values = []; while (true) values.push("x".repeat(4096)); }`,
      method: "build",
      input: null,
    }, { memoryBytes: 1024 * 1024, stackBytes: 64 * 1024, cpuTimeMs: 1_000 }))
      .rejects.toSatisfy((error: HandlerEvaluationError) => ["evaluation_error", "timeout"].includes(error.code));
  });

  it("reports a disposable worker crash", async () => {
    const evaluator = new QuickJsWorkerHandlerEvaluator({ workerUrl: new URL("./fixtures/crash-worker.mjs", import.meta.url) });
    await expect(evaluator.evaluate({ source: source, method: "build", input: { text: "x" } }))
      .rejects.toMatchObject<Partial<HandlerEvaluationError>>({ code: "worker_error" });
  });
});
