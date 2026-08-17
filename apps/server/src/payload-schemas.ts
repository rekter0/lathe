import { isAbsolute } from "node:path";
import { z } from "zod";
import { sessionPayloadWorkbenchSettingsInputSchema as domainSessionPayloadWorkbenchSettingsInputSchema, sha256Json } from "@lathe/domain";
import {
  countUnicodeCodePoints,
  normalizePayloadTransformParameters,
  payloadTransformParameterLimits,
  payloadVariantMatrixLimits,
  validatePayloadTransformParameters
} from "@lathe/payloads";

export const payloadContextModeSchema = z.enum(["none", "minimal", "full"]);
export const payloadDiversitySchema = z.enum(["low", "balanced", "high"]);

export const payloadContextOptionsSchema = z.object({
  mode: payloadContextModeSchema,
  includeProjectBrief: z.boolean(),
  includeSessionBrief: z.boolean(),
  includeTargetConfig: z.boolean(),
  budgetChars: z.number().int().min(2_000).max(200_000)
});

const httpGeneratorBackendSchema = z.object({
  kind: z.literal("http-provider"),
  providerProfileRevisionId: z.string().min(1),
  modelId: z.string().trim().min(1).max(500),
  maxOutputTokens: z.number().int().positive().max(1_000_000).nullable().default(null),
  reasoning: z.boolean().default(true),
  temperatures: z.object({
    low: z.number().finite().min(0).max(2).default(0.2),
    balanced: z.number().finite().min(0).max(2).default(0.7),
    high: z.number().finite().min(0).max(2).default(1)
  }).default({ low: 0.2, balanced: 0.7, high: 1 })
});

const codexGeneratorBackendSchema = z.object({
  kind: z.literal("codex-app-server"),
  executablePath: z.string().trim().min(1).max(4_096).refine(isAbsolute, "Codex executablePath must be absolute"),
  expectedVersion: z.string().trim().max(200).nullable().default(null),
  modelId: z.string().trim().min(1).max(500),
  effort: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
  timeoutMs: z.number().int().min(1_000).max(30 * 60_000).default(120_000),
  workspaceAccess: z.enum(["isolated", "project-read-only"]).default("isolated")
});

export const payloadGeneratorProfileValueSchema = z.object({
  backend: z.discriminatedUnion("kind", [httpGeneratorBackendSchema, codexGeneratorBackendSchema])
});

export const payloadGeneratorInstructionValueSchema = z.object({
  template: z.string().max(200_000)
});

export const payloadTechniqueValueSchema = z.object({
  instructions: z.string().min(1).max(200_000),
  conflictsWith: z.array(z.string().min(1)).max(1_000).default([]),
  before: z.array(z.string().min(1)).max(1_000).default([]),
  after: z.array(z.string().min(1)).max(1_000).default([])
});

export const payloadTransformIdSchema = z.enum([
  "base64-encode", "base64-decode", "base32-encode", "base32-decode",
  "url-encode", "url-decode", "hex-encode", "hex-decode",
  "uppercase", "lowercase", "reverse", "rot13", "caesar-rotate", "fullwidth", "zero-width-insert",
  "json-escape", "json-unescape",
  "markdown-frame", "xml-frame", "json-frame", "repeat-twice", "render-variables"
]);

export const payloadTransformParameterRecordSchema = z.record(z.string(), z.string()).superRefine((parameters, context) => {
  const entries = Object.entries(parameters);
  if (entries.length > payloadTransformParameterLimits.maxEntries) {
    context.addIssue({ code: "custom", message: `Parameters may contain at most ${payloadTransformParameterLimits.maxEntries} entries.` });
    return;
  }
  let totalCodePoints = 0;
  for (const [name, value] of entries) {
    const nameCodePoints = countUnicodeCodePoints(name);
    const valueCodePoints = countUnicodeCodePoints(value);
    if (nameCodePoints === 0) context.addIssue({ code: "custom", path: [name], message: "Parameter names cannot be empty." });
    else if (nameCodePoints > payloadTransformParameterLimits.maxNameCodePoints) {
      context.addIssue({ code: "custom", path: [name], message: `Parameter names may contain at most ${payloadTransformParameterLimits.maxNameCodePoints} Unicode code points.` });
    }
    if (valueCodePoints > payloadTransformParameterLimits.maxValueCodePoints) {
      context.addIssue({ code: "custom", path: [name], message: `Parameter values may contain at most ${payloadTransformParameterLimits.maxValueCodePoints} Unicode code points.` });
    }
    totalCodePoints += nameCodePoints + valueCodePoints;
  }
  if (totalCodePoints > payloadTransformParameterLimits.maxTotalCodePoints) {
    context.addIssue({ code: "custom", message: `Parameters exceed the ${payloadTransformParameterLimits.maxTotalCodePoints} Unicode code-point aggregate limit.` });
  }
});

