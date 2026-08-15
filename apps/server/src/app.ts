import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError, z, type ZodType } from "zod";
import {
  appendMessageSchema,
  compareBranches,
  createAutomationSchema,
  createBranchSchema,
  createCheckpointSchema,
  createFindingSchema,
  createProjectSchema,
  createProviderProfileSchema,
  createRunSchema,
  createSessionSchema,
  moveBranchSchema,
  nowIso,
  resolvedConfigSchema,
  sha256Json,
  updateProjectSchema,
  uuidv7,
  type AssetKind,
  type JsonObject,
  type JsonValue,
  type MessagePart,
  type ResolvedConfig
} from "@lathe/domain";
import type { ContentStore, LatheRepository, ResourceDeletionResult } from "@lathe/db";
import { previewBatchVariation, type BatchVaryPlan } from "@lathe/automation";
import { discoverProviderModels, redactText } from "@lathe/providers";
import {
  UnsafeAssetCredentialError,
  assertSafeAssetCredentials,
  localSecurity,
  restoreAssetRevisionRedactions,
  restoreProviderRevisionSecrets,
  sanitizeAssetRevision,
  sanitizeProvider
} from "./security.js";
import { EventHub } from "./events.js";
import type { RunCoordinator } from "./run-coordinator.js";
import { registerArtifactRoutes } from "./artifact-routes.js";
import { registerMcpRoutes } from "./mcp-routes.js";
import type { JobCoordinator } from "./job-coordinator.js";
import { PayloadGenerationCoordinator } from "./payload-generation-coordinator.js";
import { registerPayloadRoutes } from "./payload-routes.js";
import {
  payloadGeneratorInstructionValueSchema,
  payloadGeneratorProfileValueSchema,
  payloadPipelineValueSchema,
  payloadTechniqueValueSchema
} from "./payload-schemas.js";

export interface AppDependencies {
  repository: LatheRepository;
  contentStore: ContentStore;
  events: EventHub;
  runCoordinator: RunCoordinator;
  apiToken: string;
  dataDirectory: string;
  jobCoordinator?: Pick<JobCoordinator, "start" | "cancel" | "resume">;
  providerFetch?: typeof globalThis.fetch;
  payloadCoordinator?: PayloadGenerationCoordinator;
}

async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    throw new HTTPException(400, { message: "Expected a JSON request body" });
  }
  return schema.parse(input);
}

function validateAssetCredentials(kind: AssetKind, value: JsonValue): void {
  try {
    assertSafeAssetCredentials(kind, value);
  } catch (error) {
    if (error instanceof UnsafeAssetCredentialError) throw new HTTPException(400, { message: error.message });
    throw error;
  }
}

function validatePayloadAssetValue(kind: AssetKind, value: JsonValue): void {
  if (kind === "payload-generator-profile") payloadGeneratorProfileValueSchema.parse(value);
  else if (kind === "payload-generator-instruction") payloadGeneratorInstructionValueSchema.parse(value);
  else if (kind === "payload-technique") payloadTechniqueValueSchema.parse(value);
  else if (kind === "payload-pipeline") payloadPipelineValueSchema.parse(value);
}

async function validatePayloadAssetReferences(repository: LatheRepository, kind: AssetKind, value: JsonValue): Promise<void> {
  if (kind !== "payload-generator-profile") return;
  const profile = payloadGeneratorProfileValueSchema.parse(value);
  if (profile.backend.kind !== "http-provider") return;
  const provider = await repository.getProviderProfile(profile.backend.providerProfileRevisionId);
  if (!provider) {
    throw new HTTPException(409, { message: "Generator profile references an unavailable provider revision" });
  }
  if (provider.models.length > 0 && !provider.models.some((model) => model.id === profile.backend.modelId)) {
    throw new HTTPException(409, { message: "Generator profile model is not present in the referenced provider revision" });
  }
}

function resourceInUseMessage(label: string, result: ResourceDeletionResult): string {
  const examples = result.references
    .slice(0, 3)
    .map((reference) => `${reference.kind} “${reference.label}” (${reference.detail})`)
    .join(", ");
  const remainder = result.references.length - 3;
  return `${label} is still in use by ${examples}${remainder > 0 ? ` and ${remainder} more reference${remainder === 1 ? "" : "s"}` : ""}. Remove those references before deleting it.`;
}

