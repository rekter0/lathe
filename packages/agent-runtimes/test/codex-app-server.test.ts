import { copyFile, mkdtemp, realpath, rm, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerAdapter,
  CodexRuntimeError,
  type CodexAppServerProfile,
  type CodexRuntimeRun,
  type CodexStreamItem,
} from "../src/index.js";

const fixtureSource = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

async function fixtureExecutable(scenario: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lathe-agent-runtime-test-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, `fake-codex-${scenario}`);
  await copyFile(fixtureSource, executable);
  await chmod(executable, 0o700);
  return executable;
}

function profile(executablePath: string): CodexAppServerProfile {
  return {
    executablePath,
    authPolicy: "chatgpt-subscription",
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    terminationGraceMs: 100,
  };
}

async function collect(run: CodexRuntimeRun): Promise<{
  readonly items: CodexStreamItem[];
  readonly result: Awaited<CodexRuntimeRun["completed"]>;
}> {
  const items: CodexStreamItem[] = [];
  for await (const item of run.events) items.push(item);
  return { items, result: await run.completed };
}

function events(items: readonly CodexStreamItem[]) {
  return items.flatMap((item) => item.events);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("CodexAppServerAdapter", () => {
  it("probes version/hash, ChatGPT auth, and models without exposing account credentials", async () => {
    const executable = await fixtureExecutable("fragmented");
    const result = await new CodexAppServerAdapter().probe(profile(executable));

    expect(result.runtime.cliVersion).toBe("codex-cli 9.9.9-fixture");
    expect(result.runtime.executableSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.runtime.appServerUserAgent).toBe("codex-app-server/9.9.9-fixture");
    expect(result.auth).toEqual({ type: "chatgpt", planType: "plus" });
    expect(result.models).toEqual([
      expect.objectContaining({
        id: "gpt-fixture",
        label: "Fixture GPT",
        supportedReasoningEfforts: ["low", "high"],
      }),
    ]);
    expect(result.trace.find((item) => item.method === "initialize")?.data).toMatchObject({
      params: {
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("operator@example.test");
    expect(serialized).not.toContain("account-private-123");
    expect(serialized).not.toContain("sk-fixture-super-secret");
    expect(serialized).not.toContain("/Users/private-account/.codex");
    expect(serialized).toContain("[REDACTED]");
  });

  it("fails closed when a subscription profile observes API-key auth", async () => {
    const executable = await fixtureExecutable("auth-mismatch");
    await expect(new CodexAppServerAdapter().probe(profile(executable))).rejects.toMatchObject({
      name: "CodexRuntimeError",
      classification: "authentication",
    });
  });

  it("fails closed when the scoped permission profile is denied or not activated", async () => {
    const disallowed = await fixtureExecutable("permission-profile-disallowed");
    await expect(new CodexAppServerAdapter().start(profile(disallowed), {
      model: "gpt-fixture",
      input: "Do not run",
      workspace: { mode: "isolated" },
    })).rejects.toMatchObject({
      name: "CodexRuntimeError",
      classification: "invalid-profile",
      code: "permission-profile-disallowed",
    });

    const inactive = await fixtureExecutable("permission-profile-inactive");
    await expect(new CodexAppServerAdapter().start(profile(inactive), {
      model: "gpt-fixture",
      input: "Do not run",
      workspace: { mode: "isolated" },
    })).rejects.toMatchObject({
      name: "CodexRuntimeError",
      classification: "invalid-profile",
      code: "permission-profile-not-active",
    });
  });

  it("normalizes fragmented text and reasoning streams without duplicating completed items", async () => {
    const executable = await fixtureExecutable("fragmented");
    const run = await new CodexAppServerAdapter().start(profile(executable), {
      model: "gpt-fixture",
      input: "Say hello",
      workspace: { mode: "isolated" },
      reasoningEffort: "high",
    });
    const { items, result } = await collect(run);
    const normalized = events(items);

    expect(result).toMatchObject({
      status: "completed",
      text: "hello",
      reasoning: "analysis",
      reasoningSummary: "summary",
      threadId: "thread-fixture",
      turnId: "turn-fixture",
    });
    expect(normalized.filter((event) => event.type === "text.delta").map((event) => event.text).join(""))
      .toBe("hello");
    expect(normalized).toContainEqual(expect.objectContaining({
      type: "reasoning.delta",
      kind: "raw",
      text: "analysis",
    }));
    expect(normalized).toContainEqual(expect.objectContaining({
      type: "reasoning.delta",
      kind: "summary",
      text: "summary",
    }));
    expect(normalized).toContainEqual(expect.objectContaining({ type: "run.completed" }));
  });

  it("redacts password and token shaped candidate evidence by default", async () => {
    const executable = await fixtureExecutable("evidence-redaction");
    const run = await new CodexAppServerAdapter().start(profile(executable), {
      model: "gpt-fixture",
      input: "Return credential-shaped test content",
      workspace: { mode: "isolated" },
    });
    const output = await collect(run);
    const serialized = JSON.stringify(output);

    expect(output.result.status).toBe("completed");
    for (const testValue of [
      "safety-token",
      "candidate-password",
      "sk-candidate-token",
      "reasoning-password",
      "reasoning-token",
      "summary-key",
    ]) {
      expect(serialized).not.toContain(testValue);
    }
    expect(serialized).toContain("[REDACTED]");
  });

  it("preserves candidate evidence when redaction is disabled while hiding Codex account material", async () => {
    const executable = await fixtureExecutable("evidence-redaction");
    const run = await new CodexAppServerAdapter().start(profile(executable), {
      model: "gpt-fixture",
      input: "Return credential-shaped test content",
      workspace: { mode: "isolated" },
    }, { redactionEnabled: false });
    const output = await collect(run);
    const serialized = JSON.stringify(output);

    expect(output.result).toMatchObject({
      status: "completed",
      text: 'example text; account-plan=[REDACTED]; tool_call={name:bash,arguments:{command:"Authorization: Bearer safety-token password=candidate-password token=sk-candidate-token"}}',
      reasoning: "reasoning password=reasoning-password token=reasoning-token",
      reasoningSummary: "summary api_key=summary-key",
    });
    expect(serialized).toContain("example text");
    for (const testValue of [
      "safety-token",
      "candidate-password",
      "sk-candidate-token",
      "reasoning-password",
      "reasoning-token",
      "summary-key",
    ]) {
      expect(serialized).toContain(testValue);
    }
    for (const protectedValue of [
      "operator@example.test",
      "account-private-123",
      "sk-fixture-super-secret",
      "/Users/private-account/.codex",
    ]) {
      expect(serialized).not.toContain(protectedValue);
    }
    expect(serialized).toContain("[REDACTED]");
  });

  it("applies the selected evidence policy to turn and request failures", async () => {
    const terminalExecutable = await fixtureExecutable("evidence-failure");
    const strictRun = await new CodexAppServerAdapter().start(profile(terminalExecutable), {
      model: "gpt-fixture",
      input: "Fail with synthetic evidence",
      workspace: { mode: "isolated" },
    });
    const strict = await collect(strictRun);
    expect(strict.result.status).toBe("failed");
    expect(JSON.stringify(strict)).not.toContain("fake-failure-token");
    expect(JSON.stringify(strict)).not.toContain("fake-failure-password");

    const relaxedRun = await new CodexAppServerAdapter().start(profile(terminalExecutable), {
      model: "gpt-fixture",
      input: "Fail with synthetic evidence",
      workspace: { mode: "isolated" },
    }, { redactionEnabled: false });
    const relaxed = await collect(relaxedRun);
    expect(relaxed.result).toMatchObject({
      status: "failed",
      failure: {
        message: expect.stringContaining("Bearer fake-failure-token"),
      },
    });
    const relaxedSerialized = JSON.stringify(relaxed);
    expect(relaxedSerialized).toContain("fake-failure-password");
    expect(relaxedSerialized).toContain("accountId=synthetic-account");
    expect(relaxedSerialized).not.toContain("account-private-123");

    const requestExecutable = await fixtureExecutable("evidence-request-error");
    await expect(new CodexAppServerAdapter().start(profile(requestExecutable), {
      model: "gpt-fixture",
      input: "Reject with synthetic evidence",
      workspace: { mode: "isolated" },
    })).rejects.not.toHaveProperty("message", expect.stringContaining("fake-request-token"));
    await expect(new CodexAppServerAdapter().start(profile(requestExecutable), {
      model: "gpt-fixture",
      input: "Reject with synthetic evidence",
      workspace: { mode: "isolated" },
    }, { redactionEnabled: false })).rejects.toMatchObject({
      message: expect.stringContaining("Bearer fake-request-token"),
    });
  });

  it("rejects approval, tool, MCP, and app requests and lets the runtime report the outcome", async () => {
    const executable = await fixtureExecutable("rejections");
    const run = await new CodexAppServerAdapter().start(profile(executable), {
      model: "gpt-fixture",
      input: "Do not execute anything",
      workspace: { mode: "isolated" },
    });
    const { items, result } = await collect(run);
    const rejected = events(items).filter((event) => event.type === "runtime.request.rejected");

    expect(rejected.map((event) => event.kind).sort()).toEqual(["app", "approval", "mcp", "tool"]);
    expect(result).toMatchObject({ status: "completed", text: "safe" });
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain("account-private-123");
    expect(serialized).not.toContain("do not return");
  });

  it("uses read-only settings for an explicitly selected project workspace", async () => {
    const executable = await fixtureExecutable("fragmented");
    const project = await mkdtemp(join(tmpdir(), "lathe-codex-project-"));
    temporaryDirectories.push(project);
    await writeFile(join(project, "evidence.txt"), "readable", "utf8");
    const resolvedProject = await realpath(project);
    const run = await new CodexAppServerAdapter().start(profile(executable), {
      model: "gpt-fixture",
      input: "Inspect only",
      workspace: { mode: "project-read-only", directory: project },
    });
    const { items, result } = await collect(run);

    expect(result.status).toBe("completed");
    const initializeRequest = items.find((item) => item.trace?.method === "initialize")?.trace;
    expect(initializeRequest?.data).toMatchObject({
      params: {
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });
    const threadStart = items.find((item) => item.trace?.method === "thread/start")?.trace;
    expect(threadStart?.data).toMatchObject({
      params: {
        cwd: resolvedProject,
        permissions: "lathe_scoped_read_only_v1",
        approvalPolicy: "never",
        ephemeral: true,
        environments: [],
        runtimeWorkspaceRoots: [resolvedProject],
      },
    });
    expect(items.find((item) => item.trace?.method === "permissionProfile/list")?.trace?.data)
      .toMatchObject({ params: { cwd: resolvedProject, cursor: null, limit: 100 } });
    expect(threadStart?.data).not.toHaveProperty("params.sandbox");
    expect(threadStart?.data).not.toHaveProperty("params.sandboxPolicy");
    const turnStart = items.find((item) => item.trace?.method === "turn/start")?.trace;
    expect(turnStart?.data).toMatchObject({
      params: {
        cwd: resolvedProject,
        permissions: "lathe_scoped_read_only_v1",
        approvalPolicy: "never",
        environments: [],
        runtimeWorkspaceRoots: [resolvedProject],
      },
    });
    expect(turnStart?.data).not.toHaveProperty("params.sandbox");
    expect(turnStart?.data).not.toHaveProperty("params.sandboxPolicy");
    expect(events(items)).toContainEqual(expect.objectContaining({
      type: "runtime.warning",
      code: "runtime-boundary",
      message: expect.stringContaining("intentionally exposes"),
    }));
  });

  it("forks or resumes a documented native thread cursor with read-only overrides", async () => {
    const executable = await fixtureExecutable("fragmented");
    const adapter = new CodexAppServerAdapter();
    const forked = await adapter.start(profile(executable), {
      model: "gpt-fixture",
      input: "Refine on a branch",
      workspace: { mode: "isolated" },
      continuity: {
        mode: "fork",
        sourceThreadId: "thread-source",
        sourceTurnId: "turn-source",
      },
    });
    const forkedOutput = await collect(forked);
    expect(forked.threadId).toBe("thread-forked");
    expect(forked.continuity).toEqual({
      mode: "fork",
      sourceThreadId: "thread-source",
      sourceTurnId: "turn-source",
    });
    expect(forkedOutput.result).toMatchObject({ status: "completed", continuity: { mode: "fork" } });
    expect(forkedOutput.items.find((item) => item.trace?.method === "thread/fork")?.trace?.data)
      .toMatchObject({
        params: {
          threadId: "thread-source",
          lastTurnId: "turn-source",
          excludeTurns: true,
          ephemeral: true,
          permissions: "lathe_scoped_read_only_v1",
          runtimeWorkspaceRoots: [expect.any(String)],
          approvalPolicy: "never",
        },
      });
    expect(forkedOutput.items.find((item) => item.trace?.method === "thread/fork")?.trace?.data)
      .not.toHaveProperty("params.sandbox");
    expect(forkedOutput.items.find((item) => item.trace?.method === "thread/fork")?.trace?.data)
      .not.toHaveProperty("params.sandboxPolicy");
    expect(JSON.stringify(forkedOutput.items)).not.toContain("native-history-secret");

    const resumed = await adapter.start(profile(executable), {
      model: "gpt-fixture",
      input: "Continue the native thread",
      workspace: { mode: "isolated" },
      continuity: { mode: "resume", sourceThreadId: "thread-source" },
    });
    const resumedOutput = await collect(resumed);
    expect(resumed.threadId).toBe("thread-source");
    expect(resumedOutput.result).toMatchObject({ status: "completed", continuity: { mode: "resume" } });
    const resumeRequest = resumedOutput.items
      .find((item) => item.trace?.method === "thread/resume")?.trace;
    expect(resumeRequest?.data).toMatchObject({
      params: {
        threadId: "thread-source",
        excludeTurns: true,
        permissions: "lathe_scoped_read_only_v1",
        runtimeWorkspaceRoots: [expect.any(String)],
        approvalPolicy: "never",
      },
    });
    expect(resumeRequest?.data).not.toHaveProperty("params.sandbox");
    expect(resumeRequest?.data).not.toHaveProperty("params.sandboxPolicy");
    expect(events(resumedOutput.items)).toContainEqual(expect.objectContaining({
      type: "runtime.warning",
      message: expect.stringContaining("prefer fork"),
    }));
  });

  it("makes a requested fresh fallback visibly lossy when native continuity is unavailable", async () => {
    const executable = await fixtureExecutable("continuity-unsupported");
    const run = await new CodexAppServerAdapter().start(profile(executable), {
      model: "gpt-fixture",
      input: "Fallback explicitly",
      workspace: { mode: "isolated" },
      continuity: {
        mode: "fork",
        sourceThreadId: "missing-thread",
        onUnavailable: "fresh-with-warning",
      },
    });
    const output = await collect(run);

    expect(run.continuity).toEqual({ mode: "lossy-fresh", sourceThreadId: "missing-thread" });
    expect(output.result).toMatchObject({ status: "completed", continuity: { mode: "lossy-fresh" } });
    expect(events(output.items)).toContainEqual(expect.objectContaining({
      type: "runtime.warning",
      message: expect.stringContaining("lossy replay boundary"),
    }));
    expect(output.items.some((item) => item.trace?.method === "thread/fork")).toBe(true);
    expect(output.items.some((item) => item.trace?.method === "thread/start")).toBe(true);
  });

  it("scrubs API keys and access tokens from the app-server environment", async () => {
    const executable = await fixtureExecutable("fragmented");
    const keys = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "ANTHROPIC_API_KEY"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) process.env[key] = `secret-${key}`;
      const result = await new CodexAppServerAdapter().probe(profile(executable));
      expect(result.auth.type).toBe("chatgpt");
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("interrupts then terminates the complete process group on cancellation", async () => {
    const executable = await fixtureExecutable("cancellation");
    const run = await new CodexAppServerAdapter().start(profile(executable), {
      model: "gpt-fixture",
      input: "Wait",
      workspace: { mode: "isolated" },
    });
    const items: CodexStreamItem[] = [];
    const consuming = (async () => {
      for await (const item of run.events) items.push(item);
    })();
    let childPid: number | undefined;
    await waitUntil(() => {
      const serialized = JSON.stringify(items);
      const match = /CHILD_PID=(\d+)/u.exec(serialized);
      childPid = match === null ? undefined : Number(match[1]);
      return childPid !== undefined;
    });

    await run.cancel();
    await consuming;
    expect(await run.completed).toMatchObject({ status: "cancelled" });
    expect(events(items)).toContainEqual(expect.objectContaining({ type: "run.cancelled" }));
    expect(JSON.stringify(items)).not.toContain("account-private-123");
    expect(JSON.stringify(items)).not.toContain("sk-fixture-super-secret");
    expect(JSON.stringify(items)).not.toContain("operator@example.test");
    await waitUntil(() => childPid !== undefined && !processExists(childPid));
  });

  it("classifies malformed JSON-RPC and unexpected app-server exit", async () => {
    const malformed = await fixtureExecutable("malformed");
    await expect(new CodexAppServerAdapter().probe(profile(malformed))).rejects.toMatchObject({
      classification: "protocol",
    });

    const crashing = await fixtureExecutable("crash");
    await expect(new CodexAppServerAdapter().start(profile(crashing), {
      model: "gpt-fixture",
      input: "Crash",
      workspace: { mode: "isolated" },
    })).rejects.toMatchObject({ classification: "crash" });
  });

  it("rejects relative executable paths before spawning", async () => {
    await expect(new CodexAppServerAdapter().probe({
      executablePath: "codex",
      authPolicy: "chatgpt-subscription",
    })).rejects.toEqual(expect.objectContaining<Partial<CodexRuntimeError>>({
      classification: "invalid-profile",
    }));
  });
});