export const payloadPipelineValueSchema = z.object({
  steps: z.array(z.object({
    transformId: payloadTransformIdSchema,
    version: z.literal(1),
    enabled: z.boolean().default(true),
    parameters: payloadTransformParameterRecordSchema.optional()
  }).superRefine((step, context) => {
    const validation = validatePayloadTransformParameters(step.transformId, step.parameters);
    for (const message of validation.errors) {
      context.addIssue({ code: "custom", path: ["parameters"], message });
    }
  })).max(100)
});

const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const payloadRecipeLimits = Object.freeze({
  maxSteps: 100,
  maxCheckpointCodePoints: 1_000_000,
  maxCheckpointAggregateCodePoints: 5_000_000,
  maxVariables: 1_000
});

const payloadRecipeGeneratorCheckpointSchema = z.object({
  profileRevisionId: z.string().min(1),
  instructionRevisionId: z.string().min(1).nullable(),
  techniqueRevisionIds: z.array(z.string().min(1)).max(100),
  pipelineRevisionId: z.string().min(1).nullable(),
  contextHash: contentHashSchema
}).strict();

const payloadRecipeCheckpointStepSchema = z.object({
  kind: z.literal("checkpoint"),
  sourceOperation: z.enum(["generated", "refined", "edited"]),
  text: z.string().superRefine((text, context) => {
    if (countUnicodeCodePoints(text) > payloadRecipeLimits.maxCheckpointCodePoints) {
      context.addIssue({ code: "custom", message: `Recipe checkpoint exceeds ${payloadRecipeLimits.maxCheckpointCodePoints} Unicode code points` });
    }
  }),
  contentHash: contentHashSchema,
  generator: payloadRecipeGeneratorCheckpointSchema.nullable()
}).strict();

const payloadRecipeTransformStepSchema = z.object({
  kind: z.literal("transform"),
  transformId: z.string().trim().min(1).max(200),
  version: z.number().int().positive().max(1_000_000),
  parameters: payloadTransformParameterRecordSchema,
  variableNames: z.array(z.string().min(1).max(payloadTransformParameterLimits.maxNameCodePoints)).max(payloadRecipeLimits.maxVariables),
  inputContentHash: contentHashSchema,
  capturedOutputText: z.string().superRefine((text, context) => {
    if (countUnicodeCodePoints(text) > payloadRecipeLimits.maxCheckpointCodePoints) {
      context.addIssue({ code: "custom", message: `Captured transform output exceeds ${payloadRecipeLimits.maxCheckpointCodePoints} Unicode code points` });
    }
  }),
  outputContentHash: contentHashSchema,
  pipelineRevisionId: z.string().min(1).nullable()
}).strict();