export function createApp(dependencies: AppDependencies): Hono {
  const { repository, contentStore, events, runCoordinator } = dependencies;
  const app = new Hono();
  const payloadCoordinator = dependencies.payloadCoordinator ?? new PayloadGenerationCoordinator(
    repository,
    contentStore,
    events,
    dependencies.providerFetch ?? globalThis.fetch
  );
  app.use("*", localSecurity(dependencies.apiToken));

  app.onError((error, context) => {
    if (error instanceof ZodError) {
      return context.json({ error: { code: "invalid-input", message: "Request validation failed", issues: error.issues } }, 400);
    }
    if (error instanceof HTTPException) return context.json({ error: { code: "http-error", message: error.message } }, error.status);
    const correlationId = uuidv7();
    console.error(`[lathe:${correlationId}] Internal request failure`);
    return context.json({ error: { code: "internal-error", message: "The request failed internally. Inspect the redacted run/operation trace for details.", correlationId } }, 500);
  });

  app.get("/api/health", (context) => context.json({ ok: true, service: "lathe", version: "0.1.0" }));
  app.get("/api/config", (context) => context.json({
    version: "0.1.0",
    databaseDialect: repository.dialect,
    dataDirectory: dependencies.dataDirectory,
    warnings: ["Credentials are stored plaintext in the Lathe database. Exports and ordinary API responses exclude them."]
  }));

  app.get("/api/projects", async (context) => context.json({ projects: await repository.listProjects() }));
  app.post("/api/projects", async (context) => {
    const input = await parseBody(context.req.raw, createProjectSchema);
    return context.json({ project: await repository.createProject({
      name: input.name,
      description: input.description,
      targetName: input.targetName,
      ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot })
    }) }, 201);
  });
  app.patch("/api/projects/:id", async (context) => {
    const input = await parseBody(context.req.raw, updateProjectSchema);
    const project = await repository.updateProject(context.req.param("id"), Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)));
    if (!project) throw new HTTPException(404, { message: "Project not found" });
    return context.json({ project });
  });
  app.delete("/api/projects/:id", async (context) => {
    const project = await repository.getProject(context.req.param("id"));
    if (!project) throw new HTTPException(404, { message: "Project not found" });
    const sessions = await repository.listSessions(project.id);
    for (const session of sessions) {
      const [runs, jobs, payloadGenerations] = await Promise.all([
        repository.listRuns(session.id),
        repository.listAutomationJobs(session.id),
        repository.listPayloadGenerations(session.id)
      ]);
      if (
        runs.some((run) => ["queued", "streaming", "awaiting-tool"].includes(run.status))
        || jobs.some((job) => ["queued", "running"].includes(job.status))
        || payloadGenerations.some((generation) => ["queued", "streaming"].includes(generation.status))
      ) {
        throw new HTTPException(409, { message: `Project “${project.name}” has active work in session “${session.name}”. Cancel or finish it before deleting the project.` });
      }
    }
    if (!await repository.deleteProject(project.id)) throw new HTTPException(404, { message: "Project not found" });
    return context.json({ deleted: true, id: project.id });
  });

  app.get("/api/sessions", async (context) => {
    const projectId = context.req.query("projectId");
    if (!projectId) throw new HTTPException(400, { message: "projectId is required" });
    return context.json({ sessions: await repository.listSessions(projectId) });
  });
  app.post("/api/sessions", async (context) => {
    const input = await parseBody(context.req.raw, createSessionSchema);
    if (input.providerProfileId && input.modelId) {
      const provider = (await repository.listProviderProfiles()).find((item) => item.id === input.providerProfileId);
      if (!provider) throw new HTTPException(404, { message: "Provider profile not found" });
      if (provider.models.length > 0 && !provider.models.some((model) => model.id === input.modelId)) {
        throw new HTTPException(409, { message: "Model is not present in the selected provider catalog" });
      }
    }
    let draftConfig: ResolvedConfig | undefined;
    if (input.harnessRevisionId) {
      const { resolveHarness } = await import("@lathe/harness");
      const assets = await repository.listAssetRevisions();
      const harness = assets.find((asset) => asset.id === input.harnessRevisionId && asset.kind === "harness");
      if (!harness) throw new HTTPException(404, { message: "Harness revision not found" });
      draftConfig = resolveHarness(harness as never, assets);
    }
    const result = await repository.createSession({
      projectId: input.projectId,
      name: input.name,
      description: input.description,
      ...(input.providerProfileId !== undefined ? { providerProfileId: input.providerProfileId } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(draftConfig ? { draftConfig } : {})
    });
    return context.json(result, 201);
  });
  app.get("/api/sessions/:id", async (context) => {
    const session = await repository.getSession(context.req.param("id"));
    if (!session) throw new HTTPException(404, { message: "Session not found" });
    const [nodes, branches, checkpoints, runs, attachments] = await Promise.all([
      repository.listNodes(session.id),
      repository.listBranches(session.id),
      repository.listCheckpoints(session.id),
      repository.listRuns(session.id),
      repository.listAttachments(session.projectId)
    ]);
    return context.json({ session, nodes, branches, checkpoints, runs, attachments });
  });
  app.patch("/api/sessions/:id/metadata", async (context) => {
    const body = await parseBody(context.req.raw, z.object({
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(4_000).optional()
    }).refine((value) => value.name !== undefined || value.description !== undefined, { message: "At least one metadata field is required" }));
    const session = await repository.updateSessionMetadata(context.req.param("id"), {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.description === undefined ? {} : { description: body.description })
    });
    if (!session) throw new HTTPException(404, { message: "Session not found" });
    return context.json({ session });
  });
  app.patch("/api/sessions/:id/config", async (context) => {
    const body = await parseBody(context.req.raw, z.object({ config: resolvedConfigSchema }));
    const session = await repository.updateSessionDraft(context.req.param("id"), body.config);
    if (!session) throw new HTTPException(404, { message: "Session not found" });
    return context.json({ session });
  });
  app.patch("/api/sessions/:id/model", async (context) => {
    const body = await parseBody(context.req.raw, z.object({
      providerProfileId: z.string().nullable(),
      modelId: z.string().trim().min(1).nullable()
    }));
    if ((body.providerProfileId === null) !== (body.modelId === null)) {
      throw new HTTPException(400, { message: "Provider and model must either both be selected or both be cleared" });
    }
    if (body.providerProfileId && body.modelId) {
      const provider = await repository.getProviderProfile(body.providerProfileId);
      if (!provider) throw new HTTPException(404, { message: "Provider profile not found" });
      if (provider.models.length > 0 && !provider.models.some((model) => model.id === body.modelId)) {
        throw new HTTPException(409, { message: "Model is not present in the selected provider catalog" });
      }
    }
    const session = await repository.updateSessionModel(context.req.param("id"), body.providerProfileId, body.modelId);
    if (!session) throw new HTTPException(404, { message: "Session not found" });
    return context.json({ session });
  });
  app.patch("/api/sessions/:id/continuation", async (context) => {
    const body = await parseBody(context.req.raw, z.object({
      enabled: z.boolean(),
      limit: z.number().int().min(1).max(32)
    }));
    const session = await repository.updateSessionContinuation(context.req.param("id"), body.enabled, body.limit);
    if (!session) throw new HTTPException(404, { message: "Session not found" });
    return context.json({ session });
  });
  app.delete("/api/sessions/:id", async (context) => {
    const session = await repository.getSession(context.req.param("id"));
    if (!session) throw new HTTPException(404, { message: "Session not found" });
    const [runs, jobs, payloadGenerations] = await Promise.all([
      repository.listRuns(session.id),
      repository.listAutomationJobs(session.id),
      repository.listPayloadGenerations(session.id)
    ]);
    if (
      runs.some((run) => ["queued", "streaming", "awaiting-tool"].includes(run.status))
      || jobs.some((job) => ["queued", "running"].includes(job.status))
      || payloadGenerations.some((generation) => ["queued", "streaming"].includes(generation.status))
    ) {
      throw new HTTPException(409, { message: `Session “${session.name}” has active work. Cancel or finish it before deleting the session.` });
    }
    if (!await repository.deleteSession(session.id)) throw new HTTPException(404, { message: "Session not found" });
    return context.json({ deleted: true, id: session.id });
  });

  app.post("/api/sessions/:id/messages", async (context) => {
    const input = await parseBody(context.req.raw, appendMessageSchema);
    const sessionId = context.req.param("id");
    const branchId = input.branchId;
    const branches = await repository.listBranches(sessionId);
    const branch = branches.find((item) => item.id === branchId);
    if (!branch) throw new HTTPException(404, { message: "Branch not found" });
    let sourcePayloadRevisionId = input.sourcePayloadRevisionId ?? null;
    if (sourcePayloadRevisionId !== null) {
      if (input.role !== "user") throw new HTTPException(422, { message: "Only operator messages can reference a source payload revision" });
      const source = await repository.getPayloadRevision(sourcePayloadRevisionId);
      if (!source || source.sessionId !== sessionId) throw new HTTPException(409, { message: "Source payload revision does not belong to this session" });
      const messageText = input.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (messageText !== source.text) {
        const session = await repository.getSession(sessionId);
        if (!session) throw new HTTPException(404, { message: "Session not found" });
        const edited = await repository.createPayloadRevision({
          projectId: session.projectId,
          sessionId,
          generationId: source.generationId,
          attemptId: null,
          parentRevisionId: source.id,
          ordinal: source.ordinal,
          operation: "edited",
          text: messageText,
          provenance: { kind: "composer-edit-with-attachments", parentHash: source.contentHash }
        });
        sourcePayloadRevisionId = edited.id;
      }
    }
    const node = await repository.appendNode({
      sessionId,
      branchId,
      parentId: input.parentId ?? branch.headNodeId,
      role: input.role,
      parts: input.parts as MessagePart[],
      configSnapshotId: input.configSnapshotId ?? null,
      sourcePayloadRevisionId
    });
    events.publish(`session:${sessionId}`, "node.created", node as unknown as JsonValue);
    return context.json({ node }, 201);
  });

  app.get("/api/sessions/:id/branches", async (context) => context.json({ branches: await repository.listBranches(context.req.param("id")) }));
  app.post("/api/branches", async (context) => {
    const input = await parseBody(context.req.raw, createBranchSchema);
    const branch = await repository.createBranch(input.sessionId, input.name, input.headNodeId ?? null);
    return context.json({ branch }, 201);
  });
  app.patch("/api/branches/:id/head", async (context) => {
    const input = await parseBody(context.req.raw, moveBranchSchema);
    const branch = await repository.moveBranch(context.req.param("id"), input.headNodeId);
    if (!branch) throw new HTTPException(404, { message: "Branch not found" });
    return context.json({ branch });
  });
  app.get("/api/compare", async (context) => {
    const sessionId = context.req.query("sessionId");
    const left = context.req.query("left") ?? null;
    const right = context.req.query("right") ?? null;
    if (!sessionId) throw new HTTPException(400, { message: "sessionId is required" });
    return context.json({ comparison: compareBranches(await repository.listNodes(sessionId), left, right) });
  });

  app.post("/api/checkpoints", async (context) => {
    const input = await parseBody(context.req.raw, createCheckpointSchema);
    return context.json({ checkpoint: await repository.createCheckpoint(input) }, 201);
  });
  app.post("/api/sessions/:id/checkpoints", async (context) => {
    const body = await parseBody(context.req.raw, z.object({ name: z.string().trim().min(1), nodeId: z.string().nullable() }));
    const session = await repository.getSession(context.req.param("id"));
    if (!session) throw new HTTPException(404, { message: "Session not found" });
    if (body.nodeId) {
      const node = await repository.getNode(body.nodeId);
      if (!node || node.sessionId !== session.id) throw new HTTPException(409, { message: "Checkpoint node does not belong to session" });
    }
    const snapshot = await repository.createConfigSnapshot(session.id, session.draftConfig);
    const checkpoint = await repository.createCheckpoint({ sessionId: session.id, name: body.name, nodeId: body.nodeId, configSnapshotId: snapshot.id });
    return context.json({ checkpoint, snapshot }, 201);
  });
  app.post("/api/checkpoints/:id/restore", async (context) => {
    const sessionId = context.req.query("sessionId");
    const branchId = context.req.query("branchId");
    if (!sessionId || !branchId) throw new HTTPException(400, { message: "sessionId and branchId are required" });
    try {
      const restored = await repository.restoreCheckpoint({ checkpointId: context.req.param("id"), sessionId, branchId });
      return context.json(restored);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/not found/i.test(message)) throw new HTTPException(404, { message: "Checkpoint, session, or branch not found" });
      throw new HTTPException(409, { message: "Checkpoint restore target is inconsistent with the selected session" });
    }
  });

  app.get("/api/providers", async (context) => {
    const providers = await repository.listProviderProfiles(context.req.query("includeArchived") === "true");
    return context.json({ providers: providers.map(sanitizeProvider) });
  });
  app.get("/api/secrets", async (context) => context.json({ secrets: await repository.listSecrets() }));
  app.post("/api/secrets", async (context) => {
    const body = await parseBody(context.req.raw, z.object({ label: z.string().trim().min(1).max(120), value: z.string().min(1) }));
    return context.json({ secret: await repository.createSecret(body.label, body.value) }, 201);
  });
  app.delete("/api/secrets/:id", async (context) => {
    const result = await repository.deleteSecret(context.req.param("id"));
    if (result.references.length > 0) return context.json({ error: { code: "resource-in-use", message: resourceInUseMessage("Secret", result), references: result.references } }, 409);
    if (!result.deleted) throw new HTTPException(404, { message: "Secret not found" });
    return context.json({ deleted: true, id: context.req.param("id") });
  });
  app.post("/api/providers", async (context) => {
    const input = await parseBody(context.req.raw, createProviderProfileSchema);
    const provider = await repository.createProviderProfile({
      label: input.label,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      credential: input.credential,
      headers: input.headers,
      extraBody: input.extraBody,
      models: input.models,
      ...(input.endpointOverride === undefined ? {} : { endpointOverride: input.endpointOverride })
    });
    return context.json({ provider: sanitizeProvider(provider) }, 201);
  });
  app.post("/api/providers/:id/discover", async (context) => {
    const profile = await repository.getProviderProfile(context.req.param("id"));
    if (!profile) throw new HTTPException(404, { message: "Provider profile not found" });
    const result = await discoverProviderModels(profile, {
      ...(dependencies.providerFetch ? { fetch: dependencies.providerFetch } : {})
    });
    const secrets = [profile.credential, ...Object.values(profile.headers)].filter((value) => value.length >= 4);
    return context.json({
      models: result.models,
      warnings: result.warnings.map((warning) => redactText(warning, secrets))
    });
  });
  app.post("/api/providers/:id/revisions", async (context) => {
    const prior = await repository.getProviderProfile(context.req.param("id"));
    if (!prior || prior.archivedAt) throw new HTTPException(404, { message: "Provider profile revision not found" });
    let raw: unknown;
    try { raw = await context.req.raw.json(); } catch { throw new HTTPException(400, { message: "Expected a JSON request body" }); }
    const input = createProviderProfileSchema.partial().parse(raw);
    const supplied = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const parsedChanges = Object.fromEntries(Object.entries(input).filter(([key, value]) => Object.hasOwn(supplied, key) && value !== undefined)) as Parameters<typeof repository.createProviderRevision>[1];
    const changes = restoreProviderRevisionSecrets(parsedChanges, prior);
    const provider = await repository.createProviderRevision(context.req.param("id"), changes);
    if (!provider) throw new HTTPException(404, { message: "Provider profile revision not found" });
    return context.json({ provider: sanitizeProvider(provider) }, 201);
  });
  app.delete("/api/providers/:id", async (context) => {
    const result = await repository.deleteProviderProfile(context.req.param("id"));
    if (result.references.length > 0) return context.json({ error: { code: "resource-in-use", message: resourceInUseMessage("Provider profile", result), references: result.references } }, 409);
    if (!result.deleted) throw new HTTPException(404, { message: "Provider profile not found" });
    return context.json({ deleted: true, id: context.req.param("id") });
  });

  app.get("/api/assets", async (context) => {
    const kind = context.req.query("kind") as AssetKind | undefined;
    return context.json({ assets: (await repository.listAssetRevisions(kind)).map(sanitizeAssetRevision) });
  });
  app.post("/api/assets", async (context) => {
    const asset = await parseBody(context.req.raw, z.custom<Parameters<typeof repository.saveAssetRevision>[0]>((value) => Boolean(value && typeof value === "object")));
    validateAssetCredentials(asset.kind, asset.value);
    validatePayloadAssetValue(asset.kind, asset.value);
    await validatePayloadAssetReferences(repository, asset.kind, asset.value);
    return context.json({ asset: sanitizeAssetRevision(await repository.saveAssetRevision(asset)) }, 201);
  });
  app.delete("/api/library/assets/:id", async (context) => {
    const result = await repository.deleteAssetRevision(context.req.param("id"));
    if (result.references.length > 0) return context.json({ error: { code: "resource-in-use", message: resourceInUseMessage("Library revision", result), references: result.references } }, 409);
    if (!result.deleted) throw new HTTPException(404, { message: "Library revision not found" });
    return context.json({ deleted: true, id: context.req.param("id") });
  });
  app.post("/api/library/assets", async (context) => {
    const body = await parseBody(context.req.raw, z.object({
      assetId: z.string().optional(),
      baseRevisionId: z.string().optional(),
      kind: z.enum(["prompt", "tool-spec", "tool-implementation", "harness", "target", "mcp-server", "payload-generator-profile", "payload-generator-instruction", "payload-technique", "payload-pipeline"]),
      name: z.string().trim().min(1).max(120),
      description: z.string().max(4_000).default(""),
      tags: z.array(z.string()).default([]),
      provenance: z.record(z.string(), z.custom<JsonValue>()).default({ operatorAuthored: true }),
      value: z.custom<JsonValue>(),
      trusted: z.boolean().default(false)
    }));
    const kindRevisions = await repository.listAssetRevisions(body.kind);
    const allKindRevisions = await repository.listAssetRevisions(body.kind, true);
    const prior = body.assetId
      ? kindRevisions.filter((item) => item.assetId === body.assetId).toSorted((left, right) => right.revision - left.revision)[0]
      : undefined;
    const baseRevision = body.baseRevisionId
      ? kindRevisions.find((item) => item.id === body.baseRevisionId)
      : undefined;
    if (body.baseRevisionId && !body.assetId) {
      throw new HTTPException(400, { message: "Asset revision editing requires the immutable asset ID" });
    }
    if (body.baseRevisionId && (!baseRevision || baseRevision.assetId !== body.assetId || baseRevision.kind !== body.kind)) {
      throw new HTTPException(409, { message: "Base revision does not belong to this immutable asset" });
    }
    if (baseRevision && prior?.id !== baseRevision.id) {
      throw new HTTPException(409, { message: "Asset was revised after editing began; reload before saving" });
    }
    const assetId = body.assetId ?? uuidv7();
    const trustedFromRevisionId = !baseRevision && typeof body.provenance.trustedFromRevisionId === "string"
      ? body.provenance.trustedFromRevisionId
      : null;
    const trustedSource = body.trusted && trustedFromRevisionId
      ? kindRevisions.find((item) => item.id === trustedFromRevisionId)
      : undefined;
    if (trustedFromRevisionId && (!trustedSource || trustedSource.assetId !== assetId || trustedSource.kind !== body.kind)) {
      throw new HTTPException(409, { message: "Trusted source revision does not belong to this immutable asset" });
    }
    // Trusting an imported target/MCP revision copies its server-side value so
    // redacted API DTOs never need to round-trip credential-bearing fields.
    const value = trustedSource?.value
      ?? (baseRevision ? restoreAssetRevisionRedactions(body.kind, body.value, baseRevision.value) : body.value);
    const provenance = structuredClone(body.provenance);
    if (baseRevision) delete provenance.trustedFromRevisionId;
    validateAssetCredentials(body.kind, value);
    validatePayloadAssetValue(body.kind, value);
    await validatePayloadAssetReferences(repository, body.kind, value);
    const asset = await repository.saveAssetRevision({
      id: uuidv7(),
      assetId,
      kind: body.kind,
      revision: Math.max(0, ...allKindRevisions.filter((item) => item.assetId === assetId).map((item) => item.revision)) + 1,
      name: body.name,
      description: body.description,
      tags: body.tags,
      provenance,
      value,
      contentHash: sha256Json(value),
      trusted: body.trusted,
      archivedAt: null,
      createdAt: nowIso()
    });
    return context.json({ asset: sanitizeAssetRevision(asset) }, 201);
  });
  app.post("/api/sessions/:id/save-harness", async (context) => {
    const body = await parseBody(context.req.raw, z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().max(4_000).default(""),
      tags: z.array(z.string()).default([])
    }));
    const session = await repository.getSession(context.req.param("id"));
    if (!session) throw new HTTPException(404, { message: "Session not found" });
    const promptBindings: JsonValue[] = [];
    for (const block of session.draftConfig.promptBlocks.toSorted((left, right) => left.order - right.order)) {
      const promptAssetId = uuidv7();
      const value: JsonObject = { content: block.content };
      const prompt = await repository.saveAssetRevision({
        id: uuidv7(), assetId: promptAssetId, kind: "prompt", revision: 1, name: block.name,
        description: `Copied from session ${session.name}`, tags: body.tags,
        provenance: { operatorAuthored: true, copiedFromRevisionId: block.revisionId, sessionId: session.id },
        value, contentHash: sha256Json(value), trusted: true, archivedAt: null, createdAt: nowIso()
      });
      promptBindings.push({ revisionId: prompt.id, enabled: block.enabled });
    }
    const toolBindings: JsonValue[] = session.draftConfig.tools.map((tool) => ({
      revisionId: tool.toolRevisionId,
      enabled: tool.enabled,
      mode: tool.mode,
      implementationRevisionId: tool.implementationRevisionId,
      targetId: tool.targetId,
      mcpServerId: tool.mcpServerId
    }));
    const value: JsonObject = {
      promptBindings,
      toolBindings,
      protocolOverrides: session.draftConfig.protocolOverrides as unknown as JsonValue
    };
    const harness = await repository.saveAssetRevision({
      id: uuidv7(), assetId: uuidv7(), kind: "harness", revision: 1, name: body.name, description: body.description,
      tags: body.tags, provenance: { operatorAuthored: true, sessionId: session.id }, value,
      contentHash: sha256Json(value), trusted: true, archivedAt: null, createdAt: nowIso()
    });
    return context.json({ harness }, 201);
  });

  app.post("/api/projects/:id/attachments", async (context) => {
    const form = await context.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HTTPException(400, { message: "Multipart field 'file' is required" });
    if (file.size > 100 * 1024 * 1024) throw new HTTPException(413, { message: "Attachment exceeds the 100 MiB v1 limit" });
    const stored = await contentStore.put(new Uint8Array(await file.arrayBuffer()));
    const attachment = await repository.saveAttachment({
      projectId: context.req.param("id"), fileName: file.name, mediaType: file.type || "application/octet-stream", size: stored.size, sha256: stored.sha256
    });
    return context.json({ attachment }, 201);
  });
  app.get("/api/attachments/:id/content", async (context) => {
    const attachment = await repository.getAttachment(context.req.param("id"));
    if (!attachment) throw new HTTPException(404, { message: "Attachment not found" });
    const bytes = await contentStore.get(attachment.sha256);
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
      headers: {
        "Content-Type": attachment.mediaType,
        "Content-Length": String(attachment.size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
        "X-Content-Type-Options": "nosniff"
      }
    });
  });
  app.get("/api/traces/:hash", async (context) => {
    const bytes = await contentStore.get(context.req.param("hash")).catch(() => null);
    if (!bytes) throw new HTTPException(404, { message: "Trace not found" });
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="${context.req.param("hash")}.ndjson"`,
        "X-Content-Type-Options": "nosniff"
      }
    });
  });

  app.get("/api/findings", async (context) => {
    const projectId = context.req.query("projectId");
    if (!projectId) throw new HTTPException(400, { message: "projectId is required" });
    return context.json({ findings: await repository.listFindings(projectId) });
  });
  app.post("/api/findings", async (context) => {
    const input = await parseBody(context.req.raw, createFindingSchema);
    return context.json({ finding: await repository.createFinding({ ...input, nodeId: input.nodeId ?? null }) }, 201);
  });

  app.get("/api/automation", async (context) => {
    const sessionId = context.req.query("sessionId");
    if (!sessionId) throw new HTTPException(400, { message: "sessionId is required" });
    return context.json({ jobs: await repository.listAutomationJobs(sessionId) });
  });
  app.post("/api/automation", async (context) => {
    const input = await parseBody(context.req.raw, createAutomationSchema);
    const [project, session, branches] = await Promise.all([
      repository.getProject(input.projectId),
      repository.getSession(input.sessionId),
      repository.listBranches(input.sessionId)
    ]);
    if (!project) throw new HTTPException(404, { message: "Automation project not found" });
    if (!session || session.projectId !== project.id) throw new HTTPException(422, { message: "Automation session does not belong to the selected project" });
    const branchIds = new Set(branches.map((branch) => branch.id));
    if (input.kind === "replay") {
      if (!branchIds.has(input.plan.sourceBranchId) || !branchIds.has(input.plan.destinationBranchId)) {
        throw new HTTPException(422, { message: "Replay source and destination branches must belong to the selected session" });
      }
    } else if (input.kind === "payload-fanout") {
      if (input.plan.branchIds.some((branchId) => !branchIds.has(branchId))) {
        throw new HTTPException(422, { message: "Every fan-out branch must belong to the selected session" });
      }
    } else {
      let items;
      try {
        items = previewBatchVariation(input.plan as BatchVaryPlan);
      } catch (error) {
        throw new HTTPException(400, { message: error instanceof Error ? error.message : "Invalid batch variation plan" });
      }
      for (const item of items) {
        const selectedBranch = item.input.branchId ?? item.input.sourceBranchId;
        if (typeof selectedBranch !== "string" || !branchIds.has(selectedBranch)) {
          throw new HTTPException(422, { message: "Every batch item must reference a branch in the selected session" });
        }
        if (typeof item.input.payload !== "string" || item.input.payload.length === 0) {
          throw new HTTPException(422, { message: "Every batch item requires a non-empty string payload" });
        }
        if (item.input.config !== undefined && !resolvedConfigSchema.safeParse(item.input.config).success) {
          throw new HTTPException(422, { message: "A batch variation produced an invalid resolved configuration" });
        }
      }
    }
    const job = await repository.createAutomationJob({ ...input, plan: input.plan as unknown as JsonObject });
    events.publish(`job:${job.id}`, "job.queued", job as unknown as JsonValue);
    dependencies.jobCoordinator?.start(job);
    return context.json({ job }, 202);
  });
  app.post("/api/automation/:id/cancel", async (context) => context.json({ cancelled: dependencies.jobCoordinator?.cancel(context.req.param("id")) ?? false }));
  app.post("/api/automation/:id/resume", async (context) => context.json({ resumed: await dependencies.jobCoordinator?.resume(context.req.param("id")) ?? false }, 202));

  app.post("/api/runs", async (context) => {
    const input = await parseBody(context.req.raw, createRunSchema);
    const run = await runCoordinator.start({
      sessionId: input.sessionId,
      branchId: input.branchId,
      contextNodeId: input.contextNodeId ?? null,
      ...(input.userMessage ? { userMessage: input.userMessage } : {}),
      ...(input.sourcePayloadRevisionId !== undefined ? { sourcePayloadRevisionId: input.sourcePayloadRevisionId } : {}),
      ...(input.config ? { configOverride: input.config } : {})
    });
    return context.json({ run }, 202);
  });
  app.post("/api/runs/:id/cancel", async (context) => context.json({ cancelled: await runCoordinator.cancel(context.req.param("id")) }));
  app.patch("/api/runs/:id/annotation", async (context) => {
    const body = await parseBody(context.req.raw, z.object({
      operatorLabel: z.string().trim().max(120).nullable().optional(),
      operatorNotes: z.string().max(20_000).nullable().optional()
    }).refine((value) => value.operatorLabel !== undefined || value.operatorNotes !== undefined, { message: "At least one annotation field is required" }));
    if (!await repository.getRun(context.req.param("id"))) throw new HTTPException(404, { message: "Run not found" });
    const run = await repository.updateRun(context.req.param("id"), {
      ...(body.operatorLabel === undefined ? {} : { operatorLabel: body.operatorLabel }),
      ...(body.operatorNotes === undefined ? {} : { operatorNotes: body.operatorNotes })
    });
    return context.json({ run });
  });
  app.post("/api/runs/:id/tool-calls/:callId/resolve", async (context) => {
    const body = await parseBody(context.req.raw, z.object({ resolution: z.custom<JsonValue>() }));
    try {
      await runCoordinator.resolveToolCall(context.req.param("id"), context.req.param("callId"), body.resolution);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/approval|already|no pending|in progress/i.test(message)) throw new HTTPException(409, { message: "The tool call is awaiting a valid decision, already resolved, or currently being resolved." });
      if (/not found/i.test(message)) throw new HTTPException(404, { message: "Tool call not found" });
      throw error;
    }
    return context.json({ ok: true });
  });
  app.post("/api/runs/:id/mcp-approvals/:approvalId/resolve", async (context) => {
    const body = await parseBody(context.req.raw, z.object({ resolution: z.custom<JsonValue>() }));
    try {
      await runCoordinator.resolveMcpApproval(context.req.param("id"), context.req.param("approvalId"), body.resolution);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/not active|requires|outcome|sampling|elicitation/i.test(message)) throw new HTTPException(409, { message: "The MCP approval is not active or the supplied decision is incompatible with this request." });
      throw error;
    }
    return context.json({ ok: true });
  });
  app.get("/api/events/:channel", (context) => {
    const after = Number(context.req.header("last-event-id") ?? context.req.query("after") ?? 0);
    return new Response(events.stream(decodeURIComponent(context.req.param("channel")), Number.isFinite(after) ? after : 0, context.req.raw.signal), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" }
    });
  });

  registerPayloadRoutes(app, { repository, coordinator: payloadCoordinator });

  registerMcpRoutes(app, repository, contentStore);
  registerArtifactRoutes(app, repository, contentStore);

  return app;
}
