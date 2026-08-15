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
  NormalizedExecutionRequest,
  SshExecutionTarget,
} from "../types.js";
import {
  InvalidExecutionRequestError,
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

/** Encode one argv value for a POSIX login shell without interpolation. */
export function quotePosixArgument(value: string): string {
  if (value.includes("\0")) {
    throw new InvalidExecutionRequestError("Remote argv cannot contain NUL");
  }
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function buildRemoteCommand(
  target: SshExecutionTarget,
  request: CommandLike,
): string {
  validateEnvironment(target.environment);
  const environment = mergedCommandEnvironment(
    target.environment,
    request.environment,
  );
  const envAssignments = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => quotePosixArgument(`${name}=${value}`));
  const argv = [request.program, ...(request.args ?? [])].map(quotePosixArgument);
  const execute = ["exec", "env", "--", ...envAssignments, ...argv].join(" ");
  const cwd = request.cwd ?? target.defaultCwd;
  return cwd === undefined
    ? execute
    : `cd -- ${quotePosixArgument(cwd)} && ${execute}`;
}

export interface SshCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

export function buildSshCommand(
  target: SshExecutionTarget,
  request: CommandLike,
): SshCommand {
  assertTargetText(target.id, "id");
  assertTargetText(target.destination, "destination", {
    rejectLeadingDash: true,
  });
  if (target.configFile !== undefined) {
    assertTargetText(target.configFile, "configFile");
  }
  if (target.identityFile !== undefined) {
    assertTargetText(target.identityFile, "identityFile");
  }
  if (target.sshPath !== undefined) assertTargetText(target.sshPath, "sshPath");
  if (
    target.port !== undefined &&
    (!Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65_535)
  ) {
    throw new InvalidExecutionRequestError("SSH port must be between 1 and 65535");
  }
  if (target.strictHostKeyChecking === false) {
    throw new InvalidExecutionRequestError("SSH strict host-key checking cannot be disabled in Lathe v1");
  }

  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "RequestTTY=no",
    "-o",
    "StrictHostKeyChecking=yes",
  ];
  if (target.configFile !== undefined) args.push("-F", target.configFile);
  if (target.identityFile !== undefined) args.push("-i", target.identityFile);
  if (target.port !== undefined) args.push("-p", String(target.port));
  args.push(target.destination, buildRemoteCommand(target, request));

  return {
    program: target.sshPath ?? "ssh",
    args,
    environment: mergedEnvironment(true),
  };
}

function invocation(
  target: SshExecutionTarget,
  request: NormalizedExecutionRequest,
): ProcessInvocation {
  return {
    ...buildSshCommand(target, request),
    ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
    stopCertainty: "best_effort",
  };
}

function duplexInvocation(
  target: SshExecutionTarget,
  request: DuplexExecutionRequest,
): DuplexProcessInvocation {
  return {
    ...buildSshCommand(target, request),
    stopCertainty: "best_effort",
  };
}

export class SshExecutionAdapter
  implements ExecutionTargetAdapter<SshExecutionTarget>
{
  readonly kind = "ssh" as const;

  async execute(
    target: SshExecutionTarget,
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
    target: SshExecutionTarget,
    request: DuplexExecutionRequest,
  ): Promise<DuplexProcess> {
    validateDuplexExecutionRequest(request);
    return await spawnDuplexProcess(duplexInvocation(target, request));
  }
}
