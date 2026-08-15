import type { JsonValue } from "@lathe/domain";

import type {
  HandlerEvaluationErrorCode,
  HandlerInvocation,
  QuickJsHandlerLimits,
} from "./types.js";

export interface HandlerWorkerRequest {
  readonly invocation: HandlerInvocation;
  readonly limits: QuickJsHandlerLimits;
}

export type HandlerWorkerResponse =
  | { readonly ok: true; readonly value: JsonValue }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: HandlerEvaluationErrorCode;
        readonly message: string;
        readonly stack?: string;
      };
    };
