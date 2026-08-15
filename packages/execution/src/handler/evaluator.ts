import { Worker } from "node:worker_threads";

import type { JsonValue } from "@lathe/domain";

import type { ExecutionRequest } from "../types.js";
import { normalizeExecutionRequest } from "../validation.js";
import {
  HandlerEvaluationError,
  type HandlerEvaluationOptions,
  type HandlerEvaluator,
  type HandlerInvocation,
} from "./types.js";
import { resolveQuickJsHandlerLimits } from "./quickjs-runtime.js";
import type {
  HandlerWorkerRequest,
  HandlerWorkerResponse,
} from "./worker-protocol.js";

export interface QuickJsWorkerEvaluatorOptions {
  /** Override for source runners/tests; production defaults to compiled worker. */
  readonly workerUrl?: URL;
}

/**
 * Creates a new Node worker and a new QuickJS/Wasm runtime for every phase.
 * Terminating the worker remains an outer safety boundary if QuickJS itself
 * crashes or cannot service its interrupt handler.
 */
export class QuickJsWorkerHandlerEvaluator implements HandlerEvaluator {
  readonly #workerUrl: URL;

  constructor(options: QuickJsWorkerEvaluatorOptions = {}) {
    this.#workerUrl =
      options.workerUrl ?? new URL("./quickjs-worker.js", import.meta.url);
  }

  async evaluate(
    invocation: HandlerInvocation,
    options: HandlerEvaluationOptions = {},
  ): Promise<JsonValue> {
    const limits = resolveQuickJsHandlerLimits(options.limits);
    if (options.signal?.aborted === true) {
      throw new HandlerEvaluationError("cancelled", "Handler evaluation cancelled");
    }

    const request: HandlerWorkerRequest = { invocation, limits };
    const worker = new Worker(this.#workerUrl, {
      workerData: request,
      resourceLimits: {
        maxOldGenerationSizeMb: Math.max(
          16,
          Math.ceil(limits.memoryBytes / (1024 * 1024)) + 16,
        ),
        stackSizeMb: 4,
      },
    });

    return await new Promise<JsonValue>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const settle = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        operation();
      };

      const abort = (): void => {
        void worker.terminate();
        settle(() =>
          reject(
            new HandlerEvaluationError(
              "cancelled",
              "Handler evaluation cancelled",
            ),
          ),
        );
      };
      timer = setTimeout(() => {
        void worker.terminate();
        settle(() =>
          reject(
            new HandlerEvaluationError(
              "timeout",
              `Handler worker exceeded ${limits.wallClockTimeMs}ms wall-clock budget`,
            ),
          ),
        );
      }, limits.wallClockTimeMs);
      timer.unref();
      options.signal?.addEventListener("abort", abort, { once: true });

      worker.once("message", (message: HandlerWorkerResponse) => {
        void worker.terminate();
        if (message.ok) {
          settle(() => resolve(message.value));
        } else {
          settle(() =>
            reject(
              new HandlerEvaluationError(
                message.error.code,
                message.error.message,
              ),
            ),
          );
        }
      });
      worker.once("error", (error) => {
        settle(() =>
          reject(
            new HandlerEvaluationError(
              "worker_error",
              "Handler worker failed",
              { cause: error },
            ),
          ),
        );
      });
      worker.once("exit", (code) => {
        settle(() =>
          reject(
            new HandlerEvaluationError(
              "worker_error",
              `Handler worker exited without a result (code ${code})`,
            ),
          ),
        );
      });
    });
  }

  async build(
    source: string,
    input: JsonValue,
    options?: HandlerEvaluationOptions,
  ): Promise<ExecutionRequest> {
    const value = await this.evaluate(
      { source, input, method: "build" },
      options,
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

  async formatResult(
    source: string,
    input: JsonValue,
    options?: HandlerEvaluationOptions,
  ): Promise<JsonValue> {
    return await this.evaluate(
      { source, input, method: "formatResult" },
      options,
    );
  }
}
