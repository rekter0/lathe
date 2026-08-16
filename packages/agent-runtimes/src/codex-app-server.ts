import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import {
  CodexAppServerProcess,
  LATHE_CODEX_PERMISSION_PROFILE_ID,
  safeCodexEnvironment,
  type AppServerCallbacks,
} from "./json-rpc-process.js";
import { redactRuntimeJson, redactRuntimeText } from "./redaction.js";
import type {
  CodexAppServerAdapterContract,
  CodexAppServerProfile,
  CodexContinuityOutcome,
  CodexGenerationRequest,
  CodexModelDescriptor,
  CodexNormalizedEvent,
  CodexProbeResult,
  CodexRunResult,
  CodexRuntimeIdentity,
  CodexRuntimeRun,
  CodexStreamItem,
  CodexSubscriptionAuth,
  CodexTraceEvent,
  JsonObject,
  JsonValue,
  RejectedRuntimeRequestKind,
  RuntimeClientInfo,
} from "./types.js";
import { CodexRuntimeError } from "./types.js";

const DEFAULT_CLIENT_INFO: RuntimeClientInfo = Object.freeze({
  name: "lathe",
  title: "Lathe",
  version: "0.1.0",
});
const MAX_MODEL_PAGES = 20;
const MODEL_PAGE_SIZE = 100;
const MAX_PERMISSION_PROFILE_PAGES = 20;
const PERMISSION_PROFILE_PAGE_SIZE = 100;
const VERSION_OUTPUT_LIMIT = 64 * 1024;

interface InspectedExecutable {
  readonly executablePath: string;
  readonly executableSha256: string | null;
  readonly cliVersion: string | null;
  readonly warnings: string[];
}

interface PreparedWorkspace {
  readonly cwd: string;
  readonly runtimeWorkspaceRoots: string[];
  readonly temporaryDirectory: string | null;
  readonly warnings: readonly string[];
}

interface AccountProbe {
  readonly auth: CodexSubscriptionAuth;
  readonly warnings: readonly string[];
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiting: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiting.shift();
    if (waiter !== undefined) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.#values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<T>>((resolve) => this.#waiting.push(resolve));
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return isRecord(value) ? value : {};
}

function stringValue(...values: readonly unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string") return value;
  return undefined;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => typeof entry === "string" ? [entry] : []);
}

function methodKey(method: string): string {
  return method.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function boundedInteger(
  name: string,
  value: number | undefined,
  minimum: number,
  maximum: number,
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CodexRuntimeError(
      "invalid-profile",
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
}

function validateProfile(profile: CodexAppServerProfile): void {
  if (!isAbsolute(profile.executablePath)) {
    throw new CodexRuntimeError("invalid-profile", "Codex executablePath must be absolute");
  }
  if (profile.codexHome !== undefined && !isAbsolute(profile.codexHome)) {
    throw new CodexRuntimeError("invalid-profile", "Codex codexHome must be absolute when configured");
  }
  if (profile.authPolicy !== "chatgpt-subscription") {
    throw new CodexRuntimeError(
      "invalid-profile",
      "This adapter only accepts the chatgpt-subscription authentication policy",
    );
  }
  boundedInteger("startupTimeoutMs", profile.startupTimeoutMs, 250, 60_000);
  boundedInteger("requestTimeoutMs", profile.requestTimeoutMs, 250, 120_000);
  boundedInteger("maxJsonLineBytes", profile.maxJsonLineBytes, 1024, 32 * 1024 * 1024);
  boundedInteger("terminationGraceMs", profile.terminationGraceMs, 0, 10_000);
  const client = profile.clientInfo ?? DEFAULT_CLIENT_INFO;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u.test(client.name)) {
    throw new CodexRuntimeError("invalid-profile", "Codex clientInfo.name is invalid");
  }
  if (client.version.length === 0 || client.version.length > 100) {
    throw new CodexRuntimeError("invalid-profile", "Codex clientInfo.version is invalid");
  }
  if (client.title !== undefined && (client.title.length === 0 || client.title.length > 200)) {
    throw new CodexRuntimeError("invalid-profile", "Codex clientInfo.title is invalid");
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", resolve);
    stream.once("error", reject);
  });
  return hash.digest("hex");
}

function stopProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The short-lived version process may already have exited.
  }
}

