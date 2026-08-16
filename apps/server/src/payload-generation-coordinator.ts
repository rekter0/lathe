import {
  nowIso,
  sha256Json,
  type AssetRevision,
  type JsonObject,
  type JsonValue,
  type PayloadGeneration,
  type PayloadGenerationAttempt,
  type PayloadRevision,
  type ProviderProfile,
  type RunClassification
} from "@lathe/domain";
import type { ContentStore, LatheRepository } from "@lathe/db";
import {
  compileGeneratorInstructions,
  type PayloadTechnique
} from "@lathe/payloads";
import {
  compileProviderRequest,
  executeProviderRequest,
  providerSecretValues,
  redactHeaders,
  redactJson as redactProviderJson,
  redactText as redactProviderText,
  redactUrl,
  type CanonicalGenerationRequest,
  type ProviderFailure,
  type ProviderUsage
} from "@lathe/providers";
import type { EventHub } from "./events.js";
import { resolvePayloadContext } from "./payload-context.js";
import {
  payloadGeneratorInstructionValueSchema,
  payloadGeneratorProfileValueSchema,
  payloadTechniqueValueSchema,
  type CreatePayloadGenerationInput,
  type PayloadGeneratorProfileValue
} from "./payload-schemas.js";
import { ProviderOutcomeTracker } from "./provider-outcome.js";

export interface PayloadObservedOutcome {
  revisionId: string;
  nodeId: string;
  runId: string;
  branchId: string;
  status: string;
  classification: RunClassification | null;
  operatorLabel: string | null;
  operatorNotes: string | null;
  createdAt: string;
}

export interface PayloadGenerationDetail {
  generation: PayloadGeneration;
  attempts: PayloadGenerationAttempt[];
  revisions: PayloadRevision[];
  outcomes: PayloadObservedOutcome[];
}

interface PayloadRefineInput {
  feedback: string;
  candidateCount?: number;
  diversity?: "low" | "balanced" | "high";
  confirmProjectReadOnly?: boolean;
}

export interface CodexGenerationResult {
  readonly text: string;
  readonly reasoning: string;
  readonly classification: RunClassification | null;
  readonly usage: JsonObject | null;
  readonly traceHash: string | null;
  readonly nativeThreadId: string | null;
  readonly nativeTurnId: string | null;
  readonly metadata: JsonObject;
}

export interface CodexPayloadGenerator {
  probe(backend: Extract<PayloadGeneratorProfileValue["backend"], { kind: "codex-app-server" }>): Promise<JsonObject>;
  generate(input: {
    backend: Extract<PayloadGeneratorProfileValue["backend"], { kind: "codex-app-server" }>;
    systemPrompt: string;
    operatorPrompt: string;
    workspaceRoot: string | null;
    stagingDirectory: string;
    parentNativeThreadId: string | null;
    parentNativeTurnId: string | null;
    /** True when the stored parent payload is being replayed for refinement. */
    isRefinement: boolean;
    signal: AbortSignal;
    redactionEnabled: boolean;
    onText(delta: string): void;
    onReasoning(delta: string): void;
  }): Promise<CodexGenerationResult>;
}

export class PayloadGenerationRequestError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 422 = 400) {
    super(message);
    this.name = "PayloadGenerationRequestError";
  }
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function object(value: JsonValue | null): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function attemptRedactionEnabled(attempt: PayloadGenerationAttempt): boolean {
  return attempt.backendSnapshot.redactionEnabled !== false;
}

function activeAsset(assets: readonly AssetRevision[], revisionId: string, kind: AssetRevision["kind"]): AssetRevision {
  const asset = assets.find((item) => item.id === revisionId && item.kind === kind && item.archivedAt === null);
  if (!asset) throw new PayloadGenerationRequestError(`${kind} revision not found or archived`, 404);
  if (!asset.trusted) throw new PayloadGenerationRequestError(`${kind} revision is untrusted; save a trusted revision before using it`, 409);
  return asset;
}

function historicalAsset(assets: readonly AssetRevision[], revisionId: string, kind: AssetRevision["kind"]): AssetRevision {
  const asset = assets.find((item) => item.id === revisionId && item.kind === kind);
  if (!asset) throw new PayloadGenerationRequestError(`${kind} revision not found`, 404);
  if (!asset.trusted) throw new PayloadGenerationRequestError(`${kind} revision is untrusted; save a trusted revision before using it`, 409);
  return asset;
}

function safeUnexpectedMessage(error: unknown): string {
  return error instanceof PayloadGenerationRequestError
    ? error.message
    : "Payload candidate failed because of an unexpected internal generator error.";
}

function unexpectedClassification(error: unknown, signal: AbortSignal): RunClassification {
  if (signal.aborted) return "cancelled";
  if (error instanceof PayloadGenerationRequestError) return "invalid-request";
  return "unknown";
}

function providerAdapterProfile(profile: ProviderProfile) {
  return {
    id: profile.id,
    label: profile.label,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    credential: profile.credential,
    headers: profile.headers,
    extraBody: profile.extraBody,
    endpointOverride: profile.endpointOverride,
    models: profile.models
  } as const;
}

