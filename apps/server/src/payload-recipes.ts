import { ZodError, type z } from "zod";
import {
  nowIso,
  sha256Json,
  uuidv7,
  type AssetKind,
  type AssetRevision,
  type JsonObject,
  type JsonValue,
  type PayloadRevision
} from "@lathe/domain";
import type { LatheRepository } from "@lathe/db";
import {
  applyPayloadTransform,
  countUnicodeCodePoints,
  normalizePayloadTransformParameters,
  renderPayloadVariables
} from "@lathe/payloads";
import {
  payloadRecipeLimits,
  payloadRecipeValueSchema,
  payloadTransformIdSchema,
  payloadTransformParameterRecordSchema
} from "./payload-schemas.js";

const MAX_PREVIEW_TEXT_CODE_POINTS = 20_000;
const TRANSFORM_PROVENANCE_KINDS = new Set(["transform", "pipeline-step", "variant-matrix", "recipe-replay"]);

type RecipeValue = z.infer<typeof payloadRecipeValueSchema>;
type RecipeStep = RecipeValue["steps"][number];

export interface PayloadRecipeViolation {
  code: string;
  severity: "error" | "warning";
  stepIndex: number | null;
  message: string;
}

export interface PayloadRecipePreviewStep {
  index: number;
  kind: RecipeStep["kind"];
  label: string;
  status: "captured" | "evaluated" | "failed" | "incompatible" | "skipped";
  inputContentHash: string | null;
  outputContentHash: string | null;
  capturedOutputContentHash: string;
  matchesCaptured: boolean | null;
  text: string;
  textTruncated: boolean;
  codePoints: number | null;
  error: string | null;
}

export interface PayloadRecipePreview {
  recipeRevisionId: string;
  recipeContentHash: string;
  sessionId: string;
  compatible: boolean;
  completed: boolean;
  preflightHash: string | null;
  variables: {
    required: string[];
    missing: string[];
    resolved: Record<string, string>;
  };
  steps: PayloadRecipePreviewStep[];
  finalText: string;
  finalContentHash: string;
  capturedFinalContentHash: string;
  matchesCaptured: boolean;
  violations: PayloadRecipeViolation[];
}

export interface PayloadRecipeReplayResult {
  recipe: AssetRevision;
  revision: PayloadRevision | null;
  revisions: PayloadRevision[];
  completed: boolean;
  error: { code: string; stepIndex: number; message: string } | null;
}

export class PayloadRecipeRequestError extends Error {
  override readonly name = "PayloadRecipeRequestError";

  constructor(readonly status: 400 | 404 | 409 | 413 | 422, message: string) {
    super(message);
  }
}

function asParameters(value: JsonValue | undefined, label: string): Record<string, string> {
  if (value === undefined) return {};
  try {
    return payloadTransformParameterRecordSchema.parse(value);
  } catch (error) {
    const message = error instanceof ZodError ? error.issues.map((issue) => issue.message).join(" ") : String(error);
    throw new PayloadRecipeRequestError(422, `${label} has invalid transform parameters. ${message}`);
  }
}

