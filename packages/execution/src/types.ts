import type { Readable, Writable } from "node:stream";

export type ExecutionEnvironment = Readonly<Record<string, string>>;

/**
 * A command is always a program plus an argv vector. There is deliberately no
 * `command` or `shell` property: callers that need a shell must explicitly use
 * `/bin/sh` (or another shell) as `program` and pass its flags in `args`.
 */
export interface ExecutionRequest {
  readonly program: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly environment?: ExecutionEnvironment;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface NormalizedExecutionRequest {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment: ExecutionEnvironment;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface ExecutionLimits {
  readonly defaultTimeoutMs: number;
  readonly maximumTimeoutMs: number;
  readonly defaultMaxOutputBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumInputBytes: number;
  readonly terminationGraceMs: number;
}

export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = Object.freeze({
  defaultTimeoutMs: 60_000,
  maximumTimeoutMs: 15 * 60_000,
  defaultMaxOutputBytes: 10 * 1024 * 1024,
  maximumOutputBytes: 100 * 1024 * 1024,
  maximumInputBytes: 10 * 1024 * 1024,
  terminationGraceMs: 750,
});

export type ExecutionStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "output_limited"
  | "spawn_error";

export type CancellationCertainty =
  | "not_requested"
  | "confirmed"
  | "best_effort";

export interface CapturedOutput {
  /** UTF-8 replacement decoding for display and model-facing handlers. */
  readonly text: string;
  /** Exact captured bytes, encoded for JSON persistence. */
  readonly base64: string;
  /** Total bytes observed, including bytes discarded after reaching the cap. */
  readonly totalBytes: number;
  readonly truncated: boolean;
}

export interface ExecutionFailure {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export interface ExecutionResult {
  readonly targetId: string;
  readonly status: ExecutionStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: CapturedOutput;
  readonly stderr: CapturedOutput;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly cancellation: CancellationCertainty;
  readonly failure?: ExecutionFailure;
}

export type ExecutionEvent =
  | {
      readonly type: "started";
      readonly targetId: string;
      readonly pid: number | undefined;
      readonly at: string;
    }
  | {
      readonly type: "stdout" | "stderr";
      readonly sequence: number;
      readonly chunkBase64: string;
      readonly at: string;
    }
  | {
      readonly type: "stopping";
      readonly reason: "cancelled" | "timeout" | "output_limit";
      readonly at: string;
    }
  | {
      readonly type: "exited";
      readonly status: ExecutionStatus;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly at: string;
    };

export interface ExecutionContext {
  readonly signal?: AbortSignal;
  readonly limits?: Partial<ExecutionLimits>;
  readonly onEvent?: (event: ExecutionEvent) => void;
}

export interface BaseExecutionTarget {
  readonly id: string;
  readonly label: string;
  readonly environment?: ExecutionEnvironment;
}

export interface HostExecutionTarget extends BaseExecutionTarget {
  readonly kind: "host";
  readonly defaultCwd?: string;
  /** Defaults to false. Prefer absolute program paths or an explicit PATH. */
  readonly inheritEnvironment?: boolean;
}

export interface ContainerExecutionTarget extends BaseExecutionTarget {
  readonly kind: "container";
  readonly runtime: "docker" | "podman";
  readonly container: string;
  readonly defaultCwd?: string;
  readonly user?: string;
  /** Optional local path to docker/podman. Defaults to the runtime name. */
  readonly runtimePath?: string;
}

export interface SshExecutionTarget extends BaseExecutionTarget {
  readonly kind: "ssh";
  readonly destination: string;
  readonly defaultCwd?: string;
  readonly port?: number;
  readonly configFile?: string;
  readonly identityFile?: string;
  readonly sshPath?: string;
  /** Retained for profile compatibility; false is rejected in Lathe v1. */
  readonly strictHostKeyChecking?: boolean;
}

export type ExecutionTarget =
  | HostExecutionTarget
  | ContainerExecutionTarget
  | SshExecutionTarget;

export interface DuplexExecutionRequest {
  readonly program: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly environment?: ExecutionEnvironment;
}

export interface DuplexProcessExit {
  readonly status: "completed" | "failed" | "cancelled" | "spawn_error";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly cancellation: CancellationCertainty;
  readonly failure?: ExecutionFailure;
}

export interface DuplexProcess {
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<DuplexProcessExit>;
  terminate(): Promise<CancellationCertainty>;
}

export interface ExecutionTargetAdapter<TTarget extends ExecutionTarget> {
  readonly kind: TTarget["kind"];
  execute(
    target: TTarget,
    request: ExecutionRequest,
    context?: ExecutionContext,
  ): Promise<ExecutionResult>;
  spawnDuplex(
    target: TTarget,
    request: DuplexExecutionRequest,
  ): Promise<DuplexProcess>;
}