async function readCliVersion(
  executablePath: string,
  timeoutMs: number,
): Promise<{ readonly version: string | null; readonly warning?: string }> {
  return await new Promise((resolve) => {
    const child = spawn(executablePath, ["--version"], {
      cwd: tmpdir(),
      env: safeCodexEnvironment(process.env),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let limited = false;
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const collect = (current: Buffer, chunk: Buffer): Buffer => {
      if (current.byteLength >= VERSION_OUTPUT_LIMIT) {
        limited = true;
        return current;
      }
      const remaining = VERSION_OUTPUT_LIMIT - current.byteLength;
      if (chunk.byteLength > remaining) limited = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = collect(stderr, chunk); });
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      stopProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => stopProcessGroup(child, "SIGKILL"), 250);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({ version: null, warning: "Codex --version could not be executed" });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (timedOut) {
        resolve({ version: null, warning: "Codex --version timed out" });
        return;
      }
      const output = (stdout.byteLength > 0 ? stdout : stderr).toString("utf8").trim();
      if (code !== 0 || output.length === 0) {
        resolve({ version: null, warning: "Codex --version did not return a usable version" });
        return;
      }
      resolve({
        version: redactRuntimeText(output.split(/\r?\n/u)[0] ?? output),
        ...(limited ? { warning: "Codex --version output was truncated" } : {}),
      });
    });
  });
}

async function inspectExecutable(profile: CodexAppServerProfile): Promise<InspectedExecutable> {
  validateProfile(profile);
  let resolved: string;
  try {
    await access(profile.executablePath, fsConstants.X_OK);
    resolved = await realpath(profile.executablePath);
    const metadata = await stat(resolved);
    if (!metadata.isFile()) throw new Error("not a file");
  } catch (cause) {
    throw new CodexRuntimeError(
      "invalid-profile",
      "Codex executablePath must resolve to an executable file",
      { cause },
    );
  }
  if (profile.codexHome !== undefined) {
    try {
      if (!(await stat(await realpath(profile.codexHome))).isDirectory()) throw new Error("not a directory");
    } catch (cause) {
      throw new CodexRuntimeError(
        "invalid-profile",
        "Codex codexHome must resolve to an existing directory",
        { cause },
      );
    }
  }

  const warnings = [
    "Executable SHA-256 covers only the resolved entry file, not the complete Codex installation.",
    ...(profile.codexHome === undefined
      ? ["No dedicated codexHome was selected; Codex may load account-wide configuration from its default home."]
      : ["Codex owns credential refresh and configuration inside the selected external codexHome; Lathe does not read or copy it."]),
  ];
  let executableSha256: string | null = null;
  try {
    executableSha256 = await sha256File(resolved);
  } catch {
    warnings.push("Could not hash the resolved Codex executable entry file.");
  }
  const versionResult = await readCliVersion(
    profile.executablePath,
    Math.min(profile.startupTimeoutMs ?? 10_000, 5_000),
  );
  if (versionResult.warning !== undefined) warnings.push(versionResult.warning);
  return {
    executablePath: resolved,
    executableSha256,
    cliVersion: versionResult.version,
    warnings,
  };
}

async function prepareWorkspace(request: CodexGenerationRequest): Promise<PreparedWorkspace> {
  if (request.model.trim().length === 0) {
    throw new CodexRuntimeError("invalid-profile", "Codex model must not be empty");
  }
  if (request.input.length === 0) {
    throw new CodexRuntimeError("invalid-profile", "Codex input must not be empty");
  }
  if (request.input.length > 10 * 1024 * 1024) {
    throw new CodexRuntimeError("invalid-profile", "Codex input exceeds the 10 MiB adapter limit");
  }
  if (request.continuity !== undefined) {
    const { sourceThreadId, sourceTurnId, mode, onUnavailable } = request.continuity;
    if (sourceThreadId.length === 0 || sourceThreadId.length > 256 || /[\u0000-\u001f]/u.test(sourceThreadId)) {
      throw new CodexRuntimeError("invalid-profile", "Codex continuity sourceThreadId is invalid");
    }
    if (sourceTurnId !== undefined
      && (sourceTurnId.length === 0 || sourceTurnId.length > 256 || /[\u0000-\u001f]/u.test(sourceTurnId))) {
      throw new CodexRuntimeError("invalid-profile", "Codex continuity sourceTurnId is invalid");
    }
    if (mode === "resume" && sourceTurnId !== undefined) {
      throw new CodexRuntimeError("invalid-profile", "sourceTurnId is supported only for fork continuity");
    }
    if (onUnavailable !== undefined && onUnavailable !== "error" && onUnavailable !== "fresh-with-warning") {
      throw new CodexRuntimeError("invalid-profile", "Codex continuity onUnavailable is invalid");
    }
  }
  let directory: string;
  let temporaryDirectory: string | null = null;
  if (request.workspace.mode === "isolated" && request.workspace.directory === undefined) {
    directory = await mkdtemp(join(tmpdir(), "lathe-codex-"));
    await chmod(directory, 0o700);
    temporaryDirectory = directory;
  } else {
    const requested = request.workspace.directory;
    if (requested === undefined || !isAbsolute(requested)) {
      throw new CodexRuntimeError("invalid-profile", "Codex workspace directory must be absolute");
    }
    try {
      directory = await realpath(requested);
      if (!(await stat(directory)).isDirectory()) throw new Error("not a directory");
    } catch (cause) {
      throw new CodexRuntimeError("invalid-profile", "Codex workspace directory must exist", { cause });
    }
    if (request.workspace.mode === "isolated" && (await readdir(directory)).length !== 0) {
      throw new CodexRuntimeError(
        "invalid-profile",
        "A caller-provided isolated Codex workspace must be empty",
      );
    }
  }
  return {
    cwd: directory,
    runtimeWorkspaceRoots: [directory],
    temporaryDirectory,
    warnings: [
      "The installed Codex runtime enforces Lathe's scoped read-only permission profile; Lathe is not an independent operating-system sandbox.",
      ...(request.workspace.mode === "project-read-only"
        ? ["Project-read-only mode intentionally exposes the selected project to the Codex runtime."]
        : []),
    ],
  };
}

