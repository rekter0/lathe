import type {
  DuplexExecutionRequest,
  ExecutionEnvironment,
  NormalizedExecutionRequest,
} from "../types.js";
import { InvalidExecutionRequestError } from "../validation.js";

export type CommandLike =
  | NormalizedExecutionRequest
  | DuplexExecutionRequest;

export function mergedEnvironment(
  inherit: boolean,
  ...environments: (ExecutionEnvironment | undefined)[]
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = inherit ? { ...process.env } : {};
  for (const environment of environments) {
    if (environment === undefined) continue;
    for (const [name, value] of Object.entries(environment)) result[name] = value;
  }
  return result;
}

export function mergedCommandEnvironment(
  ...environments: (ExecutionEnvironment | undefined)[]
): ExecutionEnvironment {
  return Object.freeze(Object.assign({}, ...environments.filter(Boolean)));
}

export function assertTargetText(
  value: string,
  field: string,
  options: { readonly rejectLeadingDash?: boolean } = {},
): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    (options.rejectLeadingDash === true && value.startsWith("-"))
  ) {
    throw new InvalidExecutionRequestError(`Invalid execution target ${field}`);
  }
}
