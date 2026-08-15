import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexRuntimeError,
  type CodexAppServerAdapter,
  type CodexAppServerAdapterContract,
  type CodexGenerationRequest,
  type CodexProbeResult,
  type CodexRuntimeRun,
  type CodexStreamItem,
} from "@lathe/agent-runtimes";
import { ContentStore, createPersistence, type LatheRepository } from "@lathe/db";
import {
  nowIso,
  sha256Json,
  uuidv7,
  type AssetRevision,
  type JsonObject,
} from "@lathe/domain";
import { CodexAppServerPayloadGenerator } from "../src/codex-payload-generator.js";
import { EventHub } from "../src/events.js";
import {
  PayloadGenerationCoordinator,
  type CodexPayloadGenerator,
} from "../src/payload-generation-coordinator.js";
import type { PayloadGeneratorProfileValue } from "../src/payload-schemas.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type CodexBackend = Extract<PayloadGeneratorProfileValue["backend"], { kind: "codex-app-server" }>;

function backend(overrides: Partial<CodexBackend> = {}): CodexBackend {
  return {
    kind: "codex-app-server",
    executablePath: "/opt/lathe-test/codex",
    expectedVersion: "codex-cli 1.2.3",
    modelId: "gpt-payload",
    effort: "high",
    timeoutMs: 1_000,
    workspaceAccess: "isolated",
    ...overrides,
  };
}

function probeFixture(overrides: Partial<CodexProbeResult> = {}): CodexProbeResult {
  return {
    runtime: {
      executablePath: "/opt/lathe-test/codex",
      executableSha256: "a".repeat(64),
      executableHashScope: "entry-file",
      cliVersion: "codex-cli 1.2.3",
      appServerUserAgent: "codex-app-server/1.2.3",
    },
    auth: { type: "chatgpt", planType: "plus" },
    models: [{
      id: "gpt-payload",
      model: "gpt-payload",
      label: "Payload GPT",
      description: "Fixture model",
      hidden: false,
      isDefault: true,
      inputModalities: ["text"],
      supportedReasoningEfforts: ["low", "high"],
    }],
    warnings: ["fixture warning"],
    trace: [{
      sequence: 0,
      occurredAt: "2026-08-15T10:00:00.000Z",
      direction: "response",
      method: "account/read",
      data: { authMode: "chatgpt", planType: "plus" },
    }],
    ...overrides,
  };
}

async function* stream(items: readonly CodexStreamItem[]): AsyncIterable<CodexStreamItem> {
  for (const item of items) yield item;
}

function completedRun(input: {
  items?: readonly CodexStreamItem[];
  text?: string;
  reasoning?: string;
  reasoningSummary?: string;
  threadId?: string;
  turnId?: string;
  continuity?: CodexRuntimeRun["continuity"];
  status?: "completed" | "failed" | "cancelled";
  failure?: { classification: "timeout" | "crash" | "cancelled"; message: string };
} = {}): CodexRuntimeRun {
  const threadId = input.threadId ?? "native-thread-1";
  const turnId = input.turnId ?? "native-turn-1";
  const continuity = input.continuity ?? { mode: "fresh" };
  const status = input.status ?? "completed";
  return {
    runtime: probeFixture().runtime,
    auth: probeFixture().auth,
    threadId,
    turnId,
    continuity,
    events: stream(input.items ?? []),
    completed: Promise.resolve({
      status,
      threadId,
      turnId,
      nativeStatus: status,
      text: input.text ?? "",
      reasoning: input.reasoning ?? "",
      reasoningSummary: input.reasoningSummary ?? "",
      continuity,
      ...(input.failure === undefined ? {} : { failure: input.failure }),
    }),
    cancel: vi.fn(async () => undefined),
  };
}

function fakeAdapter(input: {
  probe?: CodexAppServerAdapterContract["probe"];
  start?: CodexAppServerAdapterContract["start"];
} = {}): CodexAppServerAdapter {
  return {
    kind: "codex-app-server",
    probe: input.probe ?? vi.fn(async () => probeFixture()),
    start: input.start ?? vi.fn(async () => completedRun()),
  } as CodexAppServerAdapter;
}

async function contentStoreFixture(): Promise<ContentStore> {
  const directory = await mkdtemp(join(tmpdir(), "lathe-codex-generator-test-"));
  directories.push(directory);
  const store = new ContentStore(directory);
  await store.initialize();
  return store;
}

