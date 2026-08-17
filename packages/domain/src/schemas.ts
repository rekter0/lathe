import { z } from "zod";
import type {
  JsonValue,
  PayloadGenerationOptions,
  PayloadGenerationStatus,
  PayloadRevisionOperation,
  PayloadWorkbenchSettings,
  ApplicationSettings,
  SessionPayloadWorkbenchSettings,
  ResolvedConfig
} from "./types.js";

export const idSchema = z.string().min(1);
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const providerProtocolSchema = z.enum([
  "openai-responses",
  "openai-chat",
  "anthropic-messages"
]);

const httpUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
}, "URL must use http: or https: and cannot contain embedded credentials");

const providerHeadersSchema = z.record(
  z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, "Invalid HTTP header name"),
  z.string().refine((value) => !/[\r\n]/.test(value), "HTTP header values cannot contain CR or LF")
);

export const modelCapabilitiesSchema = z.object({
  streaming: z.boolean().default(true),
  tools: z.boolean().default(true),
  images: z.boolean().default(false),
  files: z.boolean().default(false),
  jsonMode: z.boolean().default(false),
  maxContextTokens: z.number().int().positive().nullable().default(null)
});

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export const resolvedConfigSchema: z.ZodType<ResolvedConfig> = z.object({
  promptBlocks: z.array(z.object({
    revisionId: idSchema,
    name: z.string().trim().min(1).max(120),
    content: z.string().max(1_000_000),
    enabled: z.boolean(),
    order: z.number().int().nonnegative()
  })).max(1_000),
  tools: z.array(z.object({
    toolRevisionId: idSchema,
    implementationRevisionId: idSchema.nullable(),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(20_000),
    inputSchema: jsonObjectSchema,
    enabled: z.boolean(),
    mode: z.enum(["manual", "mock", "real", "mcp"]),
    targetId: idSchema.nullable(),
    mcpServerId: idSchema.nullable()
  })).max(1_000),
  toolApprovalMode: z.enum(["manual", "bypass-approval"]).default("manual"),
  provider: z.object({
    profileId: idSchema,
    profileRevision: z.number().int().positive(),
    protocol: providerProtocolSchema,
    label: z.string().min(1),
    baseUrl: httpUrlSchema,
    endpointOverride: httpUrlSchema.nullable().optional(),
    modelId: z.string().min(1),
    headers: providerHeadersSchema,
    extraBody: jsonObjectSchema,
    capabilities: modelCapabilitiesSchema
  }).nullable(),
  temperature: z.number().finite().min(0).max(2).nullable(),
  maxOutputTokens: z.number().int().positive().max(10_000_000).nullable(),
  protocolOverrides: z.object({
    "openai-responses": jsonObjectSchema.optional(),
    "openai-chat": jsonObjectSchema.optional(),
    "anthropic-messages": jsonObjectSchema.optional()
  }),
  compileWarnings: z.array(z.string().max(20_000)).max(1_000)
}) as z.ZodType<ResolvedConfig>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4_000).default(""),
  targetName: z.string().trim().max(200).default(""),
  workspaceRoot: z.string().trim().min(1).nullable().optional()
});

export const updateProjectSchema = createProjectSchema.partial();

export const assetKindSchema = z.enum([
  "prompt",
  "tool-spec",
  "tool-implementation",
  "harness",
  "target",
  "mcp-server",
  "payload-generator-profile",
  "payload-generator-instruction",
  "payload-technique",
  "payload-pipeline",
  "payload-recipe"
]);

export const createSessionSchema = z.object({
  projectId: idSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4_000).default(""),
  providerProfileId: idSchema.nullable().optional(),
  modelId: z.string().trim().min(1).nullable().optional(),
  harnessRevisionId: idSchema.nullable().optional()
}).refine(
  (value) => (value.providerProfileId == null) === (value.modelId == null),
  { message: "Provider and model must either both be selected or both be omitted" }
);

export const updateSessionMetadataSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(4_000).optional()
}).refine(
  (value) => value.name !== undefined || value.description !== undefined,
  "At least one session metadata field is required"
);