async function cleanupWorkspace(workspace: PreparedWorkspace): Promise<void> {
  if (workspace.temporaryDirectory === null) return;
  const expectedPrefix = join(tmpdir(), "lathe-codex-");
  if (!workspace.temporaryDirectory.startsWith(expectedPrefix)) return;
  await rm(workspace.temporaryDirectory, { recursive: true, force: true });
}

function clientInfo(profile: CodexAppServerProfile): JsonObject {
  const configured = profile.clientInfo ?? DEFAULT_CLIENT_INFO;
  return {
    name: configured.name,
    version: configured.version,
    ...(configured.title === undefined ? {} : { title: configured.title }),
  };
}

async function initialize(
  connection: CodexAppServerProcess,
  profile: CodexAppServerProfile,
  experimentalApi: boolean,
): Promise<string | null> {
  const result = record(await connection.request("initialize", {
    clientInfo: clientInfo(profile),
    capabilities: { experimentalApi, requestAttestation: false },
  }));
  connection.notify("initialized");
  return stringValue(result.userAgent) ?? null;
}

function parseAccount(value: JsonValue): AccountProbe {
  const result = record(value);
  const account = record(result.account);
  // Some app-server versions expose authMode beside account. Accept that only
  // when it explicitly says chatgpt; ambiguous/missing auth always fails closed.
  const type = stringValue(account.type, result.authMode);
  if (type !== "chatgpt") {
    throw new CodexRuntimeError(
      "authentication",
      "Codex is not authenticated with ChatGPT; subscription profiles reject API-key and provider authentication",
      { code: type ?? "missing-auth" },
    );
  }
  return {
    auth: { type: "chatgpt", planType: stringValue(account.planType, result.planType) ?? null },
    warnings: account.type === undefined
      ? ["Codex account/read used the alternate top-level authMode response shape."]
      : [],
  };
}

function parseReasoningEfforts(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const item = record(entry);
    const effort = stringValue(item.reasoningEffort, item.effort);
    return effort === undefined ? [] : [effort];
  });
}

function parseModels(value: JsonValue): {
  readonly models: CodexModelDescriptor[];
  readonly nextCursor: string | null;
  readonly warnings: string[];
} {
  const result = record(value);
  const rawModels = Array.isArray(result.data)
    ? result.data
    : Array.isArray(result.models)
      ? result.models
      : [];
  const warnings: string[] = [];
  if (!Array.isArray(result.data) && Array.isArray(result.models)) {
    warnings.push("Codex model/list used the alternate models response field.");
  }
  const models = rawModels.flatMap((entry): CodexModelDescriptor[] => {
    const model = record(entry);
    const id = stringValue(model.id, model.model);
    if (id === undefined) {
      warnings.push("Ignored a Codex model/list entry without an id or model field.");
      return [];
    }
    const nativeModel = stringValue(model.model, model.id) ?? id;
    return [{
      id,
      model: nativeModel,
      label: stringValue(model.displayName, model.label, model.name) ?? id,
      description: stringValue(model.description) ?? "",
      hidden: booleanValue(model.hidden),
      isDefault: booleanValue(model.isDefault),
      inputModalities: stringArray(model.inputModalities),
      supportedReasoningEfforts: parseReasoningEfforts(model.supportedReasoningEfforts),
    }];
  });
  return {
    models,
    nextCursor: stringValue(result.nextCursor, result.next_cursor) ?? null,
    warnings,
  };
}

async function listModels(
  connection: CodexAppServerProcess,
): Promise<{ readonly models: CodexModelDescriptor[]; readonly warnings: string[] }> {
  const models = new Map<string, CodexModelDescriptor>();
  const warnings: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const parsed = parseModels(await connection.request("model/list", {
      cursor,
      limit: MODEL_PAGE_SIZE,
      includeHidden: true,
    }));
    for (const model of parsed.models) models.set(model.id, model);
    warnings.push(...parsed.warnings);
    cursor = parsed.nextCursor;
    if (cursor === null) return { models: Array.from(models.values()), warnings };
  }
  warnings.push(`Stopped Codex model pagination after ${MAX_MODEL_PAGES} pages.`);
  return { models: Array.from(models.values()), warnings };
}

