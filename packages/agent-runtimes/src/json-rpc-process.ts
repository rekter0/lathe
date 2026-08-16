import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import process from "node:process";
import type {
  CodexAppServerProfile,
  CodexTraceDirection,
  CodexTraceEvent,
  JsonObject,
  JsonValue,
  RejectedRuntimeRequestKind,
} from "./types.js";
import { CodexRuntimeError } from "./types.js";
import { redactRuntimeJson, redactRuntimeText } from "./redaction.js";

type RpcId = number | string;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

export interface AppServerCallbacks {
  readonly onTrace: (trace: CodexTraceEvent) => void;
  readonly onNotification: (method: string, params: JsonValue) => void;
  readonly onRequestRejected: (method: string, kind: RejectedRuntimeRequestKind) => void;
  readonly onWarning: (code: string, message: string) => void;
  readonly onFatal: (error: CodexRuntimeError) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 750;
const MAX_STDERR_TRACE_BYTES = 1024 * 1024;

export const LATHE_CODEX_PERMISSION_PROFILE_ID = "lathe_scoped_read_only_v1";
export const LATHE_CODEX_PERMISSION_PROFILE_CONFIG =
  'permissions.lathe_scoped_read_only_v1={description="Lathe scoped read-only",filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"}},network={enabled=false}}';

const SAFE_ENVIRONMENT_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CODEX_HOME",
] as const;

export function safeCodexEnvironment(
  source: NodeJS.ProcessEnv,
  codexHome?: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  if (codexHome !== undefined) result.CODEX_HOME = codexHome;
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcId(value: unknown): RpcId | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

function requestKind(method: string): RejectedRuntimeRequestKind {
  const normalized = method.toLowerCase();
  if (normalized.includes("approval") || normalized.includes("permission")) return "approval";
  if (normalized.includes("mcp")) return "mcp";
  if (normalized.includes("app")) return "app";
  if (normalized.includes("tool") || normalized.includes("elicitation")) return "tool";
  return "other";
}

function rpcError(message: Record<string, unknown>, method: string): CodexRuntimeError {
  const value = isRecord(message.error) ? message.error : {};
  const rawMessage = typeof value.message === "string" ? value.message : `Codex request ${method} failed`;
  const code = typeof value.code === "string" || typeof value.code === "number"
    ? String(value.code)
    : undefined;
  return new CodexRuntimeError("runtime-error", redactRuntimeText(rawMessage), {
    ...(code === undefined ? {} : { code }),
  });
}

function responseTraceValue(
  message: Record<string, unknown>,
  method: string | undefined,
): Record<string, unknown> {
  if (method !== "thread/fork" && method !== "thread/resume") return message;
  const cloned = structuredClone(message);
  if (!isRecord(cloned.result)) return cloned;
  const result = cloned.result;
  if (isRecord(result.thread) && Array.isArray(result.thread.turns)) {
    result.thread.turns = [{ omitted: "native-history" }];
  }
  if ("initialTurnsPage" in result) result.initialTurnsPage = { omitted: "native-history" };
  return cloned;
}

function terminateProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The process may already have exited. Termination is best effort here; the
    // close event remains the authoritative lifecycle signal.
  }
}