export const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });
export const attachmentPartSchema = z.object({
  type: z.literal("attachment"),
  attachmentId: idSchema,
  name: z.string(),
  mediaType: z.string()
});
export const toolCallPartSchema = z.object({
  type: z.literal("tool-call"),
  callId: z.string(),
  name: z.string(),
  arguments: jsonValueSchema,
  providerData: z.record(z.string(), jsonValueSchema).optional()
});
export const toolResultPartSchema = z.object({
  type: z.literal("tool-result"),
  callId: z.string(),
  name: z.string(),
  result: jsonValueSchema,
  isError: z.boolean().default(false)
});
export const messagePartSchema = z.discriminatedUnion("type", [
  textPartSchema,
  attachmentPartSchema,
  toolCallPartSchema,
  toolResultPartSchema
]);

export const appendMessageSchema = z.object({
  branchId: idSchema,
  parentId: idSchema.nullable().optional(),
  role: z.enum(["user", "assistant", "tool"]),
  parts: z.array(messagePartSchema).min(1),
  configSnapshotId: idSchema.nullable().optional(),
  sourcePayloadRevisionId: idSchema.nullable().optional()
});

export const payloadContextModeSchema = z.enum(["none", "minimal", "full"]);
export const payloadDiversitySchema = z.enum(["low", "balanced", "high"]);

export const applicationSettingsInputSchema = z.object({
  redactionEnabled: z.boolean()
}).strict() satisfies z.ZodType<Omit<ApplicationSettings, "id" | "createdAt" | "updatedAt">>;

export const payloadGenerationOptionsSchema: z.ZodType<PayloadGenerationOptions> = z.object({
  contextMode: payloadContextModeSchema,
  includeProjectBrief: z.boolean(),
  includeSessionBrief: z.boolean(),
  includeTargetConfig: z.boolean(),
  budgetChars: z.number().int().min(2_000).max(200_000)
});

export const payloadWorkbenchSettingsInputSchema = z.object({
  defaultGeneratorProfileRevisionId: idSchema.nullable().default(null),
  defaultInstructionRevisionId: idSchema.nullable().default(null),
  candidateCount: z.number().int().min(1).max(4).default(1),
  diversity: payloadDiversitySchema.default("balanced"),
  contextMode: payloadContextModeSchema,
  includeProjectBrief: z.boolean(),
  includeSessionBrief: z.boolean(),
  includeTargetConfig: z.boolean(),
  budgetChars: z.number().int().min(2_000).max(200_000)
}) satisfies z.ZodType<Omit<PayloadWorkbenchSettings, "id" | "createdAt" | "updatedAt">>;

const sessionVariantParameterRecordSchema = z.record(
  z.string().min(1).max(120),
  z.string().max(20_000)
).superRefine((parameters, context) => {
  const entries = Object.entries(parameters);
  if (entries.length > 256) {
    context.addIssue({ code: "custom", message: "A variant parameter set may contain at most 256 entries" });
  }
  const codePoints = entries.reduce((total, [name, value]) => total + [...name].length + [...value].length, 0);
  if (codePoints > 200_000) {
    context.addIssue({ code: "custom", message: "A variant parameter set may contain at most 200000 Unicode code points" });
  }
});

export const payloadVariantMatrixDraftSchema = z.object({
  transformId: z.string().trim().min(1).max(120),
  version: z.literal(1),
  parameterSets: z.array(sessionVariantParameterRecordSchema).min(1).max(32)
}).strict().superRefine((matrix, context) => {
  const codePoints = matrix.parameterSets.reduce((total, parameters) => (
    total + Object.entries(parameters).reduce((rowTotal, [name, value]) => rowTotal + [...name].length + [...value].length, 0)
  ), 0);
  if (codePoints > 200_000) {
    context.addIssue({ code: "custom", path: ["parameterSets"], message: "Variant matrix parameters may contain at most 200000 Unicode code points in total" });
  }
});

export const sessionPayloadWorkbenchSettingsInputSchema = z.object({
  generatorProfileRevisionId: idSchema.nullable(),
  instructionRevisionId: idSchema.nullable(),
  techniqueRevisionIds: z.array(idSchema).max(100).refine(
    (ids) => new Set(ids).size === ids.length,
    "Payload technique revision IDs must be unique"
  ),
  pipelineRevisionId: idSchema.nullable(),
  operatorInstruction: z.string().max(200_000),
  variables: z.record(z.string(), z.string().max(20_000)),
  candidateCount: z.number().int().min(1).max(4),
  diversity: payloadDiversitySchema,
  variantMatrix: payloadVariantMatrixDraftSchema.nullable().default(null),
  contextMode: payloadContextModeSchema,
  includeProjectBrief: z.boolean(),
  includeSessionBrief: z.boolean(),
  includeTargetConfig: z.boolean(),
  budgetChars: z.number().int().min(2_000).max(200_000)
}) satisfies z.ZodType<Omit<SessionPayloadWorkbenchSettings, "sessionId" | "createdAt" | "updatedAt">>;