function safeHttpBackendSnapshot(
  profile: ProviderProfile,
  backend: Extract<PayloadGeneratorProfileValue["backend"], { kind: "http-provider" }>,
  temperature: number,
  redactionEnabled: boolean,
): JsonObject {
  const knownSecrets = providerSecretValues(profile);
  return {
    kind: "http-provider",
    providerProfileId: profile.id,
    providerRevision: profile.revision,
    protocol: profile.protocol,
    label: profile.label,
    baseUrl: redactUrl(profile.baseUrl, knownSecrets, redactionEnabled),
    endpointOverride: profile.endpointOverride === null ? null : redactUrl(profile.endpointOverride, knownSecrets, redactionEnabled),
    modelId: backend.modelId,
    temperature,
    maxOutputTokens: backend.maxOutputTokens,
    reasoning: backend.reasoning,
    headers: redactHeaders(profile.headers, knownSecrets, redactionEnabled),
    extraBody: redactProviderJson(profile.extraBody, knownSecrets, redactionEnabled),
    redactionEnabled
  };
}

function safeProviderErrorMessage(profile: ProviderProfile, error: unknown, redactionEnabled: boolean): string {
  return redactProviderText(
    error instanceof Error ? error.message : String(error),
    providerSecretValues(profile),
    redactionEnabled
  );
}

function generatorReasoningBody(profile: ProviderProfile, enabled: boolean): JsonObject {
  if (profile.protocol === "openai-chat") return { reasoning: { enabled } };
  if (profile.protocol === "openai-responses") {
    return { reasoning: enabled ? { effort: "medium", summary: "auto" } : { effort: "none" } };
  }
  return { thinking: enabled ? { type: "adaptive" } : { type: "disabled" } };
}

function techniqueFromAsset(asset: AssetRevision): PayloadTechnique {
  const parsed = payloadTechniqueValueSchema.parse(asset.value);
  return {
    revisionId: asset.id,
    assetId: asset.assetId,
    name: asset.name,
    instructions: parsed.instructions,
    conflictsWith: parsed.conflictsWith,
    before: parsed.before,
    after: parsed.after
  };
}

function attemptOutputText(attempt: PayloadGenerationAttempt): string {
  const text = object(attempt.normalizedOutput).text;
  return typeof text === "string" ? text : "";
}