async function readAccount(connection: CodexAppServerProcess): Promise<AccountProbe> {
  return parseAccount(await connection.request("account/read", { refreshToken: false }));
}

async function requireReadOnlyPermissionProfile(
  connection: CodexAppServerProcess,
  cwd: string,
): Promise<void> {
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PERMISSION_PROFILE_PAGES; page += 1) {
    const response = record(await connection.request("permissionProfile/list", {
      cwd,
      cursor,
      limit: PERMISSION_PROFILE_PAGE_SIZE,
    }));
    const profiles = Array.isArray(response.data) ? response.data : [];
    for (const entry of profiles) {
      const profile = record(entry);
      if (stringValue(profile.id) !== LATHE_CODEX_PERMISSION_PROFILE_ID) continue;
      if (profile.allowed !== true) {
        throw new CodexRuntimeError(
          "invalid-profile",
          `Codex permission profile ${LATHE_CODEX_PERMISSION_PROFILE_ID} is not allowed for this workspace`,
          { code: "permission-profile-disallowed" },
        );
      }
      return;
    }
    cursor = stringValue(response.nextCursor) ?? null;
    if (cursor === null) break;
  }
  throw new CodexRuntimeError(
    "invalid-profile",
    `Codex permission profile ${LATHE_CODEX_PERMISSION_PROFILE_ID} is unavailable in the installed App Server`,
    { code: "permission-profile-unavailable" },
  );
}

interface EstablishedThread {
  readonly threadId: string;
  readonly continuity: CodexContinuityOutcome;
  readonly warnings: readonly string[];
}

function threadOverrides(request: CodexGenerationRequest, workspace: PreparedWorkspace): JsonObject {
  return {
    model: request.model,
    cwd: workspace.cwd,
    approvalPolicy: "never",
    permissions: LATHE_CODEX_PERMISSION_PROFILE_ID,
    runtimeWorkspaceRoots: workspace.runtimeWorkspaceRoots,
    ...(request.baseInstructions === undefined ? {} : { baseInstructions: request.baseInstructions }),
    ...(request.developerInstructions === undefined
      ? {}
      : { developerInstructions: request.developerInstructions }),
    ...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
  };
}

async function startFreshThread(
  connection: CodexAppServerProcess,
  request: CodexGenerationRequest,
  workspace: PreparedWorkspace,
): Promise<string> {
  return threadIdFrom(await connection.request("thread/start", {
    ...threadOverrides(request, workspace),
    ephemeral: true,
    environments: [],
    serviceName: "lathe",
  }));
}

async function establishThread(
  connection: CodexAppServerProcess,
  request: CodexGenerationRequest,
  workspace: PreparedWorkspace,
): Promise<EstablishedThread> {
  const continuity = request.continuity;
  if (continuity === undefined) {
    return {
      threadId: await startFreshThread(connection, request, workspace),
      continuity: { mode: "fresh" },
      warnings: [],
    };
  }
  const method = continuity.mode === "fork" ? "thread/fork" : "thread/resume";
  const params: JsonObject = {
    ...threadOverrides(request, workspace),
    threadId: continuity.sourceThreadId,
    excludeTurns: true,
    ...(continuity.mode === "fork" ? { ephemeral: true } : {}),
    ...(continuity.sourceTurnId === undefined ? {} : { lastTurnId: continuity.sourceTurnId }),
  };
  try {
    const threadId = threadIdFrom(await connection.request(method, params));
    return {
      threadId,
      continuity: {
        mode: continuity.mode,
        sourceThreadId: continuity.sourceThreadId,
        ...(continuity.sourceTurnId === undefined ? {} : { sourceTurnId: continuity.sourceTurnId }),
      },
      warnings: [
        "Native continuity imports vendor-owned history and hidden runtime state; preserve the App Server trace and source cursor.",
        ...(continuity.mode === "resume"
          ? ["Native resume appends to the selected Codex thread; prefer fork for immutable Lathe branches."]
          : []),
      ],
    };
  } catch (cause) {
    if (continuity.onUnavailable !== "fresh-with-warning") throw cause;
    const threadId = await startFreshThread(connection, request, workspace);
    return {
      threadId,
      continuity: {
        mode: "lossy-fresh",
        sourceThreadId: continuity.sourceThreadId,
        ...(continuity.sourceTurnId === undefined ? {} : { sourceTurnId: continuity.sourceTurnId }),
      },
      warnings: [
        `Codex ${method} was unavailable; generation started with fresh context. This is a lossy replay boundary.`,
      ],
    };
  }
}

