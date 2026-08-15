import {
  runProcess,
  spawnDuplexProcess,
  type DuplexProcessInvocation,
  type ProcessInvocation,
} from "../process-runner.js";
import type {
  DuplexExecutionRequest,
  DuplexProcess,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  ExecutionTargetAdapter,
  HostExecutionTarget,
  NormalizedExecutionRequest,
} from "../types.js";
import {
  normalizeExecutionRequest,
  validateDuplexExecutionRequest,
  validateEnvironment,
} from "../validation.js";
import { assertTargetText, mergedEnvironment } from "./shared.js";

function validateHostTarget(target: HostExecutionTarget): void {
  assertTargetText(target.id, "id");
  if (target.defaultCwd !== undefined) {
    assertTargetText(target.defaultCwd, "defaultCwd");
  }
  validateEnvironment(target.environment);
}

function hostInvocation(
  target: HostExecutionTarget,
  request: NormalizedExecutionRequest,
): ProcessInvocation {
  return {
    program: request.program,
    args: request.args,
    ...((request.cwd ?? target.defaultCwd) === undefined
      ? {}
      : { cwd: request.cwd ?? target.defaultCwd }),
    environment: mergedEnvironment(
      target.inheritEnvironment ?? false,
      target.environment,
      request.environment,
    ),
    ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
    stopCertainty: "confirmed",
  };
}

function hostDuplexInvocation(
  target: HostExecutionTarget,
  request: DuplexExecutionRequest,
): DuplexProcessInvocation {
  return {
    program: request.program,
    args: request.args ?? [],
    ...((request.cwd ?? target.defaultCwd) === undefined
      ? {}
      : { cwd: request.cwd ?? target.defaultCwd }),
    environment: mergedEnvironment(
      target.inheritEnvironment ?? false,
      target.environment,
      request.environment,
    ),
    stopCertainty: "confirmed",
  };
}

export class HostExecutionAdapter
  implements ExecutionTargetAdapter<HostExecutionTarget>
{
  readonly kind = "host" as const;

  async execute(
    target: HostExecutionTarget,
    request: ExecutionRequest,
    context: ExecutionContext = {},
  ): Promise<ExecutionResult> {
    validateHostTarget(target);
    const normalized = normalizeExecutionRequest(request, context.limits);
    return await runProcess(
      target.id,
      hostInvocation(target, normalized),
      normalized,
      context,
    );
  }

  async spawnDuplex(
    target: HostExecutionTarget,
    request: DuplexExecutionRequest,
  ): Promise<DuplexProcess> {
    validateHostTarget(target);
    validateDuplexExecutionRequest(request);
    return await spawnDuplexProcess(hostDuplexInvocation(target, request));
  }
}