export const payloadRecipeValueSchema = z.object({
  version: z.literal(1),
  finalContentHash: contentHashSchema,
  variables: z.array(z.object({
    name: z.string().min(1).max(payloadTransformParameterLimits.maxNameCodePoints),
    defaultValue: z.string().max(payloadTransformParameterLimits.maxValueCodePoints).nullable()
  }).strict()).max(payloadRecipeLimits.maxVariables),
  steps: z.array(z.discriminatedUnion("kind", [payloadRecipeCheckpointStepSchema, payloadRecipeTransformStepSchema]))
    .min(1)
    .max(payloadRecipeLimits.maxSteps)
}).strict().superRefine((recipe, context) => {
  if (recipe.steps[0]?.kind !== "checkpoint") {
    context.addIssue({ code: "custom", path: ["steps", 0], message: "A payload recipe must start with a captured checkpoint" });
  }
  const variableNames = new Set<string>();
  for (const [index, variable] of recipe.variables.entries()) {
    if (variableNames.has(variable.name)) context.addIssue({ code: "custom", path: ["variables", index, "name"], message: "Recipe variable names must be unique" });
    variableNames.add(variable.name);
  }
  const capturedCodePoints = recipe.steps.reduce(
    (total, step) => total + countUnicodeCodePoints(step.kind === "checkpoint" ? step.text : step.capturedOutputText),
    0
  );
  if (capturedCodePoints > payloadRecipeLimits.maxCheckpointAggregateCodePoints) {
    context.addIssue({ code: "custom", path: ["steps"], message: `Recipe captured outputs exceed ${payloadRecipeLimits.maxCheckpointAggregateCodePoints} aggregate Unicode code points` });
  }
  let priorContentHash: string | null = null;
  for (const [index, step] of recipe.steps.entries()) {
    const capturedText = step.kind === "checkpoint" ? step.text : step.capturedOutputText;
    const capturedHash = step.kind === "checkpoint" ? step.contentHash : step.outputContentHash;
    if (sha256Json(capturedText) !== capturedHash) {
      context.addIssue({ code: "custom", path: ["steps", index], message: "Captured payload text does not match its content hash" });
    }
    if (step.kind === "checkpoint") {
      if ((step.sourceOperation === "edited") !== (step.generator === null)) {
        context.addIssue({ code: "custom", path: ["steps", index, "generator"], message: "Only generated and refined checkpoints carry generator metadata" });
      }
    } else {
      if (priorContentHash !== null && step.inputContentHash !== priorContentHash) {
        context.addIssue({ code: "custom", path: ["steps", index, "inputContentHash"], message: "Transform input hash does not match the prior captured step" });
      }
      const seenStepVariables = new Set<string>();
      for (const name of step.variableNames) {
        if (!variableNames.has(name)) context.addIssue({ code: "custom", path: ["steps", index, "variableNames"], message: `Transform references undeclared recipe variable ${name}` });
        if (seenStepVariables.has(name)) context.addIssue({ code: "custom", path: ["steps", index, "variableNames"], message: `Transform variable ${name} is duplicated` });
        seenStepVariables.add(name);
      }
    }
    priorContentHash = capturedHash;
  }
  if (priorContentHash !== recipe.finalContentHash) {
    context.addIssue({ code: "custom", path: ["finalContentHash"], message: "Recipe final hash does not match its last captured step" });
  }
});

export const createPayloadRecipeInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4_000).default(""),
  tags: z.array(z.string().trim().min(1).max(120)).max(100).default([])
}).strict();

export const payloadRecipePreviewInputSchema = z.object({
  sessionId: z.string().min(1),
  variables: payloadTransformParameterRecordSchema.default({})
}).strict();

export const payloadRecipeReplayInputSchema = payloadRecipePreviewInputSchema.extend({
  preflightHash: contentHashSchema
}).strict();

