import { describe, expect, it } from "vitest";
import {
  createAutomationSchema,
  createPayloadGenerationSchema,
  createPayloadRevisionSchema,
  createProviderProfileSchema,
  createSessionSchema,
  emptyResolvedConfig,
  payloadWorkbenchSettingsInputSchema,
  resolvedConfigSchema,
  sessionPayloadWorkbenchSettingsInputSchema,
  updateSessionMetadataSchema
} from "../src/index.js";

describe("provider profile schema", () => {
  it("accepts HTTP endpoints but rejects credentials embedded in URLs", () => {
    expect(createProviderProfileSchema.safeParse({
      label: "Gateway",
      protocol: "openai-responses",
      baseUrl: "https://gateway.example/v1"
    }).success).toBe(true);

    expect(createProviderProfileSchema.safeParse({
      label: "Unsafe gateway",
      protocol: "openai-responses",
      baseUrl: "https://operator:password@gateway.example/v1"
    }).success).toBe(false);

    expect(createProviderProfileSchema.safeParse({
      label: "Unsafe override",
      protocol: "openai-responses",
      baseUrl: "https://gateway.example/v1",
      endpointOverride: "https://operator:password@gateway.example/v1/responses"
    }).success).toBe(false);
  });
});

describe("session schema", () => {
  it("requires provider and model selections as one atomic choice", () => {
    expect(createSessionSchema.safeParse({ projectId: "project", name: "Session" }).success).toBe(true);
    expect(createSessionSchema.safeParse({ projectId: "project", name: "Session", providerProfileId: "provider" }).success).toBe(false);
    expect(createSessionSchema.safeParse({ projectId: "project", name: "Session", modelId: "model" }).success).toBe(false);
    expect(createSessionSchema.safeParse({ projectId: "project", name: "Session", providerProfileId: "provider", modelId: "model" }).success).toBe(true);
    expect(createSessionSchema.safeParse({ projectId: "project", name: "Session", description: "x".repeat(4_001) }).success).toBe(false);
    expect(updateSessionMetadataSchema.safeParse({}).success).toBe(false);
    expect(updateSessionMetadataSchema.safeParse({ description: "Updated" }).success).toBe(true);
  });

  it("defaults legacy configs to manual tool approval and accepts explicit bypass", () => {
    const legacy = JSON.parse(JSON.stringify(emptyResolvedConfig())) as Record<string, unknown>;
    delete legacy.toolApprovalMode;
    expect(resolvedConfigSchema.parse(legacy).toolApprovalMode).toBe("manual");
    expect(resolvedConfigSchema.parse({ ...legacy, toolApprovalMode: "bypass-approval" }).toolApprovalMode).toBe("bypass-approval");
    expect(resolvedConfigSchema.safeParse({ ...legacy, toolApprovalMode: "always" }).success).toBe(false);
  });
});

describe("automation schema", () => {
  const envelope = { projectId: "project", sessionId: "session", concurrency: 3 };

  it("validates each plan by its discriminator", () => {
    expect(createAutomationSchema.safeParse({
      ...envelope,
      kind: "payload-fanout",
      plan: { payload: "probe", branchIds: ["branch"] }
    }).success).toBe(true);
    expect(createAutomationSchema.safeParse({
      ...envelope,
      kind: "payload-fanout",
      plan: { pointer: "/payload", values: ["probe"], template: {} }
    }).success).toBe(false);
  });

  it("rejects malformed JSON Pointer escapes and invalid varied configs", () => {
    expect(createAutomationSchema.safeParse({
      ...envelope,
      kind: "batch-vary",
      plan: {
        pointer: "/config/~2temperature",
        values: [0.5],
        template: { sourceBranchId: "branch", payload: "probe" }
      }
    }).success).toBe(false);
  });
});

describe("payload workbench schemas", () => {
  const options = {
    contextMode: "minimal" as const,
    includeProjectBrief: true,
    includeSessionBrief: true,
    includeTargetConfig: false,
    budgetChars: 12_000
  };

  it("applies bounded singleton defaults", () => {
    expect(payloadWorkbenchSettingsInputSchema.parse({
      defaultGeneratorProfileRevisionId: null,
      defaultInstructionRevisionId: null,
      ...options
    })).toMatchObject({ candidateCount: 1, diversity: "balanced" });
    expect(payloadWorkbenchSettingsInputSchema.safeParse({ ...options, budgetChars: 1_999 }).success).toBe(false);
    expect(payloadWorkbenchSettingsInputSchema.safeParse({ ...options, candidateCount: 5 }).success).toBe(false);
  });

  it("validates exact generation context and diversity values", () => {
    const generation = {
      projectId: "project",
      sessionId: "session",
      branchId: "branch",
      operatorInstruction: "Generate candidates",
      generatorProfileRevisionId: "profile",
      techniqueRevisionIds: ["technique"],
      variables: {},
      contextOptions: options,
      candidateCount: 1,
      diversity: "balanced",
      contextSnapshot: {}
    };
    expect(createPayloadGenerationSchema.safeParse(generation).success).toBe(true);
    expect(createPayloadGenerationSchema.safeParse({ ...generation, diversity: "maximum" }).success).toBe(false);
    expect(createPayloadGenerationSchema.safeParse({ ...generation, contextOptions: { ...options, contextMode: "project" } }).success).toBe(false);
    expect(createPayloadGenerationSchema.safeParse({ ...generation, techniqueRevisionIds: ["technique", "technique"] }).success).toBe(false);
  });

  it("validates a complete session-scoped workbench draft", () => {
    const settings = {
      generatorProfileRevisionId: "profile-r2",
      instructionRevisionId: "instruction-r3",
      techniqueRevisionIds: ["technique-r1", "technique-r2"],
      pipelineRevisionId: "pipeline-r4",
      operatorInstruction: "Generate a concise variation.",
      variables: { objective: "Test hierarchy handling" },
      candidateCount: 3,
      diversity: "high" as const,
      ...options
    };
    expect(sessionPayloadWorkbenchSettingsInputSchema.parse(settings)).toEqual(settings);
    expect(sessionPayloadWorkbenchSettingsInputSchema.safeParse({
      ...settings,
      techniqueRevisionIds: ["technique-r1", "technique-r1"]
    }).success).toBe(false);
    expect(sessionPayloadWorkbenchSettingsInputSchema.safeParse({
      ...settings,
      variables: { objective: "x".repeat(20_001) }
    }).success).toBe(false);
  });

  it("retains an exact empty payload produced by a deterministic transform", () => {
    expect(createPayloadRevisionSchema.safeParse({
      projectId: "project",
      sessionId: "session",
      generationId: null,
      attemptId: null,
      parentRevisionId: "parent",
      ordinal: 1,
      operation: "transformed",
      text: "",
      provenance: { kind: "transform" }
    }).success).toBe(true);
  });
});
