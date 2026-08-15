import type { JsonValue } from "@lathe/domain";

import type { ExecutionRequest, ExecutionResult } from "../types.js";

export type HandlerMethod = "build" | "formatResult";

export interface HandlerInvocation {
  /**
   * CommonJS-style source. It may assign `module.exports`/`exports`, or declare
   * top-level synchronous `build` and `formatResult` functions.
   */
  readonly source: string;
  readonly method: HandlerMethod;
  readonly input: JsonValue;
  readonly filename?: string;
}

export interface QuickJsHandlerLimits {
  readonly cpuTimeMs: number;
  readonly memoryBytes: number;
  readonly stackBytes: number;
  readonly maximumSourceBytes: number;
  readonly maximumInputBytes: number;
  readonly maximumOutputBytes: number;
  /** Includes worker startup and WASM initialization, unlike cpuTimeMs. */
  readonly wallClockTimeMs: number;
}

export const DEFAULT_QUICKJS_HANDLER_LIMITS: QuickJsHandlerLimits =
  Object.freeze({
    cpuTimeMs: 250,
    memoryBytes: 32 * 1024 * 1024,
    stackBytes: 512 * 1024,
    maximumSourceBytes: 256 * 1024,
    maximumInputBytes: 1024 * 1024,
    maximumOutputBytes: 1024 * 1024,
    wallClockTimeMs: 10_000,
  });

export type HandlerEvaluationErrorCode =
  | "invalid_limits"
  | "source_too_large"
  | "input_too_large"
  | "output_too_large"
  | "timeout"
  | "cancelled"
  | "contract_error"
  | "evaluation_error"
  | "worker_error";

export class HandlerEvaluationError extends Error {
  override readonly name = "HandlerEvaluationError";

  constructor(
    readonly code: HandlerEvaluationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface HandlerEvaluator {
  evaluate(
    invocation: HandlerInvocation,
    options?: HandlerEvaluationOptions,
  ): Promise<JsonValue>;
}

export interface HandlerEvaluationOptions {
  readonly limits?: Partial<QuickJsHandlerLimits>;
  readonly signal?: AbortSignal;
}

export interface SerializableExecutionResult
  extends Omit<ExecutionResult, "signal"> {
  readonly signal: string | null;
}

export interface RealToolHandler {
  build(input: JsonValue): ExecutionRequest;
  formatResult(input: SerializableExecutionResult): JsonValue;
}

export function serializableExecutionResult(
  result: ExecutionResult,
): SerializableExecutionResult {
  return { ...result, signal: result.signal };
}