async function waitFor(check: () => Promise<boolean>, message: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function codexProfileAsset(value: CodexBackend = backend()): AssetRevision {
  const profileValue: JsonObject = { backend: value };
  return {
    id: uuidv7(),
    assetId: uuidv7(),
    kind: "payload-generator-profile",
    revision: 1,
    name: "Codex subscription generator",
    description: "Codex fixture profile",
    tags: ["test"],
    provenance: { test: true },
    value: profileValue,
    contentHash: sha256Json(profileValue),
    trusted: true,
    archivedAt: null,
    createdAt: nowIso(),
  };
}

async function generatorRepositoryFixture(repository: LatheRepository, profileValue = backend()) {
  const project = await repository.createProject({ name: "Codex payload project" });
  const { session, branch } = await repository.createSession({ projectId: project.id, name: "Codex session" });
  const profile = codexProfileAsset(profileValue);
  await repository.saveAssetRevision(profile);
  return { project, session, branch, profile };
}

function generationInput(input: Awaited<ReturnType<typeof generatorRepositoryFixture>>) {
  return {
    sessionId: input.session.id,
    branchId: input.branch.id,
    contextNodeId: null,
    operatorInstruction: "Generate a concise authorized payload.",
    profileRevisionId: input.profile.id,
    instructionRevisionId: null,
    techniqueRevisionIds: [],
    variables: {},
    context: {
      mode: "none" as const,
      includeProjectBrief: false,
      includeSessionBrief: false,
      includeTargetConfig: false,
      budgetChars: 2_000,
    },
    candidateCount: 1,
    diversity: "balanced" as const,
    confirmProjectReadOnly: false,
    parentRevisionId: null,
    feedback: null,
  };
}

describe("CodexAppServerPayloadGenerator", () => {
  it("exposes the sanitized subscription probe surface and enforces the expected CLI version", async () => {
    const store = await contentStoreFixture();
    const probe = vi.fn(async () => probeFixture());
    const generator = new CodexAppServerPayloadGenerator(store, fakeAdapter({ probe }));

    await expect(generator.probe(backend())).resolves.toMatchObject({
      backend: "codex-app-server",
      ready: true,
      runtime: {
        cliVersion: "codex-cli 1.2.3",
        executableSha256: "a".repeat(64),
      },
      auth: { type: "chatgpt", planType: "plus" },
      models: [{ id: "gpt-payload", supportedReasoningEfforts: ["low", "high"] }],
      warnings: ["fixture warning"],
    });
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      executablePath: "/opt/lathe-test/codex",
      authPolicy: "chatgpt-subscription",
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    }));

    await expect(generator.probe(backend({ expectedVersion: "codex-cli 9.9.9" }))).rejects.toMatchObject({
      name: "CodexRuntimeError",
      classification: "invalid-profile",
      message: expect.stringContaining("expected codex-cli 9.9.9"),
    });
  });

  it("streams text and reasoning separately and persists redacted probe/run evidence", async () => {
    const store = await contentStoreFixture();
    let request: CodexGenerationRequest | undefined;
    const start = vi.fn(async (_profile, nextRequest: CodexGenerationRequest) => {
      request = nextRequest;
      return completedRun({
        text: "payload",
        reasoning: "private analysis",
        reasoningSummary: "public summary",
        items: [
          {
            trace: {
              sequence: 1,
              occurredAt: "2026-08-15T10:00:01.000Z",
              direction: "request",
              method: "thread/start",
              data: { params: { model: "gpt-payload", token: "[REDACTED]" } },
            },
            events: [{ type: "text.delta", text: "pay" }],
          },
          {
            trace: {
              sequence: 2,
              occurredAt: "2026-08-15T10:00:02.000Z",
              direction: "notification",
              method: "item/reasoning/delta",
              data: { delta: "private analysis" },
            },
            events: [
              { type: "text.delta", text: "load" },
              { type: "reasoning.delta", kind: "raw", text: "private analysis" },
            ],
          },
        ],
      });
    });
    const generator = new CodexAppServerPayloadGenerator(store, fakeAdapter({ start }));
    const onText = vi.fn();
    const onReasoning = vi.fn();
    const result = await generator.generate({
      backend: backend(),
      systemPrompt: "You generate test payloads.",
      operatorPrompt: "Draft the next payload.",
      workspaceRoot: null,
      stagingDirectory: store.stagingDirectory,
      parentNativeThreadId: null,
      parentNativeTurnId: null,
      isRefinement: false,
      signal: new AbortController().signal,
      onText,
      onReasoning,
    });

    expect(onText.mock.calls.flat()).toEqual(["pay", "load"]);
    expect(onReasoning).toHaveBeenCalledWith("private analysis");
    expect(result).toMatchObject({
      text: "payload",
      reasoning: "private analysis\n\npublic summary",
      classification: null,
      traceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      nativeThreadId: "native-thread-1",
      nativeTurnId: "native-turn-1",
      metadata: {
        auth: { type: "chatgpt", planType: "plus" },
        workspaceAccess: "isolated",
        lossyReplay: false,
      },
    });
    expect(request).toMatchObject({
      model: "gpt-payload",
      input: "Draft the next payload.",
      baseInstructions: "You generate test payloads.",
      reasoningEffort: "high",
      reasoningSummary: "detailed",
      workspace: { mode: "isolated", directory: expect.any(String) },
    });
    expect(request).not.toHaveProperty("continuity");
    await expect(stat((request?.workspace as { directory: string }).directory)).rejects.toMatchObject({ code: "ENOENT" });

    const trace = (await store.get(result.traceHash!)).toString("utf8");
    expect(trace).toContain("auth-probe");
    expect(trace).toContain("account/read");
    expect(trace).toContain("thread/start");
    expect(trace).toContain("[REDACTED]");
  });

  it("passes native fork cursors, makes lossy fallback visible, and maps terminal classifications", async () => {
    const store = await contentStoreFixture();
    const requests: CodexGenerationRequest[] = [];
    let resultIndex = 0;
    const start = vi.fn(async (_profile, request: CodexGenerationRequest) => {
      requests.push(request);
      resultIndex += 1;
      if (resultIndex === 1) {
        return completedRun({
          text: "refined payload",
          threadId: "native-thread-2",
          turnId: "native-turn-2",
          continuity: { mode: "lossy-fresh", sourceThreadId: "native-thread-1", sourceTurnId: "native-turn-1" },
        });
      }
      if (resultIndex === 2) {
        return completedRun({
          status: "failed",
          failure: { classification: "timeout", message: "fixture timeout" },
        });
      }
      return completedRun({
        status: "failed",
        failure: { classification: "crash", message: "fixture crash" },
      });
    });
    const generator = new CodexAppServerPayloadGenerator(store, fakeAdapter({ start }));
    const baseInput = {
      backend: backend(),
      systemPrompt: "system",
      operatorPrompt: "refine",
      workspaceRoot: null,
      stagingDirectory: store.stagingDirectory,
      isRefinement: true,
      signal: new AbortController().signal,
      onText: vi.fn(),
      onReasoning: vi.fn(),
    };
    const refined = await generator.generate({
      ...baseInput,
      parentNativeThreadId: "native-thread-1",
      parentNativeTurnId: "native-turn-1",
    });
    expect(requests[0]).toMatchObject({
      continuity: {
        mode: "fork",
        sourceThreadId: "native-thread-1",
        sourceTurnId: "native-turn-1",
        onUnavailable: "fresh-with-warning",
      },
    });
    expect(refined.metadata).toMatchObject({
      continuity: { mode: "lossy-fresh", sourceThreadId: "native-thread-1" },
      lossyReplay: true,
      warnings: [
        "fixture warning",
        expect.stringMatching(/native thread continuity.*exact stored candidate.*fresh thread/i),
      ],
    });

    await expect(generator.generate({
      ...baseInput,
      parentNativeThreadId: null,
      parentNativeTurnId: null,
    })).resolves.toMatchObject({ classification: "timeout" });
    await expect(generator.generate({
      ...baseInput,
      parentNativeThreadId: null,
      parentNativeTurnId: null,
    })).resolves.toMatchObject({ classification: "transport" });

    const aborted = new AbortController();
    aborted.abort();
    const cancelledGenerator = new CodexAppServerPayloadGenerator(store, fakeAdapter({
      start: vi.fn(async () => completedRun({ status: "cancelled" })),
    }));
    await expect(cancelledGenerator.generate({
      ...baseInput,
      signal: aborted.signal,
      parentNativeThreadId: null,
      parentNativeTurnId: null,
    })).resolves.toMatchObject({ classification: "cancelled" });
  });

  it("marks an exact stored refinement replay as lossy when its native cursor is missing", async () => {
    const store = await contentStoreFixture();
    const generator = new CodexAppServerPayloadGenerator(store, fakeAdapter({
      start: vi.fn(async () => completedRun({ text: "replayed refinement", continuity: { mode: "fresh" } })),
    }));
    const result = await generator.generate({
      backend: backend(),
      systemPrompt: "system",
      operatorPrompt: "Previous candidate:\nseed\n\nRefinement feedback:\nshorter",
      workspaceRoot: null,
      stagingDirectory: store.stagingDirectory,
      parentNativeThreadId: null,
      parentNativeTurnId: null,
      isRefinement: true,
      signal: new AbortController().signal,
      onText: vi.fn(),
      onReasoning: vi.fn(),
    });

    expect(result.metadata).toMatchObject({
      continuity: { mode: "lossy-fresh", reason: "missing-native-cursor" },
      lossyReplay: true,
      warnings: ["fixture warning", expect.stringMatching(/native refinement state.*exact stored candidate.*fresh thread/i)],
    });
    expect((await store.get(result.traceHash!)).toString("utf8")).toContain("lossy-refinement-replay");
  });
});

