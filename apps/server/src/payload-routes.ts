import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError, z, type ZodType } from "zod";
import { nowIso, uuidv7, type AssetKind, type JsonObject, type JsonValue, type PayloadRevision } from "@lathe/domain";
import type { LatheRepository, ResourceDeletionResult } from "@lathe/db";
import {
  applyPayloadTransform,
  evaluatePayloadPipeline,
  evaluatePayloadVariantMatrix,
  normalizePayloadTransformParameters,
  type PayloadVariantMatrixEvaluation
} from "@lathe/payloads";
import type { PayloadGenerationCoordinator } from "./payload-generation-coordinator.js";
import { PayloadGenerationRequestError } from "./payload-generation-coordinator.js";
import {
  createPayloadGenerationInputSchema,
  createPayloadVariantMatrixInputSchema,
  derivePayloadRevisionInputSchema,
  payloadContextPreviewInputSchema,
  payloadGeneratorProfileValueSchema,
  payloadPipelineValueSchema,
  payloadVariantMatrixPreflightInputSchema,
  sessionPayloadWorkbenchSettingsInputSchema,
  payloadWorkbenchSettingsInputSchema,
  refinePayloadRevisionInputSchema
} from "./payload-schemas.js";

async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    throw new HTTPException(400, { message: "Expected a JSON request body" });
  }
  return schema.parse(input);
}

function inUseMessage(label: string, result: ResourceDeletionResult): string {
  const examples = result.references.slice(0, 3).map((reference) => `${reference.kind} “${reference.label}” (${reference.detail})`).join(", ");
  return `${label} is still in use by ${examples}${result.references.length > 3 ? ` and ${result.references.length - 3} more` : ""}.`;
}

function requestError(error: unknown): never {
  if (error instanceof PayloadGenerationRequestError) throw new HTTPException(error.status, { message: error.message });
  if (error instanceof ZodError) throw error;
  if (error instanceof Error && /not found/i.test(error.message)) throw new HTTPException(404, { message: error.message });
  if (error instanceof Error && /stale|does not belong|unavailable|archived|untrusted|current branch/i.test(error.message)) throw new HTTPException(409, { message: error.message });
  throw error;
}

async function assertAssetKind(repository: LatheRepository, id: string | null, kind: AssetKind): Promise<void> {
  if (id === null) return;
  const asset = (await repository.listAssetRevisions(kind)).find((item) => item.id === id);
  if (!asset) throw new HTTPException(409, { message: `${kind} revision is unavailable` });
}

async function evaluateVariantMatrixRequest(
  repository: LatheRepository,
  sessionId: string,
  input: {
    source: { revisionId: string | null; text: string };
    transformId: Parameters<typeof evaluatePayloadVariantMatrix>[0]["transformId"];
    version: 1;
    parameterSets: Array<Record<string, string>>;
  }
): Promise<{ base: PayloadRevision | null; evaluation: PayloadVariantMatrixEvaluation }> {
  const session = await repository.getSession(sessionId);
  if (!session) throw new HTTPException(404, { message: "Session not found" });
  const base = input.source.revisionId === null
    ? null
    : await repository.getPayloadRevision(input.source.revisionId);
  if (input.source.revisionId !== null && !base) {
    throw new HTTPException(404, { message: "Source payload revision not found" });
  }
  if (base && (base.sessionId !== session.id || base.projectId !== session.projectId)) {
    throw new HTTPException(409, { message: "Source payload revision does not belong to session" });
  }
  return {
    base,
    evaluation: evaluatePayloadVariantMatrix({
      source: {
        kind: base && base.text === input.source.text ? "revision" : "draft",
        revisionId: base?.id ?? null,
        text: input.source.text
      },
      transformId: input.transformId,
      version: input.version,
      parameterSets: input.parameterSets
    })
  };
}

