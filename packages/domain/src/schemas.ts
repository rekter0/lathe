import { z } from "zod";
import type { JsonValue, ResolvedConfig } from "./types.js";

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

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

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
  workspaceRoot: z.string().trim().min(1).nullable().optional()
});

export const updateProjectSchema = createProjectSchema.partial();

export const createSessionSchema = z.object({
  projectId: idSchema,
  name: z.string().trim().min(1).max(120),
  providerProfileId: idSchema.nullable().optional(),
  modelId: z.string().trim().min(1).nullable().optional(),
  harnessRevisionId: idSchema.nullable().optional()
}).refine(
  (value) => (value.providerProfileId == null) === (value.modelId == null),
  { message: "Provider and model must either both be selected or both be omitted" }
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
  configSnapshotId: idSchema.nullable().optional()
});

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
  config: resolvedConfigSchema.optional()
});

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
