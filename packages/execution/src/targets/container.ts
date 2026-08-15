import {
  runProcess,
  spawnDuplexProcess,
  type DuplexProcessInvocation,
  type ProcessInvocation,
} from "../process-runner.js";
import type {
  ContainerExecutionTarget,
  DuplexExecutionRequest,
  DuplexProcess,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  ExecutionTargetAdapter,
  NormalizedExecutionRequest,
} from "../types.js";
import {
  normalizeExecutionRequest,
  validateDuplexExecutionRequest,
  validateEnvironment,
} from "../validation.js";
import {
  assertTargetText,
  mergedCommandEnvironment,
  mergedEnvironment,
  type CommandLike,
} from "./shared.js";

export interface ContainerExecCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

export function buildContainerExecCommand(
  target: ContainerExecutionTarget,
  request: CommandLike,
): ContainerExecCommand {
  assertTargetText(target.id, "id");
  assertTargetText(target.container, "container", { rejectLeadingDash: true });
  if (target.user !== undefined) assertTargetText(target.user, "user");
  if (target.runtimePath !== undefined) {
    assertTargetText(target.runtimePath, "runtimePath");
  }
  validateEnvironment(target.environment);

  const commandEnvironment = mergedCommandEnvironment(
    target.environment,
    request.environment,
  );
  const args: string[] = ["exec", "-i"];
  if (target.user !== undefined) args.push("--user", target.user);
  const cwd = request.cwd ?? target.defaultCwd;
  if (cwd !== undefined) args.push("--workdir", cwd);

  // Values live in the CLI process environment, not its argv/process listing.
  for (const name of Object.keys(commandEnvironment).sort()) {
    args.push("--env", name);
  }
  args.push("--", target.container, request.program, ...(request.args ?? []));

  return {
    program: target.runtimePath ?? target.runtime,
    args,
    environment: mergedEnvironment(true, commandEnvironment),
  };
}

function invocation(
  target: ContainerExecutionTarget,
  request: NormalizedExecutionRequest,
): ProcessInvocation {
  const command = buildContainerExecCommand(target, request);
  return {
    ...command,
    ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
    stopCertainty: "best_effort",
  };
}

function duplexInvocation(
  target: ContainerExecutionTarget,
  request: DuplexExecutionRequest,
): DuplexProcessInvocation {
  return {
    ...buildContainerExecCommand(target, request),
    stopCertainty: "best_effort",
  };
}

export class ContainerExecutionAdapter
  implements ExecutionTargetAdapter<ContainerExecutionTarget>
{
  readonly kind = "container" as const;

  async execute(
    target: ContainerExecutionTarget,
    request: ExecutionRequest,
    context: ExecutionContext = {},
  ): Promise<ExecutionResult> {
    const normalized = normalizeExecutionRequest(request, context.limits);
    return await runProcess(
      target.id,
      invocation(target, normalized),
      normalized,
      context,
    );
  }

  async spawnDuplex(
    target: ContainerExecutionTarget,
    request: DuplexExecutionRequest,
  ): Promise<DuplexProcess> {
    validateDuplexExecutionRequest(request);
    return await spawnDuplexProcess(duplexInvocation(target, request));
  }
}
