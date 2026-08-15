import { parentPort, workerData } from "node:worker_threads";

import { evaluateHandlerInQuickJs } from "./quickjs-runtime.js";
import {
  HandlerEvaluationError,
  type HandlerEvaluationErrorCode,
} from "./types.js";
import type {
  HandlerWorkerRequest,
  HandlerWorkerResponse,
} from "./worker-protocol.js";

function failure(error: unknown): HandlerWorkerResponse {
  const known = error instanceof HandlerEvaluationError;
  const code: HandlerEvaluationErrorCode = known
    ? error.code
    : "worker_error";
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  return {
    ok: false,
    error: { code, message, ...(stack === undefined ? {} : { stack }) },
  };
}

async function main(): Promise<void> {
  if (parentPort === null) throw new Error("QuickJS worker requires a parent port");
  const request = workerData as HandlerWorkerRequest;
  try {
    const value = await evaluateHandlerInQuickJs(
      request.invocation,
      request.limits,
    );
    const response: HandlerWorkerResponse = { ok: true, value };
    parentPort.postMessage(response);
  } catch (error) {
    parentPort.postMessage(failure(error));
  }
}

await main();
