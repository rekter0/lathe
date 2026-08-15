import { isAbsolute } from "node:path";
import { z } from "zod";

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
  "base64-encode", "base64-decode", "url-encode", "url-decode", "hex-encode", "hex-decode",
  "uppercase", "lowercase", "reverse", "rot13", "json-escape", "json-unescape",
  "markdown-frame", "xml-frame", "json-frame", "repeat-twice", "render-variables"
]);

export const payloadPipelineValueSchema = z.object({
  steps: z.array(z.object({
    transformId: payloadTransformIdSchema,
    version: z.literal(1),
    enabled: z.boolean().default(true),
    parameters: z.record(z.string(), z.string()).optional()
  })).max(100)
});

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
  z.object({ kind: z.literal("transform"), transformId: payloadTransformIdSchema, version: z.literal(1), parameters: z.record(z.string(), z.string().max(20_000)).optional() }),
  z.object({ kind: z.literal("pipeline"), pipelineRevisionId: z.string().min(1), variables: z.record(z.string(), z.string().max(20_000)).default({}) })
]);

export type PayloadGeneratorProfileValue = z.infer<typeof payloadGeneratorProfileValueSchema>;
export type CreatePayloadGenerationInput = z.infer<typeof createPayloadGenerationInputSchema>;