describe("PayloadGenerationCoordinator Codex integration", () => {
  it("persists streamed output/native cursors, refines from the parent cursor, and never mutates the graph", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-codex-coordinator-test-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    try {
      const fixture = await generatorRepositoryFixture(persistence.repository);
      const beforeNodes = await persistence.repository.listNodes(fixture.session.id);
      const calls: Parameters<CodexPayloadGenerator["generate"]>[0][] = [];
      const fakeGenerator: CodexPayloadGenerator = {
        probe: vi.fn(async () => ({ backend: "codex-app-server", ready: true })),
        generate: vi.fn(async (input) => {
          calls.push(input);
          const ordinal = calls.length;
          const text = ordinal === 1 ? "first payload" : "refined payload";
          const reasoning = ordinal === 1 ? "first reasoning" : "refined reasoning";
          input.onText(text.slice(0, 5));
          input.onText(text.slice(5));
          input.onReasoning(reasoning);
          return {
            text,
            reasoning,
            classification: null,
            usage: null,
            traceHash: String(ordinal).repeat(64),
            nativeThreadId: `native-thread-${ordinal}`,
            nativeTurnId: `native-turn-${ordinal}`,
            metadata: ordinal === 1
              ? { continuity: { mode: "fresh" }, lossyReplay: false }
              : {
                  continuity: { mode: "lossy-fresh", sourceThreadId: "native-thread-1", sourceTurnId: "native-turn-1" },
                  lossyReplay: true,
                  warnings: ["Native continuity unavailable; exact stored replay used."],
                },
          };
        }),
      };
      const events = new EventHub();
      const publish = vi.spyOn(events, "publish");
      const coordinator = new PayloadGenerationCoordinator(
        persistence.repository,
        persistence.contentStore,
        events,
        globalThis.fetch,
        fakeGenerator,
      );

      const started = await coordinator.start(generationInput(fixture));
      await waitFor(
        async () => (await persistence.repository.getPayloadGeneration(started.generation.id))?.status === "completed",
        "Codex payload generation",
      );
      const firstAttempt = (await persistence.repository.listPayloadGenerationAttempts(started.generation.id))[0];
      const firstRevision = (await persistence.repository.listPayloadRevisionsForGeneration(started.generation.id))[0];
      expect(firstAttempt).toMatchObject({
        status: "completed",
        classification: null,
        normalizedOutput: { text: "first payload", reasoning: "first reasoning" },
        traceHash: "1".repeat(64),
        nativeThreadId: "native-thread-1",
        nativeTurnId: "native-turn-1",
      });
      expect(firstRevision).toMatchObject({ operation: "generated", text: "first payload" });

      const refined = await coordinator.refine(firstRevision!.id, { feedback: "Make it shorter." });
      await waitFor(
        async () => (await persistence.repository.getPayloadGeneration(refined.generation.id))?.status === "completed",
        "Codex payload refinement",
      );
      const refinedAttempt = (await persistence.repository.listPayloadGenerationAttempts(refined.generation.id))[0];
      const refinedRevision = (await persistence.repository.listPayloadRevisionsForGeneration(refined.generation.id))[0];
      expect(calls[1]).toMatchObject({
        parentNativeThreadId: "native-thread-1",
        parentNativeTurnId: "native-turn-1",
        isRefinement: true,
      });
      expect(calls[1]?.operatorPrompt).toContain("Previous candidate:\nfirst payload");
      expect(calls[1]?.operatorPrompt).toContain("Refinement feedback:\nMake it shorter.");
      expect(refinedAttempt).toMatchObject({
        status: "completed",
        normalizedOutput: {
          text: "refined payload",
          reasoning: "refined reasoning",
          metadata: { lossyReplay: true, warnings: [expect.stringContaining("exact stored replay")] },
        },
        nativeThreadId: "native-thread-2",
        nativeTurnId: "native-turn-2",
      });
      expect(refinedRevision).toMatchObject({
        operation: "refined",
        parentRevisionId: firstRevision!.id,
        text: "refined payload",
      });
      expect(await persistence.repository.listNodes(fixture.session.id)).toEqual(beforeNodes);
      expect((await persistence.repository.listBranches(fixture.session.id))[0]?.headNodeId).toBeNull();
      const eventTypes = publish.mock.calls.map(([, type]) => type);
      expect(eventTypes).toContain("candidate.text.delta");
      expect(eventTypes).toContain("candidate.reasoning.delta");
    } finally {
      await persistence.repository.close();
    }
  });

  it("classifies fake App Server timeout/cancellation, retains partial evidence, and leaves the graph untouched", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-codex-failure-test-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    try {
      const fixture = await generatorRepositoryFixture(persistence.repository);
      let invocation = 0;
      const fakeGenerator: CodexPayloadGenerator = {
        probe: vi.fn(async () => ({ backend: "codex-app-server", ready: true })),
        generate: vi.fn(async (input) => {
          invocation += 1;
          if (invocation === 1) {
            input.onText("partial timeout payload");
            input.onReasoning("reasoning before timeout");
            const error = new CodexRuntimeError("timeout", "App Server timed out");
            Object.defineProperty(error, "traceHash", { value: "e".repeat(64) });
            throw error;
          }
          await new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener("abort", () => reject(new CodexRuntimeError("cancelled", "Cancelled")), { once: true });
          });
          throw new Error("unreachable");
        }),
      };
      const coordinator = new PayloadGenerationCoordinator(
        persistence.repository,
        persistence.contentStore,
        new EventHub(),
        globalThis.fetch,
        fakeGenerator,
      );
      const timeoutGeneration = await coordinator.start(generationInput(fixture));
      await waitFor(
        async () => (await persistence.repository.getPayloadGeneration(timeoutGeneration.generation.id))?.status === "partial",
        "Codex timeout result",
      );
      const timeoutAttempt = (await persistence.repository.listPayloadGenerationAttempts(timeoutGeneration.generation.id))[0];
      expect(timeoutAttempt).toMatchObject({
        status: "failed",
        classification: "timeout",
        traceHash: "e".repeat(64),
        normalizedOutput: {
          text: "partial timeout payload",
          reasoning: "reasoning before timeout",
          error: "App Server timed out",
        },
      });
      expect(await persistence.repository.listPayloadRevisionsForGeneration(timeoutGeneration.generation.id)).toMatchObject([{
        text: "partial timeout payload",
        provenance: { backend: "codex-app-server", partial: true },
      }]);

      const cancelledGeneration = await coordinator.start({
        ...generationInput(fixture),
        operatorInstruction: "Wait until cancelled.",
      });
      await waitFor(async () => {
        const attempt = (await persistence.repository.listPayloadGenerationAttempts(cancelledGeneration.generation.id))[0];
        return attempt?.status === "streaming";
      }, "Codex cancellation candidate startup");
      expect(await coordinator.cancel(cancelledGeneration.generation.id)).toBe(true);
      await waitFor(
        async () => (await persistence.repository.getPayloadGeneration(cancelledGeneration.generation.id))?.status === "cancelled",
        "Codex cancellation",
      );
      expect((await persistence.repository.listPayloadGenerationAttempts(cancelledGeneration.generation.id))[0]).toMatchObject({
        status: "cancelled",
        classification: "cancelled",
      });
      expect(await persistence.repository.listNodes(fixture.session.id)).toEqual([]);
      expect((await persistence.repository.listBranches(fixture.session.id))[0]?.headNodeId).toBeNull();
    } finally {
      await persistence.repository.close();
    }
  });
});
