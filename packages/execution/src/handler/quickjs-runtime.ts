import type { JsonValue } from "@lathe/domain";
import { getQuickJS } from "quickjs-emscripten";

import type { ExecutionRequest } from "../types.js";
import { normalizeExecutionRequest } from "../validation.js";
import {
  DEFAULT_QUICKJS_HANDLER_LIMITS,
  HandlerEvaluationError,
  type HandlerInvocation,
  type QuickJsHandlerLimits,
} from "./types.js";

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new HandlerEvaluationError(
      "invalid_limits",
      `${field} must be a positive integer`,
    );
  }
}

export function resolveQuickJsHandlerLimits(
  overrides: Partial<QuickJsHandlerLimits> | undefined,
): QuickJsHandlerLimits {
  const limits = { ...DEFAULT_QUICKJS_HANDLER_LIMITS, ...overrides };
  for (const [field, value] of Object.entries(limits)) {
    positiveInteger(value, field);
  }
  if (limits.stackBytes >= limits.memoryBytes) {
    throw new HandlerEvaluationError(
      "invalid_limits",
      "stackBytes must be smaller than memoryBytes",
    );
  }
  return Object.freeze(limits);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function evaluationProgram(invocation: HandlerInvocation, inputJson: string): string {
  // Both strings enter the program as JSON string literals, so handler source
  // and input cannot escape the wrapper through host-side interpolation.
  const inputLiteral = JSON.stringify(inputJson);
  const methodLiteral = JSON.stringify(invocation.method);
  const factoryBody = `
    "use strict";
    ${invocation.source}
    return {
      build: typeof build === "function" ? build : undefined,
      formatResult: typeof formatResult === "function" ? formatResult : undefined
    };
  `;
  const factoryBodyLiteral = JSON.stringify(factoryBody);
  return `(() => {
    "use strict";
    const __inputJson = ${inputLiteral};
    const __method = ${methodLiteral};
    const __module = { exports: {} };
    const __factory = new Function("module", "exports", ${factoryBodyLiteral});
    const __locals = __factory(__module, __module.exports);
    const __exported = __module.exports;
    const __handler =
      __exported && typeof __exported[__method] === "function"
        ? __exported
        : __locals;
    const __fn = __handler && __handler[__method];
    if (typeof __fn !== "function") {
      throw new TypeError("Handler must expose a synchronous " + __method + " function");
    }
    const __value = __fn.call(__handler, JSON.parse(__inputJson));
    if (__value && typeof __value.then === "function") {
      throw new TypeError("Handler functions must be synchronous");
    }
    const __serialized = JSON.stringify(__value);
    if (__serialized === undefined) {
      throw new TypeError("Handler result must be JSON-serializable");
    }
    return __serialized;
  })()`;
}

function errorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "Error";
    const message =
      typeof record.message === "string" ? record.message : JSON.stringify(value);
    const stack = typeof record.stack === "string" ? `\n${record.stack}` : "";
    return `${name}: ${message}${stack}`;
  }
  return String(value);
}

/**
 * Low-level evaluator used only inside the disposable worker in production.
 * Exported separately so the sandbox contract can be unit-tested without
 * depending on a compiled worker entry path.
 */
export async function evaluateHandlerInQuickJs(
  invocation: HandlerInvocation,
  limitOverrides?: Partial<QuickJsHandlerLimits>,
): Promise<JsonValue> {
  const limits = resolveQuickJsHandlerLimits(limitOverrides);
  if (byteLength(invocation.source) > limits.maximumSourceBytes) {
    throw new HandlerEvaluationError(
      "source_too_large",
      `Handler source exceeds ${limits.maximumSourceBytes} bytes`,
    );
  }

  let inputJson: string;
  try {
    inputJson = JSON.stringify(invocation.input);
  } catch (error) {
    throw new HandlerEvaluationError(
      "contract_error",
      "Handler input must be JSON-serializable",
      { cause: error },
    );
  }
  if (byteLength(inputJson) > limits.maximumInputBytes) {
    throw new HandlerEvaluationError(
      "input_too_large",
      `Handler input exceeds ${limits.maximumInputBytes} bytes`,
    );
  }

  const QuickJS = await getQuickJS();
  const context = QuickJS.newContext();
  const deadline = performance.now() + limits.cpuTimeMs;
  let interrupted = false;
  context.runtime.setMemoryLimit(limits.memoryBytes);
  context.runtime.setMaxStackSize(limits.stackBytes);
  context.runtime.setInterruptHandler(() => {
    interrupted = performance.now() >= deadline;
    return interrupted;
  });

  try {
    const evaluated = context.evalCode(evaluationProgram(invocation, inputJson));
    if (evaluated.error) {
      let dumped: unknown;
      try {
        dumped = context.dump(evaluated.error);
      } finally {
        evaluated.error.dispose();
      }
      throw new HandlerEvaluationError(
        interrupted ? "timeout" : "evaluation_error",
        interrupted
          ? `Handler exceeded ${limits.cpuTimeMs}ms CPU budget`
          : errorMessage(dumped),
      );
    }

    let serialized: unknown;
    try {
      serialized = context.dump(evaluated.value);
    } finally {
      evaluated.value.dispose();
    }
    if (typeof serialized !== "string") {
      throw new HandlerEvaluationError(
        "contract_error",
        "Handler did not produce serialized JSON",
      );
    }
    if (byteLength(serialized) > limits.maximumOutputBytes) {
      throw new HandlerEvaluationError(
        "output_too_large",
        `Handler output exceeds ${limits.maximumOutputBytes} bytes`,
      );
    }

    try {
      return JSON.parse(serialized) as JsonValue;
    } catch (error) {
      throw new HandlerEvaluationError(
        "contract_error",
        "Handler returned invalid JSON",
        { cause: error },
      );
    }
  } catch (error) {
    if (error instanceof HandlerEvaluationError) throw error;
    throw new HandlerEvaluationError(
      interrupted ? "timeout" : "evaluation_error",
      interrupted
        ? `Handler exceeded ${limits.cpuTimeMs}ms CPU budget`
        : errorMessage(error),
      { cause: error },
    );
  } finally {
    context.dispose();
  }
}

export async function evaluateBuildHandler(
  source: string,
  input: JsonValue,
  limits?: Partial<QuickJsHandlerLimits>,
): Promise<ExecutionRequest> {
  const value = await evaluateHandlerInQuickJs(
    { source, input, method: "build" },
    limits,
  );
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new HandlerEvaluationError(
      "contract_error",
      "build must return an ExecutionRequest object",
    );
  }
  try {
    return normalizeExecutionRequest(value as unknown as ExecutionRequest);
  } catch (error) {
    throw new HandlerEvaluationError(
      "contract_error",
      "build returned an invalid ExecutionRequest",
      { cause: error },
    );
  }
}