function runtimeIdentity(inspected: InspectedExecutable, userAgent: string | null): CodexRuntimeIdentity {
  return {
    executablePath: inspected.executablePath,
    executableSha256: inspected.executableSha256,
    executableHashScope: "entry-file",
    cliVersion: inspected.cliVersion,
    appServerUserAgent: userAgent,
  };
}

function uniqueWarnings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

class CodexRunController {
  readonly #queue = new AsyncQueue<CodexStreamItem>();
  readonly #completion = deferred<CodexRunResult>();
  readonly #cleanupWorkspace: () => Promise<void>;
  readonly #redactionEnabled: boolean;
  readonly #textByItem = new Map<string, string>();
  readonly #reasoningByItem = new Map<string, string>();
  readonly #summaryByItem = new Map<string, string>();
  #connection: CodexAppServerProcess | undefined;
  #runtime: CodexRuntimeIdentity | undefined;
  #auth: CodexSubscriptionAuth | undefined;
  #threadId = "";
  #turnId = "";
  #text = "";
  #reasoning = "";
  #reasoningSummary = "";
  #continuity: CodexContinuityOutcome = { mode: "fresh" };
  #ready = false;
  #finished = false;
  #cancelling = false;
  #pendingTerminal: (() => void) | undefined;
  #cleanup: Promise<void> | undefined;
  #signal: AbortSignal | undefined;
  #abortListener: (() => void) | undefined;

  constructor(cleanupWorkspaceImpl: () => Promise<void>, redactionEnabled: boolean) {
    this.#cleanupWorkspace = cleanupWorkspaceImpl;
    this.#redactionEnabled = redactionEnabled;
  }

  bindConnection(connection: CodexAppServerProcess): void {
    this.#connection = connection;
  }

