import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import {
  type CancellationCertainty,
  type CapturedOutput,
  type DuplexProcess,
  type DuplexProcessExit,
  type ExecutionContext,
  type ExecutionEvent,
  type ExecutionFailure,
  type ExecutionResult,
  type ExecutionStatus,
  type NormalizedExecutionRequest,
} from "./types.js";

export interface ProcessInvocation {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly stdin?: string;
  /** Remote/container cancellation cannot guarantee the target process stopped. */
  readonly stopCertainty: Exclude<CancellationCertainty, "not_requested">;
}

interface MutableCapture {
  chunks: Buffer[];
  capturedBytes: number;
  totalBytes: number;
}

type StopReason = "cancelled" | "timeout" | "output_limit";

function timestamp(): string {
  return new Date().toISOString();
}

function failureFrom(error: unknown): ExecutionFailure {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      name: error.name,
      message: error.message,
      ...(code === undefined ? {} : { code }),
    };
  }
  return { name: "Error", message: String(error) };
}

function capturedOutput(capture: MutableCapture): CapturedOutput {
  const bytes = Buffer.concat(capture.chunks, capture.capturedBytes);
  return {
    text: bytes.toString("utf8"),
    base64: bytes.toString("base64"),
    totalBytes: capture.totalBytes,
    truncated: capture.totalBytes > capture.capturedBytes,
  };
}

function emit(context: ExecutionContext, event: ExecutionEvent): void {
  try {
    context.onEvent?.(event);
  } catch {
    // Observers must never change execution behavior.
  }
}

function terminateProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may already have exited or failed before forming its group.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Close/error will settle the result.
  }
}

function statusFor(
  stopReason: StopReason | undefined,
  spawnFailure: ExecutionFailure | undefined,
  exitCode: number | null,
): ExecutionStatus {
  if (spawnFailure !== undefined) return "spawn_error";
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "timeout") return "timed_out";
  if (stopReason === "output_limit") return "output_limited";
  return exitCode === 0 ? "completed" : "failed";
}

export async function runProcess(
  targetId: string,
  invocation: ProcessInvocation,
  request: NormalizedExecutionRequest,
  context: ExecutionContext = {},
): Promise<ExecutionResult> {
  const started = performance.now();
  const startedAt = timestamp();
  const stdout: MutableCapture = { chunks: [], capturedBytes: 0, totalBytes: 0 };
  const stderr: MutableCapture = { chunks: [], capturedBytes: 0, totalBytes: 0 };
  let sequence = 0;
  let stopReason: StopReason | undefined;
  let spawnFailure: ExecutionFailure | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  if (context.signal?.aborted === true) {
    const finishedAt = timestamp();
    return {
      targetId,
      status: "cancelled",
      exitCode: null,
      signal: null,
      stdout: capturedOutput(stdout),
      stderr: capturedOutput(stderr),
      startedAt,
      finishedAt,
      durationMs: performance.now() - started,
      cancellation: invocation.stopCertainty,
    };
  }

  const child = spawn(invocation.program, [...invocation.args], {
    cwd: invocation.cwd,
    env: invocation.environment,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  emit(context, { type: "started", targetId, pid: child.pid, at: timestamp() });

  return await new Promise<ExecutionResult>((resolve) => {
    let settled = false;

    const stop = (reason: StopReason): void => {
      if (stopReason !== undefined || settled) return;
      stopReason = reason;
      emit(context, {
        type: "stopping",
        reason:
          reason === "timeout"
            ? "timeout"
            : reason === "output_limit"
              ? "output_limit"
              : "cancelled",
        at: timestamp(),
      });
      terminateProcessGroup(child, "SIGTERM");
      const graceMs = context.limits?.terminationGraceMs ?? 750;
      killTimer = setTimeout(
        () => terminateProcessGroup(child, "SIGKILL"),
        graceMs,
      );
      killTimer.unref();
    };

    const append = (
      destination: MutableCapture,
      type: "stdout" | "stderr",
      chunk: Buffer,
    ): void => {
      destination.totalBytes += chunk.length;
      const totalCaptured = stdout.capturedBytes + stderr.capturedBytes;
      const remaining = Math.max(0, request.maxOutputBytes - totalCaptured);
      const accepted = chunk.subarray(0, remaining);
      if (accepted.length > 0) {
        destination.chunks.push(accepted);
        destination.capturedBytes += accepted.length;
        emit(context, {
          type,
          sequence: sequence++,
          chunkBase64: accepted.toString("base64"),
          at: timestamp(),
        });
      }
      if (chunk.length > remaining) stop("output_limit");
    };

    child.stdout.on("data", (chunk: Buffer) => append(stdout, "stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, "stderr", chunk));
    // A fast-exiting child can close stdin while the parent is still writing.
    // The execution result, rather than an unhandled stream error, owns that
    // failure path.
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => {
      spawnFailure = failureFrom(error);
    });

    const timeout = setTimeout(() => stop("timeout"), request.timeoutMs);
    timeout.unref();

    const abort = (): void => stop("cancelled");
    context.signal?.addEventListener("abort", abort, { once: true });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      context.signal?.removeEventListener("abort", abort);

      const status = statusFor(stopReason, spawnFailure, exitCode);
      const finishedAt = timestamp();
      emit(context, {
        type: "exited",
        status,
        exitCode,
        signal,
        at: finishedAt,
      });
      resolve({
        targetId,
        status,
        exitCode,
        signal,
        stdout: capturedOutput(stdout),
        stderr: capturedOutput(stderr),
        startedAt,
        finishedAt,
        durationMs: performance.now() - started,
        cancellation:
          stopReason === undefined
            ? "not_requested"
            : invocation.stopCertainty,
        ...(spawnFailure === undefined ? {} : { failure: spawnFailure }),
      });
    });

    if (invocation.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(invocation.stdin);
    }
  });
}

export interface DuplexProcessInvocation
  extends Omit<ProcessInvocation, "stdin"> {}

export async function spawnDuplexProcess(
  invocation: DuplexProcessInvocation,
  terminationGraceMs = 750,
): Promise<DuplexProcess> {
  const child = spawn(invocation.program, [...invocation.args], {
    cwd: invocation.cwd,
    env: invocation.environment,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let requestedStop = false;
  let killTimer: NodeJS.Timeout | undefined;
  let resolveExit: ((exit: DuplexProcessExit) => void) | undefined;
  const exited = new Promise<DuplexProcessExit>((resolve) => {
    resolveExit = resolve;
  });

  let failure: ExecutionFailure | undefined;
  child.stdin.on("error", () => undefined);
  child.once("error", (error) => {
    failure = failureFrom(error);
  });
  child.once("close", (exitCode, signal) => {
    if (killTimer !== undefined) clearTimeout(killTimer);
    const status =
      failure !== undefined
        ? "spawn_error"
        : requestedStop
          ? "cancelled"
          : exitCode === 0
            ? "completed"
            : "failed";
    resolveExit?.({
      status,
      exitCode,
      signal,
      cancellation: requestedStop
        ? invocation.stopCertainty
        : "not_requested",
      ...(failure === undefined ? {} : { failure }),
    });
  });

  const terminate = async (): Promise<CancellationCertainty> => {
    if (!requestedStop) {
      requestedStop = true;
      terminateProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(
        () => terminateProcessGroup(child, "SIGKILL"),
        terminationGraceMs,
      );
      killTimer.unref();
    }
    await exited;
    return invocation.stopCertainty;
  };

  return {
    pid: child.pid,
    stdin: child.stdin as Writable,
    stdout: child.stdout as Readable,
    stderr: child.stderr as Readable,
    exited,
    terminate,
  };
}