function variantMatrixParameterIssues(
  value: { transformId: z.infer<typeof payloadTransformIdSchema>; parameterSets: Array<Record<string, string>> }
): Array<{ path: Array<string | number>; message: string }> {
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  const normalizedHashes = new Set<string>();
  let totalCodePoints = 0;
  for (const [index, parameters] of value.parameterSets.entries()) {
    try {
      const normalized = normalizePayloadTransformParameters(value.transformId, parameters);
      const key = JSON.stringify(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
      if (normalizedHashes.has(key)) {
        issues.push({ path: ["parameterSets", index], message: "Variant parameter sets must be unique after normalization" });
      }
      normalizedHashes.add(key);
      totalCodePoints += Object.entries(normalized).reduce(
        (total, [name, parameter]) => total + countUnicodeCodePoints(name) + countUnicodeCodePoints(parameter),
        0
      );
    } catch (error) {
      issues.push({
        path: ["parameterSets", index],
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (totalCodePoints > payloadVariantMatrixLimits.maxTotalParameterCodePoints) {
    issues.push({
      path: ["parameterSets"],
      message: `Variant parameters exceed the ${payloadVariantMatrixLimits.maxTotalParameterCodePoints} Unicode code-point aggregate limit.`
    });
  }
  return issues;
}

const payloadVariantMatrixRequestFields = {
  source: z.object({
    revisionId: z.string().min(1).nullable(),
    text: z.string().max(1_000_000)
  }).strict(),
  transformId: payloadTransformIdSchema,
  version: z.literal(1),
  parameterSets: z.array(payloadTransformParameterRecordSchema).min(1).max(payloadVariantMatrixLimits.maxRows)
};

export const payloadVariantMatrixPreflightInputSchema = z.object(payloadVariantMatrixRequestFields)
  .strict();

export const createPayloadVariantMatrixInputSchema = z.object({
  ...payloadVariantMatrixRequestFields,
  preflightHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const payloadWorkbenchSettingsInputSchema = z.object({
  defaultGeneratorProfileRevisionId: z.string().min(1).nullable(),
  defaultInstructionRevisionId: z.string().min(1).nullable(),
  candidateCount: z.number().int().min(1).max(4),
  diversity: payloadDiversitySchema,
  contextMode: payloadContextModeSchema,
  includeProjectBrief: z.boolean(),
  includeSessionBrief: z.boolean(),
  includeTargetConfig: z.boolean(),
  budgetChars: z.number().int().min(2_000).max(200_000)
});

export const sessionPayloadWorkbenchSettingsInputSchema = domainSessionPayloadWorkbenchSettingsInputSchema
  .superRefine((input, context) => {
    if (input.variantMatrix === null) return;
    const transform = payloadTransformIdSchema.safeParse(input.variantMatrix.transformId);
    if (!transform.success) {
      context.addIssue({ code: "custom", path: ["variantMatrix", "transformId"], message: "The saved variant transform is unavailable" });
      return;
    }
    for (const issue of variantMatrixParameterIssues({ transformId: transform.data, parameterSets: input.variantMatrix.parameterSets })) {
      context.addIssue({ code: "custom", path: ["variantMatrix", ...issue.path], message: issue.message });
    }
  })
  .transform((input) => {
    if (input.variantMatrix === null) return input;
    const transformId = payloadTransformIdSchema.parse(input.variantMatrix.transformId);
    return {
      ...input,
      variantMatrix: {
        transformId,
        version: input.variantMatrix.version,
        parameterSets: input.variantMatrix.parameterSets.map((parameters) => (
          normalizePayloadTransformParameters(transformId, parameters)
        ))
      }
    };
  });

export const payloadContextPreviewInputSchema = z.object({
  branchId: z.string().min(1),
  contextNodeId: z.string().min(1).nullable(),
  options: payloadContextOptionsSchema,
  variables: z.record(z.string(), z.string().max(20_000)).default({})
});

export const createPayloadGenerationInputSchema = z.object({
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  contextNodeId: z.string().min(1).nullable(),
  operatorInstruction: z.string().trim().min(1).max(200_000),
  profileRevisionId: z.string().min(1),
  instructionRevisionId: z.string().min(1).nullable().default(null),
  techniqueRevisionIds: z.array(z.string().min(1)).max(100).default([]),
  variables: z.record(z.string(), z.string().max(20_000)).default({}),
  context: payloadContextOptionsSchema,
  candidateCount: z.number().int().min(1).max(4).default(1),
  diversity: payloadDiversitySchema.default("balanced"),
  confirmProjectReadOnly: z.boolean().default(false),
  parentRevisionId: z.string().min(1).nullable().default(null),
  feedback: z.string().max(200_000).nullable().default(null)
});

export const refinePayloadRevisionInputSchema = z.object({
  feedback: z.string().trim().min(1).max(200_000),
  candidateCount: z.number().int().min(1).max(4).optional(),
  diversity: payloadDiversitySchema.optional(),
  confirmProjectReadOnly: z.boolean().default(false)
});

export const derivePayloadRevisionInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("edit"), text: z.string().max(1_000_000) }),
  z.object({ kind: z.literal("transform"), transformId: payloadTransformIdSchema, version: z.literal(1), parameters: payloadTransformParameterRecordSchema.optional() }),
  z.object({ kind: z.literal("pipeline"), pipelineRevisionId: z.string().min(1), variables: payloadTransformParameterRecordSchema.default({}) })
]);

export type PayloadGeneratorProfileValue = z.infer<typeof payloadGeneratorProfileValueSchema>;
export type CreatePayloadGenerationInput = z.infer<typeof createPayloadGenerationInputSchema>;