  bindSignal(signal: AbortSignal | undefined): void {
    if (signal === undefined) return;
    this.#signal = signal;
    this.#abortListener = () => { void this.cancel("Cancelled by AbortSignal"); };
    signal.addEventListener("abort", this.#abortListener, { once: true });
    if (signal.aborted) this.#abortListener();
  }

  onTrace(trace: CodexTraceEvent): void {
    this.#queue.push({ trace, events: [] });
  }

  onWarning(code: string, message: string): void {
    this.#emit({ type: "runtime.warning", code, message: this.#evidenceText(message) });
  }

  onRequestRejected(method: string, kind: RejectedRuntimeRequestKind): void {
    this.#emit({ type: "runtime.request.rejected", method, kind });
  }

  onFatal(error: CodexRuntimeError): void {
    if (this.#cancelling || this.#finished) return;
    const terminal = (): void => this.#finishFailed(error);
    if (this.#ready) terminal();
    else this.#pendingTerminal = terminal;
  }

  onNotification(method: string, paramsValue: JsonValue): void {
    if (this.#finished) return;
    const params = record(paramsValue);
    const notifiedThread = stringValue(params.threadId, params.thread_id);
    if (this.#threadId !== "" && notifiedThread !== undefined && notifiedThread !== this.#threadId) return;
    const key = methodKey(method);
    if (key.includes("turnstarted")) {
      const turn = record(params.turn);
      this.#threadId ||= notifiedThread ?? "";
      this.#turnId ||= stringValue(turn.id, params.turnId, params.turn_id) ?? "";
      return;
    }
    if (key.includes("agentmessagedelta")) {
      const delta = stringValue(params.delta, record(params.message).delta, record(params.event).delta);
      if (delta !== undefined) this.#emitText(delta, stringValue(params.itemId, params.item_id));
      return;
    }
    if (key.includes("reasoningsummarytextdelta")) {
      const delta = stringValue(params.delta, record(params.message).delta, record(params.event).delta);
      if (delta !== undefined) this.#emitReasoning(delta, "summary", stringValue(params.itemId, params.item_id));
      return;
    }
    if (key.includes("reasoningtextdelta")) {
      const delta = stringValue(params.delta, record(params.message).delta, record(params.event).delta);
      if (delta !== undefined) this.#emitReasoning(delta, "raw", stringValue(params.itemId, params.item_id));
      return;
    }
    if (key.includes("itemcompleted")) {
      this.#consumeCompletedItem(record(params.item));
      return;
    }
    if (key.includes("turncompleted")) {
      const terminal = (): void => this.#consumeCompletedTurn(record(params.turn));
      if (this.#ready) terminal();
      else this.#pendingTerminal = terminal;
      return;
    }
    if (key === "error" || key.endsWith("errornotification")) {
      const willRetry = params.willRetry === true || params.will_retry === true;
      const error = record(params.error);
      const message = stringValue(error.message, params.message) ?? "Codex runtime reported an error";
      if (willRetry) {
        this.onWarning("runtime-retrying", message);
        return;
      }
      const errorCode = stringValue(error.code);
      const terminal = (): void => this.#finishFailed(new CodexRuntimeError(
        "runtime-error",
        this.#evidenceText(message),
        errorCode === undefined ? {} : { code: errorCode },
      ));
      if (this.#ready) terminal();
      else this.#pendingTerminal = terminal;
    }
  }

  ready(
    runtime: CodexRuntimeIdentity,
    auth: CodexSubscriptionAuth,
    model: string,
    threadId: string,
    turnId: string,
    continuity: CodexContinuityOutcome,
    warnings: readonly string[],
  ): CodexRuntimeRun {
    this.#runtime = runtime;
    this.#auth = auth;
    this.#threadId = threadId;
    this.#turnId = turnId;
    this.#continuity = continuity;
    this.#ready = true;
    this.#emit({ type: "runtime.ready", runtime, auth, model, continuity });
    for (const message of uniqueWarnings(warnings)) {
      this.onWarning("runtime-boundary", message);
    }
    this.#emit({ type: "run.started", threadId, turnId });
    const pendingTerminal = this.#pendingTerminal;
    this.#pendingTerminal = undefined;
    pendingTerminal?.();
    return {
      runtime,
      auth,
      threadId,
      turnId,
      continuity,
      events: this.#queue,
      completed: this.#completion.promise,
      cancel: async (reason?: string) => await this.cancel(reason),
    };
  }

  async cancel(_reason = "Cancelled by operator"): Promise<void> {
    if (this.#finished) {
      await this.#cleanup;
      return;
    }
    this.#cancelling = true;
    if (this.#connection !== undefined && this.#threadId !== "" && this.#turnId !== "") {
      try {
        await this.#connection.request("turn/interrupt", {
          threadId: this.#threadId,
          turnId: this.#turnId,
        }, 1_500);
      } catch {
        this.onWarning("interrupt-unconfirmed", "Codex did not confirm turn/interrupt before process termination.");
      }
    }
    this.#finish({
      status: "cancelled",
      threadId: this.#threadId,
      turnId: this.#turnId,
      nativeStatus: "cancelled",
      text: this.#text,
      reasoning: this.#reasoning,
      reasoningSummary: this.#reasoningSummary,
      continuity: this.#continuity,
    }, {
      type: "run.cancelled",
      threadId: this.#threadId,
      turnId: this.#turnId,
    }, "cancelled");
    await this.#cleanup;
  }

  async abortStartup(): Promise<void> {
    if (!this.#finished) {
      this.#finished = true;
      this.#queue.close();
    }
    await this.#startCleanup("startup-failed");
  }

  #consumeCompletedItem(item: Record<string, JsonValue>): void {
    const type = stringValue(item.type);
    const itemId = stringValue(item.id);
    if (type === "agentMessage") {
      const text = stringValue(item.text);
      if (text !== undefined) this.#completeTextItem(text, itemId);
      return;
    }
    if (type === "reasoning") {
      const summary = stringArray(item.summary).join("");
      const content = stringArray(item.content).join("");
      if (summary.length > 0) this.#completeReasoningItem(summary, "summary", itemId);
      if (content.length > 0) this.#completeReasoningItem(content, "raw", itemId);
    }
  }