function shortText(value: string): { text: string; textTruncated: boolean; codePoints: number } {
  const characters = [...value];
  return {
    text: characters.length > MAX_PREVIEW_TEXT_CODE_POINTS
      ? `${characters.slice(0, MAX_PREVIEW_TEXT_CODE_POINTS).join("")}…`
      : value,
    textTruncated: characters.length > MAX_PREVIEW_TEXT_CODE_POINTS,
    codePoints: characters.length
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function payloadRecipeAssetDependencies(recipe: RecipeValue): Array<{ id: string; kind: AssetKind; label: string }> {
  const dependencies: Array<{ id: string; kind: AssetKind; label: string }> = [];
  for (const [index, step] of recipe.steps.entries()) {
    if (step.kind === "transform") {
      if (step.pipelineRevisionId) dependencies.push({ id: step.pipelineRevisionId, kind: "payload-pipeline", label: `step ${index + 1} pipeline` });
      continue;
    }
    if (!step.generator) continue;
    dependencies.push({ id: step.generator.profileRevisionId, kind: "payload-generator-profile", label: `step ${index + 1} generator profile` });
    if (step.generator.instructionRevisionId) dependencies.push({ id: step.generator.instructionRevisionId, kind: "payload-generator-instruction", label: `step ${index + 1} generator instruction` });
    if (step.generator.pipelineRevisionId) dependencies.push({ id: step.generator.pipelineRevisionId, kind: "payload-pipeline", label: `step ${index + 1} generator pipeline` });
    for (const id of step.generator.techniqueRevisionIds) dependencies.push({ id, kind: "payload-technique", label: `step ${index + 1} technique` });
  }
  return dependencies;
}

async function recipeAsset(repository: LatheRepository, revisionId: string): Promise<{ asset: AssetRevision; recipe: RecipeValue }> {
  const asset = (await repository.listAssetRevisions("payload-recipe", true)).find((item) => item.id === revisionId);
  if (!asset) throw new PayloadRecipeRequestError(404, "Payload recipe revision not found");
  if (sha256Json(asset.value) !== asset.contentHash) throw new PayloadRecipeRequestError(409, "Payload recipe content hash does not match its value");
  const parsed = payloadRecipeValueSchema.safeParse(asset.value);
  if (!parsed.success) throw new PayloadRecipeRequestError(409, `Payload recipe is invalid: ${parsed.error.issues.map((issue) => issue.message).join(" ")}`);
  return { asset, recipe: parsed.data };
}

function transformMetadata(revision: PayloadRevision, parent: PayloadRevision): {
  transformId: string;
  version: number;
  parameters: Record<string, string>;
  variableNames: string[];
  pipelineRevisionId: string | null;
} {
  const provenance = revision.provenance;
  const kind = provenance.kind;
  if (typeof kind !== "string" || !TRANSFORM_PROVENANCE_KINDS.has(kind)) {
    throw new PayloadRecipeRequestError(422, `Transformed revision ${revision.id} is missing supported deterministic transform provenance`);
  }
  const transformId = provenance.transformId;
  const version = provenance.version;
  if (typeof transformId !== "string" || transformId.trim().length === 0 || transformId.length > 200) {
    throw new PayloadRecipeRequestError(422, `Transformed revision ${revision.id} is missing a bounded transform ID`);
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version <= 0 || version > 1_000_000) {
    throw new PayloadRecipeRequestError(422, `Transformed revision ${revision.id} is missing a positive transform version`);
  }
  const parameters = asParameters(provenance.parameters, `Transformed revision ${revision.id}`);
  const pipelineRevisionId = provenance.pipelineRevisionId;
  if (pipelineRevisionId !== undefined && pipelineRevisionId !== null && typeof pipelineRevisionId !== "string") {
    throw new PayloadRecipeRequestError(422, `Transformed revision ${revision.id} has an invalid pipeline revision reference`);
  }
  return {
    transformId,
    version,
    parameters,
    variableNames: transformId === "render-variables" ? [...renderPayloadVariables(parent.text, parameters).referenced] : [],
    pipelineRevisionId: typeof pipelineRevisionId === "string" && pipelineRevisionId.length > 0 ? pipelineRevisionId : null
  };
}

export async function createPayloadRecipe(
  repository: LatheRepository,
  selectedRevisionId: string,
  input: { name: string; description: string; tags: string[] }
): Promise<AssetRevision> {
  const selected = await repository.getPayloadRevision(selectedRevisionId);
  if (!selected) throw new PayloadRecipeRequestError(404, "Payload revision not found");
  const path: PayloadRevision[] = [];
  const visited = new Set<string>();
  let current: PayloadRevision | null = selected;
  while (current) {
    if (visited.has(current.id)) throw new PayloadRecipeRequestError(409, "Payload revision ancestry contains a cycle");
    if (current.projectId !== selected.projectId || current.sessionId !== selected.sessionId) {
      throw new PayloadRecipeRequestError(409, "Payload revision ancestry crosses a project or session boundary");
    }
    if (sha256Json(current.text) !== current.contentHash) {
      throw new PayloadRecipeRequestError(409, `Payload revision ${current.id} content hash does not match its text`);
    }
    visited.add(current.id);
    path.push(current);
    if (path.length > payloadRecipeLimits.maxSteps) {
      throw new PayloadRecipeRequestError(413, `Payload recipe ancestry exceeds ${payloadRecipeLimits.maxSteps} steps`);
    }
    if (!current.parentRevisionId) break;
    const parent: PayloadRevision | null = await repository.getPayloadRevision(current.parentRevisionId);
    if (!parent) throw new PayloadRecipeRequestError(409, `Payload revision ancestry is missing parent ${current.parentRevisionId}`);
    current = parent;
  }
  path.reverse();

  const defaults = new Map<string, string | null>();
  const steps: RecipeValue["steps"] = [];
  for (const [index, revision] of path.entries()) {
    if (revision.operation === "transformed") {
      const parent = path[index - 1];
      if (!parent) throw new PayloadRecipeRequestError(422, "A recipe cannot start with a transformed revision");
      const transform = transformMetadata(revision, parent);
      for (const name of transform.variableNames) {
        const captured = Object.hasOwn(transform.parameters, name) ? transform.parameters[name]! : null;
        const existing = defaults.get(name);
        if (defaults.has(name) && existing !== captured) {
          throw new PayloadRecipeRequestError(422, `Recipe variable ${name} has conflicting captured defaults`);
        }
        defaults.set(name, captured);
      }
      steps.push({
        kind: "transform",
        transformId: transform.transformId,
        version: transform.version,
        parameters: transform.transformId === "render-variables"
          ? Object.fromEntries(Object.entries(transform.parameters).filter(([name]) => !transform.variableNames.includes(name)))
          : transform.parameters,
        variableNames: transform.variableNames,
        inputContentHash: parent.contentHash,
        capturedOutputText: revision.text,
        outputContentHash: revision.contentHash,
        pipelineRevisionId: transform.pipelineRevisionId
      });
      continue;
    }

    let generatorCheckpoint: {
      profileRevisionId: string;
      instructionRevisionId: string | null;
      techniqueRevisionIds: string[];
      pipelineRevisionId: string | null;
      contextHash: string;
    } | null = null;
    if (revision.operation === "generated" || revision.operation === "refined") {
      if (!revision.generationId) throw new PayloadRecipeRequestError(409, `Payload revision ${revision.id} is missing its helper generation`);
      const generation = await repository.getPayloadGeneration(revision.generationId, true);
      if (!generation) throw new PayloadRecipeRequestError(409, `Payload revision ${revision.id} references a missing helper generation`);
      generatorCheckpoint = {
        profileRevisionId: generation.generatorProfileRevisionId,
        instructionRevisionId: generation.instructionRevisionId,
        techniqueRevisionIds: generation.techniqueRevisionIds,
        pipelineRevisionId: generation.pipelineRevisionId,
        contextHash: generation.contextHash
      };
    }
    steps.push({
      kind: "checkpoint",
      sourceOperation: revision.operation,
      text: revision.text,
      contentHash: revision.contentHash,
      generator: generatorCheckpoint
    });
  }

  const value = payloadRecipeValueSchema.parse({
    version: 1,
    finalContentHash: selected.contentHash,
    variables: [...defaults].map(([name, defaultValue]) => ({ name, defaultValue })),
    steps
  });
  const assets = await repository.listAssetRevisions(undefined, true);
  for (const dependency of payloadRecipeAssetDependencies(value)) {
    const asset = assets.find((item) => item.id === dependency.id);
    if (!asset) throw new PayloadRecipeRequestError(409, `Recipe ${dependency.label} revision is missing`);
    if (asset.kind !== dependency.kind) throw new PayloadRecipeRequestError(409, `Recipe ${dependency.label} must be a ${dependency.kind} revision`);
  }
  const timestamp = nowIso();
  return repository.saveAssetRevision({
    id: uuidv7(),
    assetId: uuidv7(),
    kind: "payload-recipe",
    revision: 1,
    name: input.name,
    description: input.description,
    tags: unique(input.tags),
    provenance: {
      operatorAuthored: true,
      sourceProjectId: selected.projectId,
      sourceSessionId: selected.sessionId,
      sourceRevisionId: selected.id,
      sourcePathRevisionIds: path.map((revision) => revision.id),
      capturedAt: timestamp
    },
    value,
    contentHash: sha256Json(value),
    trusted: true,
    archivedAt: null,
    createdAt: timestamp
  });
}

function violation(
  violations: PayloadRecipeViolation[],
  code: string,
  message: string,
  stepIndex: number | null = null,
  severity: PayloadRecipeViolation["severity"] = "error"
): void {
  violations.push({ code, severity, stepIndex, message });
}

function resolvedVariables(recipe: RecipeValue, overrides: Readonly<Record<string, string>>, violations: PayloadRecipeViolation[]) {
  const defaults = new Map(recipe.variables.map((item) => [item.name, item.defaultValue]));
  for (const name of Object.keys(overrides)) {
    if (!defaults.has(name)) violation(violations, "unknown-variable", `Unknown recipe variable ${name}`);
  }
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, defaultValue] of defaults) {
    const value = overrides[name] ?? defaultValue;
    if (value === null) missing.push(name);
    else resolved[name] = value;
  }
  for (const name of missing) violation(violations, "missing-variable", `Recipe variable ${name} requires a value`);
  return { required: [...defaults.keys()], missing, resolved, defaults };
}