export class CodexAppServerProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #callbacks: AppServerCallbacks;
  readonly #requestTimeoutMs: number;
  readonly #maxLineBytes: number;
  readonly #terminationGraceMs: number;
  readonly #pending = new Map<RpcId, PendingRequest>();
  readonly #exit: Promise<void>;
  #resolveExit!: () => void;
  #stdout = Buffer.alloc(0);
  #nextId = 1;
  #traceSequence = 0;
  #stderrBytes = 0;
  #stderrLimited = false;
  #fatal = false;
  #closing = false;
  #closed = false;
  #termination: Promise<void> | undefined;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    profile: CodexAppServerProfile,
    callbacks: AppServerCallbacks,
  ) {
    this.#child = child;
    this.#callbacks = callbacks;
    this.#requestTimeoutMs = profile.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#maxLineBytes = profile.maxJsonLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.#terminationGraceMs = profile.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.#exit = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    child.stdout.on("data", (chunk: Buffer) => this.#receiveStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.#receiveStderr(chunk));
    child.on("error", (cause) => {
      this.#fail(new CodexRuntimeError("transport", "Could not start or communicate with Codex App Server", { cause }));
    });
    child.on("close", (code, signal) => {
      this.#closed = true;
      this.#resolveExit();
      if (!this.#closing) {
        this.#fail(new CodexRuntimeError(
          "crash",
          `Codex App Server exited unexpectedly (code ${code === null ? "null" : code}, signal ${signal ?? "none"})`,
          { code: code === null ? (signal ?? "unknown") : String(code) },
        ));
      }
    });
  }

  static async spawn(
    profile: CodexAppServerProfile,
    cwd: string,
    callbacks: AppServerCallbacks,
  ): Promise<CodexAppServerProcess> {
    const child = spawn(
      profile.executablePath,
      [
        "app-server",
        "--stdio",
        "-c",
        `default_permissions="${LATHE_CODEX_PERMISSION_PROFILE_ID}"`,
        "-c",
        LATHE_CODEX_PERMISSION_PROFILE_CONFIG,
        "-c",
        "mcp_servers={}",
        "-c",
        "shell_environment_policy.inherit=none",
        "-c",
        'web_search="disabled"',
        "-c",
        "check_for_update_on_startup=false",
      ],
      {
        cwd,
        env: safeCodexEnvironment(process.env, profile.codexHome),
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const connection = new CodexAppServerProcess(child, profile, callbacks);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new CodexRuntimeError("timeout", "Timed out starting Codex App Server"));
      }, profile.startupTimeoutMs ?? 10_000);
      timeout.unref();
      const onSpawn = (): void => {
        clearTimeout(timeout);
        child.off("error", onError);
        resolve();
      };
      const onError = (cause: Error): void => {
        clearTimeout(timeout);
        child.off("spawn", onSpawn);
        reject(new CodexRuntimeError("transport", "Could not spawn Codex App Server", { cause }));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    }).catch(async (error: unknown) => {
      await connection.terminate("startup-failed");
      throw error;
    });
    return connection;
  }

  async request(method: string, params: JsonValue = {}, timeoutMs = this.#requestTimeoutMs): Promise<JsonValue> {
    if (this.#closing || this.#closed) {
      throw new CodexRuntimeError("transport", "Codex App Server is not running");
    }
    const id = this.#nextId++;
    const message: JsonObject = { id, method, params };
    return await new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexRuntimeError("timeout", `Timed out waiting for Codex method ${method}`, { code: method }));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#write(message, "request", method);
      } catch (cause) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new CodexRuntimeError("transport", `Could not send Codex method ${method}`, { cause }));
      }
    });
  }

  notify(method: string, params?: JsonValue): void {
    this.#write(params === undefined ? { method } : { method, params }, "request", method);
  }

  async terminate(reason = "closed"): Promise<void> {
    if (this.#termination !== undefined) return await this.#termination;
    this.#closing = true;
    const closingError = new CodexRuntimeError(
      reason === "cancelled" ? "cancelled" : "transport",
      reason === "cancelled" ? "Codex run was cancelled" : "Codex App Server was closed",
    );
    this.#rejectPending(closingError);
    this.#termination = (async () => {
      if (this.#closed) return;
      this.#child.stdin.end();
      terminateProcessGroup(this.#child, "SIGTERM");
      const killTimer = setTimeout(
        () => terminateProcessGroup(this.#child, "SIGKILL"),
        this.#terminationGraceMs,
      );
      killTimer.unref();
      await this.#exit;
      clearTimeout(killTimer);
    })();
    return await this.#termination;
  }

  #write(message: JsonObject, direction: CodexTraceDirection, method?: string): void {
    this.#emitTrace(direction, message, method);
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receiveStdout(chunk: Buffer): void {
    if (this.#fatal || this.#closing) return;
    this.#stdout = Buffer.concat([this.#stdout, chunk]);
    while (true) {
      const newline = this.#stdout.indexOf(0x0a);
      if (newline === -1) break;
      if (newline > this.#maxLineBytes) {
        this.#protocolFailure(`Codex JSON-RPC line exceeded ${this.#maxLineBytes} bytes`);
        return;
      }
      const line = this.#stdout.subarray(0, newline).toString("utf8").replace(/\r$/u, "");
      this.#stdout = this.#stdout.subarray(newline + 1);
      if (line.trim().length === 0) continue;
      this.#receiveLine(line);
      if (this.#fatal) return;
    }
    if (this.#stdout.byteLength > this.#maxLineBytes) {
      this.#protocolFailure(`Codex JSON-RPC line exceeded ${this.#maxLineBytes} bytes`);
    }
  }

  #receiveLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.#emitTrace("internal", {
        error: "malformed-json-rpc",
        raw: redactRuntimeText(line),
      });
      this.#protocolFailure("Codex App Server emitted malformed JSON-RPC");
      return;
    }
    if (!isRecord(parsed)) {
      this.#protocolFailure("Codex App Server emitted a non-object JSON-RPC message");
      return;
    }
    const id = rpcId(parsed.id);
    const method = typeof parsed.method === "string" ? parsed.method : undefined;
    if (method !== undefined && id !== undefined) {
      const kind = requestKind(method);
      this.#emitTrace("server-request", parsed, method);
      this.#callbacks.onRequestRejected(method, kind);
      const response: JsonObject = {
        id,
        error: {
          code: -32601,
          message: "Lathe's restricted Codex runtime rejects server-initiated requests",
        },
      };
      this.#write(response, "server-response", method);
      return;
    }
    if (id !== undefined && ("result" in parsed || "error" in parsed)) {
      const pending = this.#pending.get(id);
      this.#emitTrace("response", responseTraceValue(parsed, pending?.method), pending?.method);
      if (pending === undefined) {
        this.#callbacks.onWarning("unknown-response-id", "Codex returned a response for an unknown request id");
        return;
      }
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if ("error" in parsed && parsed.error !== undefined && parsed.error !== null) {
        pending.reject(rpcError(parsed, pending.method));
      } else {
        pending.resolve(redactRuntimeJson(parsed.result));
      }
      return;
    }
    if (method !== undefined) {
      const params = redactRuntimeJson(parsed.params ?? {});
      this.#emitTrace("notification", parsed, method);
      this.#callbacks.onNotification(method, params);
      return;
    }
    this.#emitTrace("internal", { error: "unknown-json-rpc-shape", message: parsed });
    this.#callbacks.onWarning("unknown-json-rpc-shape", "Codex emitted an unrecognized JSON-RPC object");
  }

  #receiveStderr(chunk: Buffer): void {
    if (this.#stderrLimited) return;
    const remaining = MAX_STDERR_TRACE_BYTES - this.#stderrBytes;
    if (remaining <= 0) {
      this.#limitStderr();
      return;
    }
    const selected = chunk.subarray(0, remaining);
    this.#stderrBytes += selected.byteLength;
    this.#emitTrace("stderr", { text: redactRuntimeText(selected.toString("utf8")) });
    if (selected.byteLength < chunk.byteLength || this.#stderrBytes >= MAX_STDERR_TRACE_BYTES) {
      this.#limitStderr();
    }
  }

  #limitStderr(): void {
    if (this.#stderrLimited) return;
    this.#stderrLimited = true;
    this.#emitTrace("internal", { warning: "stderr-truncated", maxBytes: MAX_STDERR_TRACE_BYTES });
    this.#callbacks.onWarning("stderr-truncated", "Codex App Server stderr exceeded the trace limit");
  }

  #emitTrace(direction: CodexTraceDirection, data: unknown, method?: string): void {
    this.#callbacks.onTrace({
      sequence: this.#traceSequence++,
      occurredAt: new Date().toISOString(),
      direction,
      ...(method === undefined ? {} : { method }),
      data: redactRuntimeJson(data),
    });
  }

  #protocolFailure(message: string): void {
    const error = new CodexRuntimeError("protocol", message);
    this.#fail(error);
    void this.terminate("protocol-failure");
  }

  #fail(error: CodexRuntimeError): void {
    if (this.#fatal || this.#closing) return;
    this.#fatal = true;
    this.#rejectPending(error);
    this.#callbacks.onFatal(error);
  }

  #rejectPending(error: CodexRuntimeError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