  #consumeCompletedTurn(turn: Record<string, JsonValue>): void {
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const item of items) this.#consumeCompletedItem(record(item));
    const status = stringValue(turn.status) ?? "completed";
    if (status.toLowerCase() === "completed" || status.toLowerCase() === "success") {
      this.#finish({
        status: "completed",
        threadId: this.#threadId,
        turnId: this.#turnId,
        nativeStatus: status,
        text: this.#text,
        reasoning: this.#reasoning,
        reasoningSummary: this.#reasoningSummary,
        continuity: this.#continuity,
      }, {
        type: "run.completed",
        threadId: this.#threadId,
        turnId: this.#turnId,
        nativeStatus: status,
      }, "completed");
      return;
    }
    const error = record(turn.error);
    const errorCode = stringValue(error.code, status);
    this.#finishFailed(new CodexRuntimeError(
      "runtime-error",
      this.#evidenceText(stringValue(error.message) ?? `Codex turn ended with status ${status}`),
      errorCode === undefined ? {} : { code: errorCode },
    ), status);
  }

  #emitText(delta: string, itemId?: string): void {
    this.#text += delta;
    if (itemId !== undefined) this.#textByItem.set(itemId, (this.#textByItem.get(itemId) ?? "") + delta);
    this.#emit({ type: "text.delta", text: delta, ...(itemId === undefined ? {} : { itemId }) });
  }

  #emitReasoning(delta: string, kind: "raw" | "summary", itemId?: string): void {
    if (kind === "raw") {
      this.#reasoning += delta;
      if (itemId !== undefined) this.#reasoningByItem.set(itemId, (this.#reasoningByItem.get(itemId) ?? "") + delta);
    } else {
      this.#reasoningSummary += delta;
      if (itemId !== undefined) this.#summaryByItem.set(itemId, (this.#summaryByItem.get(itemId) ?? "") + delta);
    }
    this.#emit({
      type: "reasoning.delta",
      text: delta,
      kind,
      ...(itemId === undefined ? {} : { itemId }),
    });
  }

  #completeTextItem(fullText: string, itemId?: string): void {
    const current = itemId === undefined ? "" : (this.#textByItem.get(itemId) ?? "");
    if (current.length === 0) {
      this.#emitText(fullText, itemId);
    } else if (fullText.startsWith(current) && fullText.length > current.length) {
      this.#emitText(fullText.slice(current.length), itemId);
    } else if (fullText !== current) {
      this.onWarning("inconsistent-final-text", "Codex final agent message did not match its streamed deltas.");
    }
  }

  #completeReasoningItem(fullText: string, kind: "raw" | "summary", itemId?: string): void {
    const values = kind === "raw" ? this.#reasoningByItem : this.#summaryByItem;
    const current = itemId === undefined ? "" : (values.get(itemId) ?? "");
    if (current.length === 0) {
      this.#emitReasoning(fullText, kind, itemId);
    } else if (fullText.startsWith(current) && fullText.length > current.length) {
      this.#emitReasoning(fullText.slice(current.length), kind, itemId);
    } else if (fullText !== current) {
      this.onWarning("inconsistent-final-reasoning", "Codex final reasoning item did not match its streamed deltas.");
    }
  }

  #finishFailed(error: CodexRuntimeError, nativeStatus: string | null = null): void {
    this.#finish({
      status: "failed",
      threadId: this.#threadId,
      turnId: this.#turnId,
      nativeStatus,
      text: this.#text,
      reasoning: this.#reasoning,
      reasoningSummary: this.#reasoningSummary,
      continuity: this.#continuity,
      failure: {
        classification: error.classification,
        message: this.#evidenceText(error.message),
        ...(error.code === undefined ? {} : { code: error.code }),
      },
    }, {
      type: "run.failed",
      classification: error.classification,
      message: this.#evidenceText(error.message),
    }, "failed");
  }

  #finish(result: CodexRunResult, event: CodexNormalizedEvent, cleanupReason: string): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#emit(event);
    this.#completion.resolve(result);
    this.#queue.close();
    void this.#startCleanup(cleanupReason);
  }

  #emit(event: CodexNormalizedEvent): void {
    this.#queue.push({ events: [event] });
  }

  #evidenceText(value: string): string {
    return this.#redactionEnabled ? redactRuntimeText(value) : value;
  }

  #startCleanup(reason: string): Promise<void> {
    if (this.#cleanup !== undefined) return this.#cleanup;
    if (this.#signal !== undefined && this.#abortListener !== undefined) {
      this.#signal.removeEventListener("abort", this.#abortListener);
    }
    this.#cleanup = (async () => {
      try {
        await this.#connection?.terminate(reason);
      } finally {
        await this.#cleanupWorkspace();
      }
    })();
    return this.#cleanup;
  }
}

function probeCallbacks(
  trace: CodexTraceEvent[],
  warnings: string[],
  setFatal: (error: CodexRuntimeError) => void,
): AppServerCallbacks {
  return {
    onTrace: (event) => trace.push(event),
    onNotification: () => {},
    onRequestRejected: (method, kind) => {
      warnings.push(`Rejected unexpected ${kind} request ${method} during probe.`);
    },
    onWarning: (_code, message) => warnings.push(message),
    onFatal: setFatal,
  };
}

function controllerCallbacks(controller: CodexRunController): AppServerCallbacks {
  return {
    onTrace: (trace) => controller.onTrace(trace),
    onNotification: (method, params) => controller.onNotification(method, params),
    onRequestRejected: (method, kind) => controller.onRequestRejected(method, kind),
    onWarning: (code, message) => controller.onWarning(code, message),
    onFatal: (error) => controller.onFatal(error),
  };
}

function threadIdFrom(value: JsonValue): string {
  const result = record(value);
  const thread = record(result.thread);
  const id = stringValue(thread.id, result.threadId, result.thread_id);
  if (id === undefined) {
    throw new CodexRuntimeError("protocol", "Codex thread/start response did not include a thread id");
  }
  const activePermissionProfile = record(result.activePermissionProfile);
  const activePermissionProfileId = stringValue(activePermissionProfile.id);
  if (activePermissionProfileId !== LATHE_CODEX_PERMISSION_PROFILE_ID) {
    throw new CodexRuntimeError(
      "invalid-profile",
      `Codex did not activate the required ${LATHE_CODEX_PERMISSION_PROFILE_ID} permission profile; remove legacy sandbox_mode settings or use a dedicated Codex home`,
      { code: "permission-profile-not-active" },
    );
  }
  return id;
}