export async function previewPayloadRecipe(
  repository: LatheRepository,
  recipeRevisionId: string,
  sessionId: string,
  overrides: Readonly<Record<string, string>>
): Promise<{ asset: AssetRevision; recipe: RecipeValue; preview: PayloadRecipePreview }> {
  const [{ asset, recipe }, session, assets] = await Promise.all([
    recipeAsset(repository, recipeRevisionId),
    repository.getSession(sessionId),
    repository.listAssetRevisions(undefined, true)
  ]);
  if (!session) throw new PayloadRecipeRequestError(404, "Session not found");
  const violations: PayloadRecipeViolation[] = [];
  if (asset.archivedAt) violation(violations, "archived-recipe", "Archived payload recipes are inspectable but cannot be replayed", null, "warning");
  if (!asset.trusted) violation(violations, "untrusted-recipe", "Payload recipe must be trusted before replay");
  for (const dependency of payloadRecipeAssetDependencies(recipe)) {
    const found = assets.find((item) => item.id === dependency.id);
    if (!found) violation(violations, "missing-asset", `Recipe ${dependency.label} revision is missing`, null);
    else if (found.kind !== dependency.kind) violation(violations, "asset-kind", `Recipe ${dependency.label} must be a ${dependency.kind} revision`, null);
  }
  const variables = resolvedVariables(recipe, overrides, violations);
  const steps: PayloadRecipePreviewStep[] = [];
  let currentText = "";
  let currentHash = sha256Json(currentText);
  let aggregateCodePoints = 0;
  let stopped = false;
  let capturedPath = true;

  for (const [index, step] of recipe.steps.entries()) {
    if (stopped) {
      steps.push({
        index, kind: step.kind, label: step.kind === "checkpoint" ? step.sourceOperation : step.transformId,
        status: "skipped", inputContentHash: currentHash, outputContentHash: null,
        capturedOutputContentHash: step.kind === "checkpoint" ? step.contentHash : step.outputContentHash,
        matchesCaptured: null, text: "", textTruncated: false, codePoints: null, error: null
      });
      continue;
    }
    if (step.kind === "checkpoint") {
      const actualHash = sha256Json(step.text);
      const output = shortText(step.text);
      if (actualHash !== step.contentHash) {
        violation(violations, "captured-hash", `Checkpoint ${index + 1} text does not match its captured hash`, index);
        stopped = true;
      }
      currentText = step.text;
      currentHash = actualHash;
      capturedPath = actualHash === step.contentHash;
      aggregateCodePoints += output.codePoints;
      steps.push({ index, kind: step.kind, label: step.sourceOperation, status: stopped ? "incompatible" : "captured", inputContentHash: null, outputContentHash: actualHash, capturedOutputContentHash: step.contentHash, matchesCaptured: actualHash === step.contentHash, ...output, error: stopped ? "Captured checkpoint hash mismatch" : null });
    } else {
      const parsedId = payloadTransformIdSchema.safeParse(step.transformId);
      if (!parsedId.success) {
        violation(violations, "unsupported-transform", `Transform ${step.transformId} is not available`, index);
        steps.push({ index, kind: step.kind, label: step.transformId, status: "incompatible", inputContentHash: currentHash, outputContentHash: null, capturedOutputContentHash: step.outputContentHash, matchesCaptured: null, text: "", textTruncated: false, codePoints: null, error: "Transform is not available" });
        stopped = true;
        continue;
      }
      if (step.version !== 1) {
        violation(violations, "unsupported-version", `Transform ${step.transformId} version ${step.version} is not supported`, index);
        steps.push({ index, kind: step.kind, label: step.transformId, status: "incompatible", inputContentHash: currentHash, outputContentHash: null, capturedOutputContentHash: step.outputContentHash, matchesCaptured: null, text: "", textTruncated: false, codePoints: null, error: "Transform version is not supported" });
        stopped = true;
        continue;
      }
      if (step.variableNames.some((name) => variables.missing.includes(name))) {
        steps.push({ index, kind: step.kind, label: step.transformId, status: "incompatible", inputContentHash: currentHash, outputContentHash: null, capturedOutputContentHash: step.outputContentHash, matchesCaptured: null, text: "", textTruncated: false, codePoints: null, error: "Required recipe variables are missing" });
        stopped = true;
        continue;
      }
      if (capturedPath && currentHash !== step.inputContentHash) {
        violation(violations, "input-hash", `Transform step ${index + 1} input does not match its captured hash`, index);
        steps.push({ index, kind: step.kind, label: step.transformId, status: "incompatible", inputContentHash: currentHash, outputContentHash: null, capturedOutputContentHash: step.outputContentHash, matchesCaptured: null, text: "", textTruncated: false, codePoints: null, error: "Captured input hash mismatch" });
        stopped = true;
        continue;
      }
      const parameters = step.transformId === "render-variables"
        ? Object.fromEntries(step.variableNames.map((name) => [name, variables.resolved[name]!]))
        : step.parameters;
      const exactVariables = step.variableNames.every((name) => variables.defaults.get(name) === variables.resolved[name]);
      const expectedCaptured = capturedPath && exactVariables;
      try {
        const normalized = normalizePayloadTransformParameters(parsedId.data, parameters);
        const text = applyPayloadTransform(parsedId.data, currentText, normalized);
        const actualHash = sha256Json(text);
        const output = shortText(text);
        const matchesCaptured = actualHash === step.outputContentHash && text === step.capturedOutputText;
        if (expectedCaptured && !matchesCaptured) {
          violation(violations, "registry-drift", `Transform step ${index + 1} no longer reproduces its captured output`, index);
          stopped = true;
        }
        currentText = text;
        currentHash = actualHash;
        capturedPath = matchesCaptured;
        aggregateCodePoints += output.codePoints;
        steps.push({ index, kind: step.kind, label: step.transformId, status: stopped ? "incompatible" : "evaluated", inputContentHash: step.inputContentHash, outputContentHash: actualHash, capturedOutputContentHash: step.outputContentHash, matchesCaptured, ...output, error: stopped ? "Transform output differs from captured output" : null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        violation(violations, "transform-failed", `Transform step ${index + 1} failed: ${message}`, index);
        steps.push({ index, kind: step.kind, label: step.transformId, status: "failed", inputContentHash: currentHash, outputContentHash: null, capturedOutputContentHash: step.outputContentHash, matchesCaptured: null, text: "", textTruncated: false, codePoints: null, error: message });
        stopped = true;
      }
    }
    if (aggregateCodePoints > payloadRecipeLimits.maxCheckpointAggregateCodePoints) {
      violation(violations, "evaluated-output-limit", `Recipe outputs exceed ${payloadRecipeLimits.maxCheckpointAggregateCodePoints} aggregate Unicode code points`, index);
      stopped = true;
    }
  }
  const staticErrors = violations.filter((item) => item.severity === "error");
  const compatible = staticErrors.length === 0;
  const completed = !stopped && steps.length === recipe.steps.length;
  const matchesCaptured = currentHash === recipe.finalContentHash;
  const preflightHash = compatible && completed ? sha256Json({
    recipeRevisionId: asset.id,
    recipeContentHash: asset.contentHash,
    sessionId,
    variables: variables.resolved,
    steps: steps.map((step) => ({ index: step.index, status: step.status, outputContentHash: step.outputContentHash, error: step.error }))
  }) : null;
  return {
    asset,
    recipe,
    preview: {
      recipeRevisionId: asset.id,
      recipeContentHash: asset.contentHash,
      sessionId,
      compatible,
      completed,
      preflightHash,
      variables: { required: variables.required, missing: variables.missing, resolved: variables.resolved },
      steps,
      finalText: currentText,
      finalContentHash: currentHash,
      capturedFinalContentHash: recipe.finalContentHash,
      matchesCaptured,
      violations
    }
  };
}

export async function replayPayloadRecipe(
  repository: LatheRepository,
  recipeRevisionId: string,
  sessionId: string,
  overrides: Readonly<Record<string, string>>,
  expectedPreflightHash: string
): Promise<PayloadRecipeReplayResult> {
  const { asset, recipe, preview } = await previewPayloadRecipe(repository, recipeRevisionId, sessionId, overrides);
  if (asset.archivedAt) throw new PayloadRecipeRequestError(409, "Archived payload recipes cannot be replayed");
  if (!preview.compatible || !preview.preflightHash) {
    throw new PayloadRecipeRequestError(422, preview.violations.map((item) => item.message).join(" ") || "Payload recipe is incompatible");
  }
  if (preview.preflightHash !== expectedPreflightHash) {
    throw new PayloadRecipeRequestError(409, "Payload recipe preview is stale. Preview the current recipe and variables before replaying.");
  }
  const session = await repository.getSession(sessionId);
  if (!session) throw new PayloadRecipeRequestError(404, "Session not found");
  const replayId = uuidv7();
  const revisions: PayloadRevision[] = [];
  let prior: PayloadRevision | null = null;
  let currentText = "";
  let aggregateCodePoints = 0;
  for (const [stepIndex, step] of recipe.steps.entries()) {
    let text: string;
    let effectiveParameters: Readonly<Record<string, string>> = {};
    try {
      if (step.kind === "checkpoint") text = step.text;
      else {
        const transformId = payloadTransformIdSchema.parse(step.transformId);
        const parameters = step.transformId === "render-variables"
          ? Object.fromEntries(step.variableNames.map((name) => [name, preview.variables.resolved[name]!]))
          : step.parameters;
        effectiveParameters = normalizePayloadTransformParameters(transformId, parameters);
        text = applyPayloadTransform(transformId, currentText, effectiveParameters);
      }
      aggregateCodePoints += countUnicodeCodePoints(text);
      if (aggregateCodePoints > payloadRecipeLimits.maxCheckpointAggregateCodePoints) {
        throw new Error(`Recipe outputs exceed ${payloadRecipeLimits.maxCheckpointAggregateCodePoints} aggregate Unicode code points`);
      }
    } catch (error) {
      return {
        recipe: asset,
        revision: prior,
        revisions,
        completed: false,
        error: { code: "recipe-step-failed", stepIndex, message: error instanceof Error ? error.message : String(error) }
      };
    }
    const capturedContentHash = step.kind === "checkpoint" ? step.contentHash : step.outputContentHash;
    const actualContentHash = sha256Json(text);
    const provenance: JsonObject = {
      kind: "recipe-replay",
      recipeRevisionId: asset.id,
      recipeContentHash: asset.contentHash,
      replayId,
      stepIndex,
      stepCount: recipe.steps.length,
      stepKind: step.kind,
      capturedContentHash,
      matchesCaptured: actualContentHash === capturedContentHash,
      ...(step.kind === "checkpoint"
        ? { sourceOperation: step.sourceOperation }
        : {
            transformId: step.transformId,
            version: step.version,
            parameters: { ...effectiveParameters },
            ...(step.pipelineRevisionId ? { pipelineRevisionId: step.pipelineRevisionId } : {})
          })
    };
    const revision = await repository.createPayloadRevision({
      projectId: session.projectId,
      sessionId: session.id,
      generationId: null,
      attemptId: null,
      parentRevisionId: prior?.id ?? null,
      ordinal: 1,
      operation: step.kind === "checkpoint" ? "edited" : "transformed",
      text,
      provenance
    });
    revisions.push(revision);
    prior = revision;
    currentText = text;
  }
  return { recipe: asset, revision: prior, revisions, completed: true, error: null };
}
