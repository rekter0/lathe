import {
  DEFAULT_EXECUTION_LIMITS,
  type DuplexExecutionRequest,
  type ExecutionEnvironment,
  type ExecutionLimits,
  type ExecutionRequest,
  type NormalizedExecutionRequest,
} from "./types.js";

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class InvalidExecutionRequestError extends Error {
  override readonly name = "InvalidExecutionRequestError";

  constructor(message: string) {
    super(message);
  }
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidExecutionRequestError(`${field} must be a positive integer`);
  }
}

function safeString(value: string, field: string, allowEmpty = true): void {
  if ((!allowEmpty && value.length === 0) || value.includes("\0")) {
    throw new InvalidExecutionRequestError(
      `${field} ${allowEmpty ? "cannot contain NUL" : "must be non-empty and cannot contain NUL"}`,
    );
  }
}

export function validateEnvironment(
  environment: ExecutionEnvironment | undefined,
): void {
  if (environment === undefined) return;

  for (const [name, value] of Object.entries(environment)) {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new InvalidExecutionRequestError(
        `Invalid environment variable name: ${JSON.stringify(name)}`,
      );
    }
    safeString(value, `environment.${name}`);
  }
}

export function resolveExecutionLimits(
  overrides: Partial<ExecutionLimits> | undefined,
): ExecutionLimits {
  const limits = { ...DEFAULT_EXECUTION_LIMITS, ...overrides };
  positiveInteger(limits.defaultTimeoutMs, "defaultTimeoutMs");
  positiveInteger(limits.maximumTimeoutMs, "maximumTimeoutMs");
  positiveInteger(limits.defaultMaxOutputBytes, "defaultMaxOutputBytes");
  positiveInteger(limits.maximumOutputBytes, "maximumOutputBytes");
  positiveInteger(limits.maximumInputBytes, "maximumInputBytes");
  positiveInteger(limits.terminationGraceMs, "terminationGraceMs");

  if (limits.defaultTimeoutMs > limits.maximumTimeoutMs) {
    throw new InvalidExecutionRequestError(
      "defaultTimeoutMs cannot exceed maximumTimeoutMs",
    );
  }
  if (limits.defaultMaxOutputBytes > limits.maximumOutputBytes) {
    throw new InvalidExecutionRequestError(
      "defaultMaxOutputBytes cannot exceed maximumOutputBytes",
    );
  }
  return Object.freeze(limits);
}

export function normalizeExecutionRequest(
  request: ExecutionRequest,
  limitOverrides?: Partial<ExecutionLimits>,
): NormalizedExecutionRequest {
  const limits = resolveExecutionLimits(limitOverrides);
  safeString(request.program, "program", false);

  const args = request.args === undefined ? [] : [...request.args];
  for (const [index, value] of args.entries()) {
    safeString(value, `args[${index}]`);
  }
  if (request.cwd !== undefined) safeString(request.cwd, "cwd", false);
  validateEnvironment(request.environment);

  const timeoutMs = request.timeoutMs ?? limits.defaultTimeoutMs;
  const maxOutputBytes =
    request.maxOutputBytes ?? limits.defaultMaxOutputBytes;
  positiveInteger(timeoutMs, "timeoutMs");
  positiveInteger(maxOutputBytes, "maxOutputBytes");

  if (timeoutMs > limits.maximumTimeoutMs) {
    throw new InvalidExecutionRequestError(
      `timeoutMs exceeds the ${limits.maximumTimeoutMs}ms hard limit`,
    );
  }
  if (maxOutputBytes > limits.maximumOutputBytes) {
    throw new InvalidExecutionRequestError(
      `maxOutputBytes exceeds the ${limits.maximumOutputBytes}-byte hard limit`,
    );
  }
  if (
    request.stdin !== undefined &&
    Buffer.byteLength(request.stdin) > limits.maximumInputBytes
  ) {
    throw new InvalidExecutionRequestError(
      `stdin exceeds the ${limits.maximumInputBytes}-byte hard limit`,
    );
  }

  return Object.freeze({
    program: request.program,
    args: Object.freeze(args),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    environment: Object.freeze({ ...(request.environment ?? {}) }),
    ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
    timeoutMs,
    maxOutputBytes,
  });
}

export function validateDuplexExecutionRequest(
  request: DuplexExecutionRequest,
): void {
  safeString(request.program, "program", false);
  for (const [index, value] of (request.args ?? []).entries()) {
    safeString(value, `args[${index}]`);
  }
  if (request.cwd !== undefined) safeString(request.cwd, "cwd", false);
  validateEnvironment(request.environment);
}