function turnIdFrom(value: JsonValue): string {
  const result = record(value);
  const turn = record(result.turn);
  const id = stringValue(turn.id, result.turnId, result.turn_id);
  if (id === undefined) {
    throw new CodexRuntimeError("protocol", "Codex turn/start response did not include a turn id");
  }
  return id;
}

export class CodexAppServerAdapter implements CodexAppServerAdapterContract {
  readonly kind = "codex-app-server";

  async probe(profile: CodexAppServerProfile): Promise<CodexProbeResult> {
    const inspected = await inspectExecutable(profile);
    const directory = await mkdtemp(join(tmpdir(), "lathe-codex-probe-"));
    await chmod(directory, 0o700);
    const trace: CodexTraceEvent[] = [];
    const warnings = [...inspected.warnings];
    let fatal: CodexRuntimeError | undefined;
    let connection: CodexAppServerProcess | undefined;
    try {
      connection = await CodexAppServerProcess.spawn(
        profile,
        directory,
        probeCallbacks(trace, warnings, (error) => { fatal = error; }),
      );
      const userAgent = await initialize(connection, profile, false);
      if (fatal !== undefined) throw fatal;
      const account = await readAccount(connection);
      if (fatal !== undefined) throw fatal;
      const discovered = await listModels(connection);
      if (fatal !== undefined) throw fatal;
      return {
        runtime: runtimeIdentity(inspected, userAgent),
        auth: account.auth,
        models: discovered.models,
        warnings: uniqueWarnings([...warnings, ...account.warnings, ...discovered.warnings]),
        trace,
      };
    } finally {
      await connection?.terminate("probe-complete");
      await rm(directory, { recursive: true, force: true });
    }
  }

  async start(
    profile: CodexAppServerProfile,
    request: CodexGenerationRequest,
    options: { readonly signal?: AbortSignal; readonly redactionEnabled?: boolean } = {},
  ): Promise<CodexRuntimeRun> {
    validateProfile(profile);
    if (options.signal?.aborted === true) {
      throw new CodexRuntimeError("cancelled", "Codex run was cancelled before startup");
    }
    const workspace = await prepareWorkspace(request);
    let inspected: InspectedExecutable;
    try {
      inspected = await inspectExecutable(profile);
    } catch (cause) {
      await cleanupWorkspace(workspace);
      throw cause;
    }
    if (Boolean(options.signal?.aborted)) {
      await cleanupWorkspace(workspace);
      throw new CodexRuntimeError("cancelled", "Codex run was cancelled during startup");
    }
    const redactionEnabled = options.redactionEnabled ?? true;
    const controller = new CodexRunController(
      async () => await cleanupWorkspace(workspace),
      redactionEnabled,
    );
    let connection: CodexAppServerProcess | undefined;
    try {
      connection = await CodexAppServerProcess.spawn(
        profile,
        workspace.cwd,
        controllerCallbacks(controller),
        { redactionEnabled },
      );
      controller.bindConnection(connection);
      controller.bindSignal(options.signal);
      const userAgent = await initialize(connection, profile, true);
      const account = await readAccount(connection);
      await requireReadOnlyPermissionProfile(connection, workspace.cwd);
      const established = await establishThread(connection, request, workspace);
      const threadId = established.threadId;
      const turnParams: JsonObject = {
        threadId,
        input: [{ type: "text", text: request.input }],
        model: request.model,
        cwd: workspace.cwd,
        approvalPolicy: "never",
        permissions: LATHE_CODEX_PERMISSION_PROFILE_ID,
        environments: [],
        runtimeWorkspaceRoots: workspace.runtimeWorkspaceRoots,
        ...(request.reasoningEffort === undefined ? {} : { effort: request.reasoningEffort }),
        ...(request.reasoningSummary === undefined ? {} : { summary: request.reasoningSummary }),
        ...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
      };
      const turnId = turnIdFrom(await connection.request("turn/start", turnParams));
      return controller.ready(
        runtimeIdentity(inspected, userAgent),
        account.auth,
        request.model,
        threadId,
        turnId,
        established.continuity,
        [
          ...inspected.warnings,
          ...account.warnings,
          ...workspace.warnings,
          ...established.warnings,
        ],
      );
    } catch (cause) {
      await controller.abortStartup();
      if (cause instanceof CodexRuntimeError) throw cause;
      throw new CodexRuntimeError("transport", "Could not start Codex generation", {
        cause: redactRuntimeJson(cause),
      });
    }
  }
}