export const payloadGenerationStatusSchema = z.enum([
  "queued",
  "streaming",
  "partial",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]) satisfies z.ZodType<PayloadGenerationStatus>;

export const createPayloadGenerationSchema = z.object({
  projectId: idSchema,
  sessionId: idSchema,
  branchId: idSchema,
  contextNodeId: idSchema.nullable().default(null),
  parentRevisionId: idSchema.nullable().default(null),
  feedback: z.string().max(200_000).nullable().default(null),
  operatorInstruction: z.string().min(1).max(200_000),
  generatorProfileRevisionId: idSchema,
  instructionRevisionId: idSchema.nullable().default(null),
  techniqueRevisionIds: z.array(idSchema).max(1_000).refine(
    (ids) => new Set(ids).size === ids.length,
    "Payload technique revision IDs must be unique"
  ),
  pipelineRevisionId: idSchema.nullable().default(null),
  variables: jsonObjectSchema,
  contextOptions: payloadGenerationOptionsSchema,
  candidateCount: z.number().int().min(1).max(4),
  diversity: payloadDiversitySchema,
  contextSnapshot: jsonObjectSchema
});

export const updatePayloadGenerationSchema = z.object({
  status: payloadGenerationStatusSchema
});

export const runStatusSchema = z.enum([
  "queued",
  "streaming",
  "awaiting-tool",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

export const runClassificationSchema = z.enum([
  "transport",
  "authentication",
  "rate-limit",
  "invalid-request",
  "content-policy",
  "unavailable",
  "timeout",
  "parse-failure",
  "interrupted-stream",
  "cancelled",
  "tool-failure",
  "unknown"
]);

export const createPayloadGenerationAttemptSchema = z.object({
  generationId: idSchema,
  ordinal: z.number().int().positive(),
  backendSnapshot: jsonObjectSchema,
  providerProfileId: idSchema.nullable().default(null),
  modelId: z.string().trim().min(1).max(500).nullable().default(null),
  configSnapshotId: idSchema.nullable().default(null),
  nativeThreadId: z.string().max(10_000).nullable().default(null),
  nativeTurnId: z.string().max(10_000).nullable().default(null)
});

export const updatePayloadGenerationAttemptSchema = z.object({
  status: runStatusSchema.optional(),
  classification: runClassificationSchema.nullable().optional(),
  normalizedOutput: jsonValueSchema.nullable().optional(),
  usage: jsonObjectSchema.nullable().optional(),
  traceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  nativeThreadId: z.string().max(10_000).nullable().optional(),
  nativeTurnId: z.string().max(10_000).nullable().optional(),
  startedAt: z.iso.datetime().nullable().optional(),
  finishedAt: z.iso.datetime().nullable().optional()
}).refine((patch) => Object.keys(patch).length > 0, "Attempt update cannot be empty");

export const payloadRevisionOperationSchema = z.enum([
  "generated",
  "refined",
  "edited",
  "transformed"
]) satisfies z.ZodType<PayloadRevisionOperation>;

export const createPayloadRevisionSchema = z.object({
  projectId: idSchema,
  sessionId: idSchema,
  generationId: idSchema.nullable().default(null),
  attemptId: idSchema.nullable().default(null),
  parentRevisionId: idSchema.nullable().default(null),
  ordinal: z.number().int().positive(),
  operation: payloadRevisionOperationSchema,
  text: z.string().max(10_000_000),
  provenance: jsonObjectSchema
});

export type PayloadWorkbenchSettingsInput = z.input<typeof payloadWorkbenchSettingsInputSchema>;
export type ApplicationSettingsInput = z.input<typeof applicationSettingsInputSchema>;
export type SessionPayloadWorkbenchSettingsInput = z.input<typeof sessionPayloadWorkbenchSettingsInputSchema>;
export type CreatePayloadGenerationInput = z.input<typeof createPayloadGenerationSchema>;
export type UpdatePayloadGenerationInput = z.input<typeof updatePayloadGenerationSchema>;
export type CreatePayloadGenerationAttemptInput = z.input<typeof createPayloadGenerationAttemptSchema>;
export type UpdatePayloadGenerationAttemptInput = z.input<typeof updatePayloadGenerationAttemptSchema>;
export type CreatePayloadRevisionInput = z.input<typeof createPayloadRevisionSchema>;

export const createBranchSchema = z.object({
  sessionId: idSchema,
  name: z.string().trim().min(1).max(120),
  headNodeId: idSchema.nullable().optional()
});

export const moveBranchSchema = z.object({ headNodeId: idSchema.nullable() });

export const createCheckpointSchema = z.object({
  sessionId: idSchema,
  name: z.string().trim().min(1).max(120),
  nodeId: idSchema.nullable(),
  configSnapshotId: idSchema
});

export const createProviderProfileSchema = z.object({
  label: z.string().trim().min(1).max(120),
  protocol: providerProtocolSchema,
  baseUrl: httpUrlSchema,
  endpointOverride: httpUrlSchema.nullable().optional(),
  credential: z.string().default(""),
  headers: providerHeadersSchema.default({}),
  extraBody: z.record(z.string(), jsonValueSchema).default({}),
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        capabilities: modelCapabilitiesSchema,
        discovered: z.boolean().default(false)
      })
    )
    .default([])
});