export function registerPayloadRoutes(app: Hono, dependencies: {
  repository: LatheRepository;
  coordinator: PayloadGenerationCoordinator;
}): void {
  const { repository, coordinator } = dependencies;

  app.get("/api/payload-workbench/settings", async (context) => {
    const settings = await repository.getPayloadWorkbenchSettings();
    return context.json({
      settings: settings ?? {
        id: "global",
        defaultGeneratorProfileRevisionId: null,
        defaultInstructionRevisionId: null,
        candidateCount: 1,
        diversity: "balanced",
        contextMode: "minimal",
        includeProjectBrief: true,
        includeSessionBrief: true,
        includeTargetConfig: false,
        budgetChars: 32_000,
        createdAt: null,
        updatedAt: null
      }
    });
  });

  app.put("/api/payload-workbench/settings", async (context) => {
    const input = await parseBody(context.req.raw, payloadWorkbenchSettingsInputSchema);
    await assertAssetKind(repository, input.defaultGeneratorProfileRevisionId, "payload-generator-profile");
    await assertAssetKind(repository, input.defaultInstructionRevisionId, "payload-generator-instruction");
    return context.json({ settings: await repository.upsertPayloadWorkbenchSettings({
      ...input,
      contextMode: input.contextMode
    }) });
  });

  app.get("/api/sessions/:id/payload-workbench/settings", async (context) => {
    const sessionId = context.req.param("id");
    if (!await repository.getSession(sessionId)) throw new HTTPException(404, { message: "Session not found" });
    return context.json({ settings: await repository.getSessionPayloadWorkbenchSettings(sessionId) });
  });

  app.put("/api/sessions/:id/payload-workbench/settings", async (context) => {
    const sessionId = context.req.param("id");
    if (!await repository.getSession(sessionId)) throw new HTTPException(404, { message: "Session not found" });
    const input = await parseBody(context.req.raw, sessionPayloadWorkbenchSettingsInputSchema);
    await assertAssetKind(repository, input.generatorProfileRevisionId, "payload-generator-profile");
    await assertAssetKind(repository, input.instructionRevisionId, "payload-generator-instruction");
    for (const techniqueRevisionId of input.techniqueRevisionIds) {
      await assertAssetKind(repository, techniqueRevisionId, "payload-technique");
    }
    await assertAssetKind(repository, input.pipelineRevisionId, "payload-pipeline");
    try {
      return context.json({ settings: await repository.upsertSessionPayloadWorkbenchSettings(sessionId, input) });
    } catch (error) {
      if (error instanceof Error && error.message === "Payload Workbench session does not exist") {
        throw new HTTPException(404, { message: "Session not found" });
      }
      requestError(error);
    }
  });

  app.post("/api/sessions/:id/payload-variant-matrices/preflight", async (context) => {
    const input = await parseBody(context.req.raw, payloadVariantMatrixPreflightInputSchema);
    const { evaluation } = await evaluateVariantMatrixRequest(repository, context.req.param("id"), input);
    return context.json({ preflight: evaluation.preflight });
  });

  app.post("/api/sessions/:id/payload-variant-matrices", async (context) => {
    const input = await parseBody(context.req.raw, createPayloadVariantMatrixInputSchema);
    const { base, evaluation } = await evaluateVariantMatrixRequest(repository, context.req.param("id"), input);
    const { preflight, outputs } = evaluation;
    if (!preflight.creatable || preflight.preflightHash === null) {
      throw new HTTPException(422, {
        message: preflight.violations.map((violation) => (
          `${violation.ordinal === null ? "Matrix" : `Row ${violation.ordinal}`}: ${violation.message}`
        )).join(" ") || "Payload variant matrix is not creatable"
      });
    }
    if (preflight.preflightHash !== input.preflightHash) {
      throw new HTTPException(409, { message: "Payload variant matrix preflight is stale. Preview the current matrix before creating it." });
    }

    const matrixId = uuidv7();
    const createdAt = nowIso();
    const variantCount = preflight.rows.length;
    const variants = preflight.rows.map((row, index) => {
      const text = outputs[index];
      if (text === null || text === undefined || row.parameters === null || row.codePoints === null || row.utf8Bytes === null) {
        throw new HTTPException(500, { message: `Payload variant matrix row ${row.ordinal} was unavailable after successful preflight` });
      }
      const earlierDuplicate = row.duplicateOutputOrdinals.find((ordinal) => ordinal < row.ordinal) ?? null;
      return {
        text,
        provenance: {
          kind: "variant-matrix",
          matrixId,
          preflightHash: preflight.preflightHash,
          sourceHash: preflight.source.contentHash,
          transformId: input.transformId,
          version: input.version,
          parameters: row.parameters,
          ordinal: row.ordinal,
          variantCount,
          outputCodePoints: row.codePoints,
          outputUtf8Bytes: row.utf8Bytes,
          matchesControl: row.matchesControl,
          duplicateOutputOf: earlierDuplicate
        }
      };
    });
    const persisted = await repository.createPayloadRevisionFanOut({
      sessionId: context.req.param("id"),
      baseRevisionId: base?.id ?? null,
      sourceText: input.source.text,
      sourceProvenance: {
        kind: "variant-matrix-control",
        preflightHash: preflight.preflightHash,
        sourceHash: preflight.source.contentHash
      },
      variants
    });
    return context.json({
      matrix: {
        id: matrixId,
        sourceRevisionId: persisted.source.id,
        sourceContentHash: persisted.source.contentHash,
        transformId: input.transformId,
        version: input.version,
        count: persisted.revisions.length,
        preflightHash: preflight.preflightHash,
        createdAt
      },
      variants: persisted.revisions
    }, 201);
  });

  app.post("/api/payload-generator-profiles/:revisionId/probe", async (context) => {
    try {
      return context.json({ probe: await coordinator.probeProfile(context.req.param("revisionId")) });
    } catch (error) {
      requestError(error);
    }
  });

  app.post("/api/sessions/:id/payload-context/preview", async (context) => {
    const input = await parseBody(context.req.raw, payloadContextPreviewInputSchema);
    try {
      const resolved = await coordinator.preview({
        sessionId: context.req.param("id"),
        branchId: input.branchId,
        contextNodeId: input.contextNodeId,
        options: input.options,
        variables: input.variables
      });
      return context.json({ preview: { ...resolved.compiled, variables: resolved.variables, contextNodeId: resolved.contextNodeId, branchId: resolved.branchId } });
    } catch (error) {
      requestError(error);
    }
  });

  app.post("/api/payload-generations", async (context) => {
    const input = await parseBody(context.req.raw, createPayloadGenerationInputSchema);
    try {
      return context.json(await coordinator.start(input), 202);
    } catch (error) {
      requestError(error);
    }
  });

  app.get("/api/payload-generations", async (context) => {
    const sessionId = context.req.query("sessionId");
    if (!sessionId) throw new HTTPException(400, { message: "sessionId is required" });
    const cursor = context.req.query("cursor");
    const all = await repository.listPayloadGenerations(sessionId);
    const start = cursor ? Math.max(0, all.findIndex((item) => item.id === cursor) + 1) : 0;
    const page = all.slice(start, start + 50);
    const [generations, standalone] = await Promise.all([
      Promise.all(page.map((item) => coordinator.getDetail(item.id))),
      coordinator.getStandaloneHistory(sessionId)
    ]);
    return context.json({
      generations: generations.filter(Boolean),
      standaloneRevisions: standalone.revisions,
      standaloneOutcomes: standalone.outcomes,
      nextCursor: start + page.length < all.length ? page.at(-1)?.id ?? null : null
    });
  });

  app.get("/api/payload-generations/:id", async (context) => {
    const detail = await coordinator.getDetail(context.req.param("id"));
    if (!detail) throw new HTTPException(404, { message: "Payload generation not found" });
    return context.json(detail);
  });

  app.post("/api/payload-generations/:id/cancel", async (context) => {
    return context.json({ cancelled: await coordinator.cancel(context.req.param("id")) });
  });

  app.delete("/api/payload-generations/:id", async (context) => {
    const id = context.req.param("id");
    const generation = await repository.getPayloadGeneration(id);
    if (!generation) throw new HTTPException(404, { message: "Payload generation not found" });
    if (["queued", "streaming"].includes(generation.status)) {
      throw new HTTPException(409, { message: "Payload generation is active. Cancel or finish it before deleting its history." });
    }
    const result = await repository.deletePayloadGeneration(id);
    if (result.references.length > 0) return context.json({ error: { code: "resource-in-use", message: inUseMessage("Payload generation", result), references: result.references } }, 409);
    if (!result.deleted) throw new HTTPException(404, { message: "Payload generation not found" });
    return context.json({ deleted: true, id });
  });

  app.delete("/api/payload-revisions/:id", async (context) => {
    const result = await repository.deletePayloadRevision(context.req.param("id"));
    if (result.references.length > 0) return context.json({ error: { code: "resource-in-use", message: inUseMessage("Payload revision", result), references: result.references } }, 409);
    if (!result.deleted) throw new HTTPException(404, { message: "Payload revision not found" });
    return context.json({ deleted: true, id: context.req.param("id") });
  });

  app.post("/api/payload-revisions/:id/refine", async (context) => {
    const input = await parseBody(context.req.raw, refinePayloadRevisionInputSchema);
    try {
      return context.json(await coordinator.refine(context.req.param("id"), {
        feedback: input.feedback,
        ...(input.candidateCount === undefined ? {} : { candidateCount: input.candidateCount }),
        ...(input.diversity === undefined ? {} : { diversity: input.diversity }),
        confirmProjectReadOnly: input.confirmProjectReadOnly
      }), 202);
    } catch (error) {
      requestError(error);
    }
  });

  app.post("/api/payload-revisions", async (context) => {
    const input = await parseBody(context.req.raw, z.object({ sessionId: z.string().min(1), text: z.string().min(1).max(1_000_000) }));
    const session = await repository.getSession(input.sessionId);
    if (!session) throw new HTTPException(404, { message: "Session not found" });
    const revision = await repository.createPayloadRevision({
      projectId: session.projectId,
      sessionId: session.id,
      generationId: null,
      attemptId: null,
      parentRevisionId: null,
      ordinal: 1,
      operation: "edited",
      text: input.text,
      provenance: { kind: "manual-seed" }
    });
    return context.json({ revision }, 201);
  });

  app.post("/api/payload-revisions/:id/derive", async (context) => {
    const input = await parseBody(context.req.raw, derivePayloadRevisionInputSchema);
    const parent = await repository.getPayloadRevision(context.req.param("id"));
    if (!parent) throw new HTTPException(404, { message: "Payload revision not found" });
    if (input.kind === "edit") {
      const revision = await repository.createPayloadRevision({
        projectId: parent.projectId, sessionId: parent.sessionId, generationId: parent.generationId,
        attemptId: null, parentRevisionId: parent.id, ordinal: parent.ordinal,
        operation: "edited", text: input.text, provenance: { kind: "operator-edit", parentHash: parent.contentHash }
      });
      return context.json({ revision, revisions: [revision] }, 201);
    }
    if (input.kind === "transform") {
      let text: string;
      let parameters: Readonly<Record<string, string>>;
      try {
        parameters = normalizePayloadTransformParameters(input.transformId, input.parameters);
        text = applyPayloadTransform(input.transformId, parent.text, parameters);
      } catch (error) {
        throw new HTTPException(422, { message: error instanceof Error ? error.message : String(error) });
      }
      const revision = await repository.createPayloadRevision({
        projectId: parent.projectId, sessionId: parent.sessionId, generationId: parent.generationId,
        attemptId: null, parentRevisionId: parent.id, ordinal: parent.ordinal,
        operation: "transformed", text,
        provenance: { kind: "transform", transformId: input.transformId, version: input.version, parameters }
      });
      return context.json({ revision, revisions: [revision] }, 201);
    }
    const pipeline = (await repository.listAssetRevisions("payload-pipeline")).find((item) => item.id === input.pipelineRevisionId);
    if (!pipeline || !pipeline.trusted) throw new HTTPException(409, { message: "Payload pipeline revision is unavailable or untrusted" });
    const value = payloadPipelineValueSchema.parse(pipeline.value);
    const steps = value.steps.map((step) => ({
      transformId: step.transformId,
      version: step.version,
      enabled: step.enabled,
      ...(step.transformId === "render-variables"
        ? { parameters: input.variables }
        : step.parameters === undefined ? {} : { parameters: step.parameters })
    }));
    const evaluated = evaluatePayloadPipeline(parent.text, steps);
    const revisions = [];
    let previous = parent;
    for (const step of evaluated.steps) {
      if (step.output === null) break;
      const configured = steps[step.index];
      if (!configured) throw new HTTPException(500, { message: `Pipeline step ${step.index} was not available after evaluation` });
      const parameters = normalizePayloadTransformParameters(configured.transformId, configured.parameters);
      const revision = await repository.createPayloadRevision({
        projectId: parent.projectId, sessionId: parent.sessionId, generationId: parent.generationId,
        attemptId: null, parentRevisionId: previous.id, ordinal: parent.ordinal,
        operation: "transformed", text: step.output,
        provenance: {
          kind: "pipeline-step",
          pipelineRevisionId: pipeline.id,
          stepIndex: step.index,
          transformId: step.transformId,
          version: configured.version,
          parameters
        }
      });
      revisions.push(revision);
      previous = revision;
    }
    return context.json({ revision: revisions.at(-1) ?? parent, revisions, completed: evaluated.completed, error: evaluated.steps.find((step) => step.error)?.error ?? null }, 201);
  });
}