export class PayloadGenerationCoordinator {
  private readonly controllers = new Map<string, AbortController>();
  private readonly codexProjectReadTrust = new Set<string>();
  private readonly sessionGenerationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: LatheRepository,
    private readonly contentStore: ContentStore,
    private readonly events: EventHub,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly codex?: CodexPayloadGenerator
  ) {}

  private async assertBackendAvailable(value: PayloadGeneratorProfileValue): Promise<void> {
    if (value.backend.kind === "codex-app-server") {
      if (!this.codex) throw new PayloadGenerationRequestError("Codex App Server support is unavailable", 409);
      return;
    }
    const provider = await this.repository.getProviderProfile(value.backend.providerProfileRevisionId);
    if (!provider) throw new PayloadGenerationRequestError("Referenced provider revision is unavailable", 409);
    if (provider.models.length > 0 && !provider.models.some((model) => model.id === value.backend.modelId)) {
      throw new PayloadGenerationRequestError("Generator model is not present in the referenced provider revision", 409);
    }
  }

  private requireProjectReadTrust(
    sessionId: string,
    profileAsset: AssetRevision,
    value: PayloadGeneratorProfileValue,
    confirmed: boolean
  ): void {
    if (value.backend.kind !== "codex-app-server" || value.backend.workspaceAccess !== "project-read-only") return;
    const trustKey = `${sessionId}:${profileAsset.id}`;
    if (this.codexProjectReadTrust.has(trustKey)) return;
    if (!confirmed) {
      throw new PayloadGenerationRequestError("This Codex profile can read the project workspace. Confirm project read-only access for this profile revision before generating.", 409);
    }
    this.codexProjectReadTrust.add(trustKey);
  }

  private async withSessionGenerationLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const predecessor = this.sessionGenerationLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.then(() => gate);
    this.sessionGenerationLocks.set(sessionId, tail);
    await predecessor;
    try {
      return await task();
    } finally {
      release();
      if (this.sessionGenerationLocks.get(sessionId) === tail) this.sessionGenerationLocks.delete(sessionId);
    }
  }

  private async assertNoActiveGeneration(sessionId: string): Promise<void> {
    const active = await this.repository.getActivePayloadGeneration(sessionId);
    if (!active) return;
    throw new PayloadGenerationRequestError(
      "A payload generation is already active for this session. Cancel or finish it before starting another.",
      409
    );
  }

  private async observedOutcomes(sessionId: string, revisions: readonly PayloadRevision[]): Promise<PayloadObservedOutcome[]> {
    const [nodes, runs] = await Promise.all([
      this.repository.listNodes(sessionId),
      this.repository.listRuns(sessionId)
    ]);
    const revisionIds = new Set(revisions.map((revision) => revision.id));
    const sourceNodes = new Map(nodes.flatMap((node) => node.sourcePayloadRevisionId && revisionIds.has(node.sourcePayloadRevisionId)
      ? [[node.id, node] as const]
      : []));
    return runs.flatMap((run) => {
      if (!run.contextNodeId) return [];
      const node = sourceNodes.get(run.contextNodeId);
      if (!node?.sourcePayloadRevisionId) return [];
      return [{
        revisionId: node.sourcePayloadRevisionId,
        nodeId: node.id,
        runId: run.id,
        branchId: run.branchId,
        status: run.status,
        classification: run.classification,
        operatorLabel: run.operatorLabel,
        operatorNotes: run.operatorNotes,
        createdAt: run.createdAt
      }];
    }).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getDetail(id: string): Promise<PayloadGenerationDetail | null> {
    const generation = await this.repository.getPayloadGeneration(id);
    if (!generation) return null;
    const [attempts, revisions] = await Promise.all([
      this.repository.listPayloadGenerationAttempts(id),
      this.repository.listPayloadRevisionsForGeneration(id)
    ]);
    const outcomes = await this.observedOutcomes(generation.sessionId, revisions);
    return { generation, attempts, revisions, outcomes };
  }

  async getStandaloneHistory(sessionId: string): Promise<{ revisions: PayloadRevision[]; outcomes: PayloadObservedOutcome[] }> {
    const revisions = (await this.repository.listPayloadRevisions(sessionId)).filter((revision) => revision.generationId === null);
    return { revisions, outcomes: await this.observedOutcomes(sessionId, revisions) };
  }

  async probeProfile(revisionId: string): Promise<JsonObject> {
    const assets = await this.repository.listAssetRevisions("payload-generator-profile");
    const asset = activeAsset(assets, revisionId, "payload-generator-profile");
    const value = payloadGeneratorProfileValueSchema.parse(asset.value);
    if (value.backend.kind === "http-provider") {
      const provider = await this.repository.getProviderProfile(value.backend.providerProfileRevisionId);
      if (!provider) throw new PayloadGenerationRequestError("Referenced provider revision is unavailable", 409);
      return {
        backend: "http-provider",
        providerProfileId: provider.id,
        providerLabel: provider.label,
        protocol: provider.protocol,
        selectedModelId: value.backend.modelId,
        models: jsonClone(provider.models.map((model) => ({ id: model.id, label: model.label, capabilities: model.capabilities }))) as unknown as JsonValue,
        ready: provider.models.length === 0 || provider.models.some((model) => model.id === value.backend.modelId)
      };
    }
    if (!this.codex) throw new PayloadGenerationRequestError("Codex App Server support is unavailable", 409);
    try {
      return await this.codex.probe(value.backend);
    } catch (error) {
      const classification = error && typeof error === "object" ? (error as { classification?: unknown }).classification : null;
      throw new PayloadGenerationRequestError(
        error instanceof Error ? error.message : "Codex App Server probe failed",
        classification === "invalid-profile" ? 422 : 409
      );
    }
  }

  async preview(input: {
    sessionId: string;
    branchId: string;
    contextNodeId: string | null;
    options: CreatePayloadGenerationInput["context"];
    variables?: Readonly<Record<string, string>>;
  }) {
    return resolvePayloadContext(this.repository, {
      sessionId: input.sessionId,
      branchId: input.branchId,
      contextNodeId: input.contextNodeId,
      options: {
        mode: input.options.mode,
        includeProjectBrief: input.options.includeProjectBrief,
        includeSessionBrief: input.options.includeSessionBrief,
        includeTargetConfig: input.options.includeTargetConfig,
        budgetChars: input.options.budgetChars
      },
      ...(input.variables === undefined ? {} : { variableOverrides: input.variables })
    });
  }

  async start(input: CreatePayloadGenerationInput): Promise<PayloadGenerationDetail> {
    return this.withSessionGenerationLock(input.sessionId, async () => {
      await this.assertNoActiveGeneration(input.sessionId);
      return this.startLocked(input);
    });
  }

  private async startLocked(input: CreatePayloadGenerationInput): Promise<PayloadGenerationDetail> {
    const context = await this.preview({
      sessionId: input.sessionId,
      branchId: input.branchId,
      contextNodeId: input.contextNodeId,
      options: input.context,
      variables: input.variables
    });
    if (!context.compiled.manifest.fits) {
      throw new PayloadGenerationRequestError(context.compiled.manifest.warnings.join(" ") || "Payload context exceeds its budget", 422);
    }
    const assets = await this.repository.listAssetRevisions();
    const profileAsset = activeAsset(assets, input.profileRevisionId, "payload-generator-profile");
    const profileValue = payloadGeneratorProfileValueSchema.parse(profileAsset.value);
    await this.assertBackendAvailable(profileValue);
    this.requireProjectReadTrust(input.sessionId, profileAsset, profileValue, input.confirmProjectReadOnly);
    const instructionTemplate = input.instructionRevisionId
      ? payloadGeneratorInstructionValueSchema.parse(
          activeAsset(assets, input.instructionRevisionId, "payload-generator-instruction").value
        ).template
      : "";
    const techniques = input.techniqueRevisionIds.map((id) => techniqueFromAsset(activeAsset(assets, id, "payload-technique")));
    const preflight = compileGeneratorInstructions({
      instructionTemplate,
      operatorInstruction: input.operatorInstruction,
      techniques,
      variables: context.variables,
      compiledContext: context.compiled.text,
      candidateOrdinal: 1,
      candidateCount: input.candidateCount,
      diversity: input.diversity
    });
    if (preflight.missingVariables.length > 0) {
      throw new PayloadGenerationRequestError(`Resolve missing payload variables before generating: ${preflight.missingVariables.join(", ")}`, 422);
    }
    if (input.parentRevisionId) {
      const parent = await this.repository.getPayloadRevision(input.parentRevisionId);
      if (!parent || parent.sessionId !== input.sessionId) throw new PayloadGenerationRequestError("Parent payload revision does not belong to this session", 409);
    }
    const contextSnapshot: JsonObject = {
      text: context.compiled.text,
      manifest: jsonClone(context.compiled.manifest) as unknown as JsonValue,
      variables: context.variables,
      techniqueWarnings: jsonClone(preflight.techniqueWarnings) as unknown as JsonValue,
      branchId: context.branchId,
      contextNodeId: context.contextNodeId
    };
    const generation = await this.repository.createPayloadGeneration({
      projectId: context.projectId,
      sessionId: input.sessionId,
      branchId: input.branchId,
      contextNodeId: input.contextNodeId,
      parentRevisionId: input.parentRevisionId,
      feedback: input.feedback,
      operatorInstruction: input.operatorInstruction,
      generatorProfileRevisionId: input.profileRevisionId,
      instructionRevisionId: input.instructionRevisionId,
      techniqueRevisionIds: input.techniqueRevisionIds,
      pipelineRevisionId: null,
      variables: jsonClone(context.variables) as unknown as JsonObject,
      contextOptions: {
        contextMode: input.context.mode,
        includeProjectBrief: input.context.includeProjectBrief,
        includeSessionBrief: input.context.includeSessionBrief,
        includeTargetConfig: input.context.includeTargetConfig,
        budgetChars: input.context.budgetChars
      },
      candidateCount: input.candidateCount,
      diversity: input.diversity,
      contextSnapshot
    });
    let detail: PayloadGenerationDetail;
    try {
      detail = await this.prepareAttempts(generation, profileAsset);
    } catch (error) {
      await this.failUnfinishedGroup(generation.id, new AbortController().signal, safeUnexpectedMessage(error));
      throw error;
    }
    this.events.publish(`payload-generation:${generation.id}`, "generation.queued", generation as unknown as JsonValue);
    this.scheduleGroup(generation.id);
    return detail;
  }

  async refine(parentRevisionId: string, input: PayloadRefineInput): Promise<PayloadGenerationDetail> {
    const parent = await this.repository.getPayloadRevision(parentRevisionId);
    if (!parent || !parent.generationId) throw new PayloadGenerationRequestError("Payload revision cannot be refined", 404);
    const source = await this.repository.getPayloadGeneration(parent.generationId);
    if (!source) throw new PayloadGenerationRequestError("Source payload generation not found", 404);
    return this.withSessionGenerationLock(source.sessionId, async () => {
      await this.assertNoActiveGeneration(source.sessionId);
      return this.refineLocked(parent, source, input);
    });
  }

  private async refineLocked(
    parent: PayloadRevision,
    source: PayloadGeneration,
    input: PayloadRefineInput
  ): Promise<PayloadGenerationDetail> {
    const assets = await this.repository.listAssetRevisions(undefined, true);
    const profileAsset = historicalAsset(assets, source.generatorProfileRevisionId, "payload-generator-profile");
    const profileValue = payloadGeneratorProfileValueSchema.parse(profileAsset.value);
    await this.assertBackendAvailable(profileValue);
    this.requireProjectReadTrust(source.sessionId, profileAsset, profileValue, input.confirmProjectReadOnly ?? false);
    const instructionTemplate = source.instructionRevisionId
      ? payloadGeneratorInstructionValueSchema.parse(
          historicalAsset(assets, source.instructionRevisionId, "payload-generator-instruction").value
        ).template
      : "";
    const techniques = source.techniqueRevisionIds.map((id) => techniqueFromAsset(historicalAsset(assets, id, "payload-technique")));
    const variables = Object.fromEntries(Object.entries(source.variables).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const snapshotText = source.contextSnapshot.text;
    const preflight = compileGeneratorInstructions({
      instructionTemplate,
      operatorInstruction: `${source.operatorInstruction}\n\nPrevious candidate:\n${parent.text}\n\nRefinement feedback:\n${input.feedback}`,
      techniques,
      variables,
      compiledContext: typeof snapshotText === "string" ? snapshotText : "",
      candidateOrdinal: 1,
      candidateCount: input.candidateCount ?? source.candidateCount,
      diversity: input.diversity ?? source.diversity
    });
    if (preflight.missingVariables.length > 0) {
      throw new PayloadGenerationRequestError(`Resolve missing payload variables before refining: ${preflight.missingVariables.join(", ")}`, 422);
    }
    const generation = await this.repository.createPayloadGeneration({
      projectId: source.projectId,
      sessionId: source.sessionId,
      branchId: source.branchId,
      contextNodeId: source.contextNodeId,
      parentRevisionId: parent.id,
      feedback: input.feedback,
      operatorInstruction: source.operatorInstruction,
      generatorProfileRevisionId: source.generatorProfileRevisionId,
      instructionRevisionId: source.instructionRevisionId,
      techniqueRevisionIds: source.techniqueRevisionIds,
      pipelineRevisionId: source.pipelineRevisionId,
      variables: source.variables,
      contextOptions: source.contextOptions,
      candidateCount: input.candidateCount ?? source.candidateCount,
      diversity: input.diversity ?? source.diversity,
      contextSnapshot: source.contextSnapshot
    });
    let detail: PayloadGenerationDetail;
    try {
      detail = await this.prepareAttempts(generation, profileAsset);
    } catch (error) {
      await this.failUnfinishedGroup(generation.id, new AbortController().signal, safeUnexpectedMessage(error));
      throw error;
    }
    this.events.publish(`payload-generation:${generation.id}`, "generation.queued", generation as unknown as JsonValue);
    this.scheduleGroup(generation.id);
    return detail;
  }

  async cancel(id: string): Promise<boolean> {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort(new DOMException("Cancelled by operator", "AbortError"));
    return true;
  }

  private scheduleGroup(generationId: string): void {
    const controller = new AbortController();
    this.controllers.set(generationId, controller);
    void this.runScheduledGroup(generationId, controller);
  }

  private async runScheduledGroup(generationId: string, controller: AbortController): Promise<void> {
    try {
      await this.performGroup(generationId, controller);
    } catch (error) {
      const message = safeUnexpectedMessage(error);
      let status: PayloadGeneration["status"] = controller.signal.aborted ? "cancelled" : "failed";
      try {
        status = await this.failUnfinishedGroup(generationId, controller.signal, message);
      } catch {
        // Persistence itself failed. The startup recovery pass will convert any
        // remaining queued/streaming records to interrupted on the next launch.
      }
      this.events.publish(`payload-generation:${generationId}`, `generation.${status}`, { generationId, status, message });
    } finally {
      if (this.controllers.get(generationId) === controller) this.controllers.delete(generationId);
    }
  }

  private async failUnexpectedAttempt(
    generation: PayloadGeneration,
    attempt: PayloadGenerationAttempt,
    signal: AbortSignal,
    error: unknown
  ): Promise<void> {
    const current = await this.repository.getPayloadGenerationAttempt(attempt.id);
    if (!current || !["queued", "streaming", "awaiting-tool"].includes(current.status)) return;
    const classification = unexpectedClassification(error, signal);
    const status = classification === "cancelled" ? "cancelled" : "failed";
    const message = safeUnexpectedMessage(error);
    const output = object(current.normalizedOutput);
    const revision = (await this.repository.listPayloadRevisionsForGeneration(generation.id))
      .find((item) => item.attemptId === current.id);
    const text = attemptOutputText(current) || revision?.text || "";
    await this.repository.updatePayloadGenerationAttempt(current.id, {
      status,
      classification,
      normalizedOutput: { ...output, text, error: message },
      ...(current.startedAt === null ? { startedAt: nowIso() } : {}),
      finishedAt: nowIso()
    });
    this.events.publish(`payload-generation:${generation.id}`, "candidate.failed", {
      attemptId: current.id,
      ordinal: current.ordinal,
      classification,
      message
    });
  }

  private async failUnfinishedGroup(
    generationId: string,
    signal: AbortSignal,
    message: string
  ): Promise<PayloadGeneration["status"]> {
    const [attempts, revisions] = await Promise.all([
      this.repository.listPayloadGenerationAttempts(generationId),
      this.repository.listPayloadRevisionsForGeneration(generationId)
    ]);
    const classification: RunClassification = signal.aborted ? "cancelled" : "unknown";
    const attemptStatus = signal.aborted ? "cancelled" : "failed";
    for (const attempt of attempts) {
      if (!["queued", "streaming", "awaiting-tool"].includes(attempt.status)) continue;
      const output = object(attempt.normalizedOutput);
      const text = attemptOutputText(attempt) || revisions.find((revision) => revision.attemptId === attempt.id)?.text || "";
      await this.repository.updatePayloadGenerationAttempt(attempt.id, {
        status: attemptStatus,
        classification,
        normalizedOutput: { ...output, text, error: message },
        ...(attempt.startedAt === null ? { startedAt: nowIso() } : {}),
        finishedAt: nowIso()
      });
    }
    const terminalAttempts = await this.repository.listPayloadGenerationAttempts(generationId);
    const hasOutput = terminalAttempts.some((attempt) => attemptOutputText(attempt).length > 0);
    const completed = terminalAttempts.some((attempt) => attempt.status === "completed" && attempt.classification === null);
    const status: PayloadGeneration["status"] = signal.aborted ? "cancelled" : hasOutput || completed ? "partial" : "failed";
    await this.repository.updatePayloadGeneration(generationId, { status });
    return status;
  }

  private async prepareAttempts(generation: PayloadGeneration, profileAsset: AssetRevision): Promise<PayloadGenerationDetail> {
    const value = payloadGeneratorProfileValueSchema.parse(profileAsset.value);
    const { redactionEnabled } = await this.repository.getApplicationSettings();
    let provider: ProviderProfile | null = null;
    if (value.backend.kind === "http-provider") {
      provider = await this.repository.getProviderProfile(value.backend.providerProfileRevisionId);
      if (!provider) throw new PayloadGenerationRequestError("Referenced provider revision is unavailable", 409);
      if (provider.models.length > 0 && !provider.models.some((model) => model.id === value.backend.modelId)) {
        throw new PayloadGenerationRequestError("Generator model is not present in the referenced provider revision", 409);
      }
    } else if (!this.codex) {
      throw new PayloadGenerationRequestError("Codex App Server support is unavailable", 409);
    }
    const attempts: PayloadGenerationAttempt[] = [];
    for (let ordinal = 1; ordinal <= generation.candidateCount; ordinal += 1) {
      const temperature = value.backend.kind === "http-provider" ? value.backend.temperatures[generation.diversity] : null;
      const backendSnapshot = value.backend.kind === "http-provider" && provider
        ? safeHttpBackendSnapshot(provider, value.backend, temperature ?? 0.7, redactionEnabled)
        : {
            ...(redactProviderJson(jsonClone(value.backend) as unknown as JsonValue, [], redactionEnabled) as JsonObject),
            redactionEnabled
          };
      attempts.push(await this.repository.createPayloadGenerationAttempt({
        generationId: generation.id,
        ordinal,
        backendSnapshot,
        providerProfileId: value.backend.kind === "http-provider" ? value.backend.providerProfileRevisionId : null,
        modelId: value.backend.modelId,
        configSnapshotId: null,
        nativeThreadId: null,
        nativeTurnId: null
      }));
    }
    return { generation, attempts, revisions: [], outcomes: [] };
  }

  private async performGroup(generationId: string, controller: AbortController): Promise<void> {
    const generation = await this.repository.getPayloadGeneration(generationId);
    if (!generation) return;
    const assets = await this.repository.listAssetRevisions(undefined, true);
    const profileAsset = historicalAsset(assets, generation.generatorProfileRevisionId, "payload-generator-profile");
    const profileValue = payloadGeneratorProfileValueSchema.parse(profileAsset.value);
    const attempts = await this.repository.listPayloadGenerationAttempts(generation.id);
    await this.repository.updatePayloadGeneration(generation.id, { status: "streaming" });
    this.events.publish(`payload-generation:${generation.id}`, "generation.started", { generationId: generation.id });
    let next = 0;
    const concurrency = profileValue.backend.kind === "http-provider" ? Math.min(2, attempts.length) : 1;
    const worker = async () => {
      while (next < attempts.length && !controller.signal.aborted) {
        const attempt = attempts[next++];
        if (!attempt) return;
        try {
          await this.performAttempt(generation, attempt, profileAsset, assets, controller.signal);
        } catch (error) {
          await this.failUnexpectedAttempt(generation, attempt, controller.signal, error);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (controller.signal.aborted) {
      for (const attempt of await this.repository.listPayloadGenerationAttempts(generation.id)) {
        if (attempt.status === "queued") {
          await this.repository.updatePayloadGenerationAttempt(attempt.id, {
            status: "cancelled",
            classification: "cancelled",
            startedAt: nowIso(),
            finishedAt: nowIso()
          });
        }
      }
    }
    await this.finishGroup(generation.id, controller.signal.aborted);
  }

  private async performAttempt(generation: PayloadGeneration, attempt: PayloadGenerationAttempt, profileAsset: AssetRevision, assets: readonly AssetRevision[], signal: AbortSignal): Promise<void> {
    const profileValue = payloadGeneratorProfileValueSchema.parse(profileAsset.value);
    const instructionAsset = generation.instructionRevisionId
      ? historicalAsset(assets, generation.instructionRevisionId, "payload-generator-instruction")
      : null;
    const instructionTemplate = instructionAsset ? payloadGeneratorInstructionValueSchema.parse(instructionAsset.value).template : "";
    const techniques = generation.techniqueRevisionIds.map((id) => techniqueFromAsset(historicalAsset(assets, id, "payload-technique")));
    const snapshotText = generation.contextSnapshot.text;
    const compiledContext = typeof snapshotText === "string" ? snapshotText : "";
    const variables = Object.fromEntries(Object.entries(generation.variables).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    let operatorInstruction = generation.operatorInstruction;
    if (generation.parentRevisionId) {
      const parent = await this.repository.getPayloadRevision(generation.parentRevisionId);
      if (!parent) throw new Error("Parent payload revision disappeared");
      operatorInstruction = `${operatorInstruction}\n\nPrevious candidate:\n${parent.text}\n\nRefinement feedback:\n${generation.feedback ?? "Refine this candidate."}`;
    }
    const compiled = compileGeneratorInstructions({
      instructionTemplate,
      operatorInstruction,
      techniques,
      variables,
      compiledContext,
      candidateOrdinal: attempt.ordinal,
      candidateCount: generation.candidateCount,
      diversity: generation.diversity
    });
    if (compiled.missingVariables.length > 0) {
      await this.repository.updatePayloadGenerationAttempt(attempt.id, {
        status: "failed", classification: "invalid-request",
        normalizedOutput: { text: "", reasoning: "", error: `Missing variables: ${compiled.missingVariables.join(", ")}` },
        finishedAt: nowIso()
      });
      this.events.publish(`payload-generation:${generation.id}`, "candidate.failed", { attemptId: attempt.id, ordinal: attempt.ordinal, classification: "invalid-request" });
      return;
    }
    await this.repository.updatePayloadGenerationAttempt(attempt.id, { status: "streaming", startedAt: nowIso() });
    this.events.publish(`payload-generation:${generation.id}`, "candidate.started", { attemptId: attempt.id, ordinal: attempt.ordinal });
    if (profileValue.backend.kind === "http-provider") {
      await this.performHttpAttempt(generation, attempt, profileValue.backend, compiled.systemPrompt, compiled.operatorPrompt, compiled.techniqueWarnings.map((item) => item.message), signal);
      return;
    }
    await this.performCodexAttempt(generation, attempt, profileValue.backend, compiled.systemPrompt, compiled.operatorPrompt, compiled.techniqueWarnings.map((item) => item.message), signal);
  }

  private async performHttpAttempt(
    generation: PayloadGeneration,
    attempt: PayloadGenerationAttempt,
    backend: Extract<PayloadGeneratorProfileValue["backend"], { kind: "http-provider" }>,
    systemPrompt: string,
    operatorPrompt: string,
    techniqueWarnings: string[],
    signal: AbortSignal
  ): Promise<void> {
    const provider = await this.repository.getProviderProfile(backend.providerProfileRevisionId);
    if (!provider) throw new Error("Generator provider revision disappeared");
    const redactionEnabled = attemptRedactionEnabled(attempt);
    const request: CanonicalGenerationRequest = {
      model: backend.modelId,
      messages: [{ role: "user", content: operatorPrompt }],
      systemPrompt,
      temperature: backend.temperatures[generation.diversity],
      ...(backend.maxOutputTokens === null ? {} : { maxOutputTokens: backend.maxOutputTokens }),
      extraBody: generatorReasoningBody(provider, backend.reasoning),
      stream: true
    };
    const trace = await this.contentStore.createTraceWriter();
    const outcome = new ProviderOutcomeTracker();
    let text = "";
    let reasoning = "";
    let usage: ProviderUsage | undefined;
    let failure: ProviderFailure | undefined;
    let finalized = false;
    let revisionCreated = false;
    let compileWarnings: string[] = [];
    try {
      compileWarnings = compileProviderRequest(providerAdapterProfile(provider), request).warnings.map((warning) => warning.message);
      for await (const item of executeProviderRequest(providerAdapterProfile(provider), request, {
        signal,
        fetch: this.fetchImpl,
        redactionEnabled
      })) {
        await trace.append({
          direction: item.trace.kind === "request" ? "request" : item.trace.kind === "error" ? "internal" : "response",
          kind: item.trace.kind === "sse" ? "sse" : item.trace.kind === "error" ? "error" : "body",
          timestamp: item.trace.occurredAt,
          data: item.trace.data
        });
        for (const event of item.events) {
          outcome.consume(event);
          if (event.type === "content.delta") {
            text += event.text;
            this.events.publish(`payload-generation:${generation.id}`, "candidate.text.delta", { attemptId: attempt.id, ordinal: attempt.ordinal, text: event.text });
          } else if (event.type === "reasoning.delta") {
            reasoning += event.text;
            this.events.publish(`payload-generation:${generation.id}`, "candidate.reasoning.delta", { attemptId: attempt.id, ordinal: attempt.ordinal, text: event.text });
          } else if (event.type === "usage") usage = event.usage;
          else if (event.type === "provider.error") failure = event.error;
          this.events.publish(`payload-generation:${generation.id}`, `provider.${event.type}`, { attemptId: attempt.id, ordinal: attempt.ordinal, event: event as unknown as JsonValue });
        }
      }
      const stored = await trace.finalize();
      finalized = true;
      const classification = failure?.classification ?? outcome.classification();
      const status = classification === "cancelled"
        ? "cancelled"
        : classification === null
          ? "completed"
          : "failed";
      if (text.length > 0) {
        await this.repository.createPayloadRevision({
          projectId: generation.projectId,
          sessionId: generation.sessionId,
          generationId: generation.id,
          attemptId: attempt.id,
          parentRevisionId: generation.parentRevisionId,
          ordinal: attempt.ordinal,
          operation: generation.parentRevisionId ? "refined" : "generated",
          text,
          provenance: {
            backend: "http-provider",
            attemptId: attempt.id,
            contextHash: generation.contextHash,
            generatorProfileRevisionId: generation.generatorProfileRevisionId,
            instructionRevisionId: generation.instructionRevisionId,
            techniqueRevisionIds: generation.techniqueRevisionIds,
            diversity: generation.diversity
          }
        });
        revisionCreated = true;
      }
      const usageValue = usage ? jsonClone(usage) as unknown as JsonObject : null;
      await this.repository.updatePayloadGenerationAttempt(attempt.id, {
        status,
        classification,
        normalizedOutput: {
          text,
          reasoning,
          providerOutcome: outcome.toJson(),
          compileWarnings,
          techniqueWarnings,
          redactionEnabled,
          ...(failure ? { error: failure as unknown as JsonValue } : {})
        },
        usage: usageValue,
        traceHash: stored.sha256,
        finishedAt: nowIso()
      });
      this.events.publish(`payload-generation:${generation.id}`, status === "completed" ? "candidate.completed" : "candidate.failed", {
        attemptId: attempt.id,
        ordinal: attempt.ordinal,
        status,
        classification,
        text,
        reasoning,
        traceHash: stored.sha256
      });
    } catch (error) {
      if (text.length > 0 && !revisionCreated) {
        await this.repository.createPayloadRevision({
          projectId: generation.projectId,
          sessionId: generation.sessionId,
          generationId: generation.id,
          attemptId: attempt.id,
          parentRevisionId: generation.parentRevisionId,
          ordinal: attempt.ordinal,
          operation: generation.parentRevisionId ? "refined" : "generated",
          text,
          provenance: {
            backend: "http-provider",
            attemptId: attempt.id,
            contextHash: generation.contextHash,
            partial: true
          }
        });
        revisionCreated = true;
      }
      const errorMessage = safeProviderErrorMessage(provider, error, redactionEnabled);
      if (!finalized) {
        await trace.append({ direction: "internal", kind: "error", data: { message: errorMessage } });
        const stored = await trace.finalize();
        finalized = true;
        await this.repository.updatePayloadGenerationAttempt(attempt.id, { traceHash: stored.sha256 });
      }
      const cancelled = signal.aborted;
      await this.repository.updatePayloadGenerationAttempt(attempt.id, {
        status: cancelled ? "cancelled" : "failed",
        classification: cancelled ? "cancelled" : "unknown",
        normalizedOutput: { text, reasoning, providerOutcome: outcome.toJson(), redactionEnabled, error: errorMessage },
        finishedAt: nowIso()
      });
      this.events.publish(`payload-generation:${generation.id}`, "candidate.failed", { attemptId: attempt.id, ordinal: attempt.ordinal, classification: cancelled ? "cancelled" : "unknown", text, reasoning });
    } finally {
      if (!finalized) await trace.abort();
    }
  }

  private async performCodexAttempt(
    generation: PayloadGeneration,
    attempt: PayloadGenerationAttempt,
    backend: Extract<PayloadGeneratorProfileValue["backend"], { kind: "codex-app-server" }>,
    systemPrompt: string,
    operatorPrompt: string,
    techniqueWarnings: string[],
    signal: AbortSignal
  ): Promise<void> {
    if (!this.codex) throw new Error("Codex App Server support is unavailable");
    const redactionEnabled = attemptRedactionEnabled(attempt);
    const project = await this.repository.getProject(generation.projectId);
    if (!project) throw new Error("Project disappeared");
    const parentAttempt = generation.parentRevisionId
      ? await this.repository.getPayloadRevision(generation.parentRevisionId).then((revision) => revision?.attemptId ? this.repository.getPayloadGenerationAttempt(revision.attemptId) : null)
      : null;
    let streamedText = "";
    let streamedReasoning = "";
    let revisionCreated = false;
    try {
      const result = await this.codex.generate({
        backend,
        systemPrompt,
        operatorPrompt,
        workspaceRoot: project.workspaceRoot,
        stagingDirectory: this.contentStore.stagingDirectory,
        parentNativeThreadId: parentAttempt?.nativeThreadId ?? null,
        parentNativeTurnId: parentAttempt?.nativeTurnId ?? null,
        isRefinement: generation.parentRevisionId !== null,
        signal,
        redactionEnabled,
        onText: (delta) => {
          streamedText += delta;
          this.events.publish(`payload-generation:${generation.id}`, "candidate.text.delta", { attemptId: attempt.id, ordinal: attempt.ordinal, text: delta });
        },
        onReasoning: (delta) => {
          streamedReasoning += delta;
          this.events.publish(`payload-generation:${generation.id}`, "candidate.reasoning.delta", { attemptId: attempt.id, ordinal: attempt.ordinal, text: delta });
        }
      });
      if (result.text.length > 0) {
        await this.repository.createPayloadRevision({
          projectId: generation.projectId,
          sessionId: generation.sessionId,
          generationId: generation.id,
          attemptId: attempt.id,
          parentRevisionId: generation.parentRevisionId,
          ordinal: attempt.ordinal,
          operation: generation.parentRevisionId ? "refined" : "generated",
          text: result.text,
          provenance: { backend: "codex-app-server", attemptId: attempt.id, contextHash: generation.contextHash, techniqueWarnings }
        });
        revisionCreated = true;
      }
      await this.repository.updatePayloadGenerationAttempt(attempt.id, {
        status: result.classification === "cancelled" ? "cancelled" : result.classification ? "failed" : "completed",
        classification: result.classification,
        normalizedOutput: { text: result.text, reasoning: result.reasoning, metadata: result.metadata, techniqueWarnings, redactionEnabled },
        usage: result.usage,
        traceHash: result.traceHash,
        nativeThreadId: result.nativeThreadId,
        nativeTurnId: result.nativeTurnId,
        finishedAt: nowIso()
      });
      this.events.publish(`payload-generation:${generation.id}`, result.classification ? "candidate.failed" : "candidate.completed", {
        attemptId: attempt.id, ordinal: attempt.ordinal, classification: result.classification, text: result.text, reasoning: result.reasoning
      });
    } catch (error) {
      const cancelled = signal.aborted;
      const details = error && typeof error === "object" ? error as { classification?: unknown; traceHash?: unknown } : {};
      const classification: RunClassification = cancelled
        ? "cancelled"
        : details.classification === "authentication"
          ? "authentication"
          : details.classification === "invalid-profile"
            ? "invalid-request"
            : details.classification === "protocol"
              ? "parse-failure"
              : details.classification === "timeout"
                ? "timeout"
                : details.classification === "transport" || details.classification === "crash"
                  ? "transport"
                  : "unknown";
      if (streamedText.length > 0 && !revisionCreated) {
        await this.repository.createPayloadRevision({
          projectId: generation.projectId,
          sessionId: generation.sessionId,
          generationId: generation.id,
          attemptId: attempt.id,
          parentRevisionId: generation.parentRevisionId,
          ordinal: attempt.ordinal,
          operation: generation.parentRevisionId ? "refined" : "generated",
          text: streamedText,
          provenance: { backend: "codex-app-server", attemptId: attempt.id, contextHash: generation.contextHash, partial: true }
        });
        revisionCreated = true;
      }
      await this.repository.updatePayloadGenerationAttempt(attempt.id, {
        status: cancelled ? "cancelled" : "failed",
        classification,
        normalizedOutput: {
          text: streamedText,
          reasoning: streamedReasoning,
          redactionEnabled,
          error: error instanceof Error ? error.message : String(error)
        },
        ...(typeof details.traceHash === "string" ? { traceHash: details.traceHash } : {}),
        finishedAt: nowIso()
      });
      this.events.publish(`payload-generation:${generation.id}`, "candidate.failed", {
        attemptId: attempt.id,
        ordinal: attempt.ordinal,
        classification,
        text: streamedText,
        reasoning: streamedReasoning
      });
    }
  }

  private async finishGroup(generationId: string, cancelled: boolean): Promise<void> {
    const [attempts, revisions] = await Promise.all([
      this.repository.listPayloadGenerationAttempts(generationId),
      this.repository.listPayloadRevisionsForGeneration(generationId)
    ]);
    const completed = attempts.filter((attempt) => attempt.status === "completed" && attempt.classification === null).length;
    const hasOutput = revisions.length > 0 || attempts.some((attempt) => attemptOutputText(attempt).length > 0);
    const status = cancelled
      ? "cancelled"
      : completed === attempts.length
        ? "completed"
        : hasOutput
          ? "partial"
          : "failed";
    const generation = await this.repository.updatePayloadGeneration(generationId, { status });
    this.events.publish(`payload-generation:${generationId}`, `generation.${status}`, {
      generationId,
      status,
      completedCandidates: completed,
      candidateCount: attempts.length,
      ...(generation ? { updatedAt: generation.updatedAt } : {})
    });
  }
}