export const createRunSchema = z.object({
  sessionId: idSchema,
  branchId: idSchema,
  contextNodeId: idSchema.nullable().optional(),
  userMessage: z.string().min(1).optional(),
  sourcePayloadRevisionId: idSchema.nullable().optional(),
  config: resolvedConfigSchema.optional()
}).refine(
  (value) => value.sourcePayloadRevisionId == null || value.userMessage !== undefined,
  { message: "A source payload revision requires a user message", path: ["sourcePayloadRevisionId"] }
);

export const createFindingSchema = z.object({
  projectId: idSchema,
  sessionId: idSchema,
  branchId: idSchema,
  nodeId: idSchema.nullable().optional(),
  title: z.string().trim().min(1).max(200),
  severity: z.enum(["informational", "low", "medium", "high", "critical"]),
  summary: z.string().default(""),
  expected: z.string().default(""),
  observed: z.string().default(""),
  tags: z.array(z.string()).default([])
});

const replayUserStepSchema = z.object({
  kind: z.literal("user"),
  parts: z.array(messagePartSchema).min(1).refine(
    (parts) => parts.some((part) => part.type === "text" && part.text.length > 0),
    "A replayed user step requires non-empty text"
  )
});

const replayToolResultStepSchema = z.object({
  kind: z.literal("tool-result"),
  parts: z.array(toolResultPartSchema).min(1)
});

export const replayAutomationPlanSchema = z.object({
  sourceBranchId: idSchema,
  destinationBranchId: idSchema,
  steps: z.array(z.discriminatedUnion("kind", [replayUserStepSchema, replayToolResultStepSchema])).min(1).max(10_000)
});

export const payloadFanoutPlanSchema = z.object({
  payload: z.string().min(1).max(1_000_000),
  branchIds: z.array(idSchema).min(1).max(10_000).refine(
    (ids) => new Set(ids).size === ids.length,
    "Payload fan-out branch IDs must be unique"
  )
});

const jsonPointerSchema = z.string().max(10_000).refine(
  (pointer) => pointer === "" || (pointer.startsWith("/") && !/(?:~(?![01]))/.test(pointer)),
  "JSON Pointer must be empty or start with '/', and '~' escapes must be ~0 or ~1"
);

const batchTemplateSchema = z.object({
  branchId: idSchema.optional(),
  sourceBranchId: idSchema.optional(),
  payload: jsonValueSchema.optional(),
  config: resolvedConfigSchema.optional()
}).catchall(jsonValueSchema).refine(
  (template) => typeof template.branchId === "string" || typeof template.sourceBranchId === "string",
  "Batch template requires branchId or sourceBranchId"
);

export const batchVaryPlanSchema = z.object({
  pointer: jsonPointerSchema,
  values: z.array(jsonValueSchema).min(1).max(10_000),
  template: batchTemplateSchema
});

const automationEnvelope = {
  projectId: idSchema,
  sessionId: idSchema,
  concurrency: z.number().int().min(1).max(10).default(3)
};

export const createAutomationSchema = z.discriminatedUnion("kind", [
  z.object({ ...automationEnvelope, kind: z.literal("replay"), plan: replayAutomationPlanSchema }),
  z.object({ ...automationEnvelope, kind: z.literal("payload-fanout"), plan: payloadFanoutPlanSchema }),
  z.object({ ...automationEnvelope, kind: z.literal("batch-vary"), plan: batchVaryPlanSchema })
]);
