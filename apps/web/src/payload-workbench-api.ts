import type { AssetRevision, JsonObject, JsonValue } from "@lathe/domain";

export type PayloadContextMode = "none" | "minimal" | "full";
export type PayloadGenerationStatus = "queued" | "streaming" | "partial" | "completed" | "failed" | "cancelled" | "interrupted";
export type PayloadRevisionOperation = "generated" | "refined" | "edited" | "transformed";

export type PayloadAssetKind =
  | "payload-generator-profile"
  | "payload-generator-instruction"
  | "payload-technique"
  | "payload-pipeline";

export type PayloadDiversity = "low" | "balanced" | "high";

export type PayloadAssetRevision = Omit<AssetRevision, "kind"> & { kind: PayloadAssetKind };

export interface PayloadGenerationOptions {
  contextMode: PayloadContextMode;
  includeProjectBrief: boolean;
  includeSessionBrief: boolean;
  includeTargetConfig: boolean;
  budgetChars: number;
}

export interface PayloadWorkbenchSettings extends PayloadGenerationOptions {
  defaultGeneratorProfileRevisionId: string | null;
  defaultInstructionRevisionId: string | null;
  candidateCount: 1 | 2 | 3 | 4;
  diversity: PayloadDiversity;
}

/** The operator's last Payload Workbench choices for one session. */
export interface PayloadWorkbenchSessionSettings extends PayloadGenerationOptions {
  generatorProfileRevisionId: string | null;
  instructionRevisionId: string | null;
  techniqueRevisionIds: string[];
  pipelineRevisionId: string | null;
  variables: Record<string, string>;
  operatorInstruction: string;
  candidateCount: 1 | 2 | 3 | 4;
  diversity: PayloadDiversity;
}

export const defaultPayloadWorkbenchSettings: PayloadWorkbenchSettings = {
  defaultGeneratorProfileRevisionId: null,
  defaultInstructionRevisionId: null,
  candidateCount: 1,
  diversity: "balanced",
  contextMode: "minimal",
  includeProjectBrief: true,
  includeSessionBrief: true,
  includeTargetConfig: false,
  budgetChars: 32_000
};

export interface PayloadContextPreview {
  text: string;
  includedChars: number;
  truncated: boolean;
  fits: boolean;
  requiredMinimumChars: number | null;
  warnings: string[];
  snapshot?: JsonValue;
  hash?: string;
}

export interface PayloadGeneration {
  id: string;
  projectId?: string;
  sessionId: string;
  branchId: string;
  contextNodeId: string | null;
  operatorInstruction?: string;
  generatorProfileRevisionId?: string;
  instructionRevisionId?: string | null;
  pipelineRevisionId?: string | null;
  techniqueRevisionIds?: string[];
  parentRevisionId?: string | null;
  feedback?: string | null;
  variables?: JsonObject;
  contextOptions?: PayloadGenerationOptions;
  candidateCount?: number;
  diversity?: PayloadDiversity;
  contextSnapshot?: JsonValue;
  contextHash?: string;
  status: PayloadGenerationStatus;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  error?: JsonValue | null;
}

export interface PayloadAttempt {
  id: string;
  generationId?: string;
  ordinal: number;
  status: PayloadGenerationStatus | "awaiting-tool";
  reasoning?: string;
  text?: string;
  classification?: string | null;
  providerProfileId?: string | null;
  modelId?: string | null;
  configSnapshotId?: string | null;
  nativeThreadId?: string | null;
  nativeTurnId?: string | null;
  backendSnapshot?: JsonValue;
  normalizedOutput?: JsonValue | null;
  usage?: JsonValue | null;
  traceHash?: string | null;
  error?: JsonValue | null;
}

export interface PayloadOutcome {
  revisionId: string;
  nodeId: string;
  runId: string;
  branchId: string;
  status: string;
  classification: string | null;
  operatorLabel: string | null;
  operatorNotes: string | null;
  createdAt: string;
}

export interface PayloadRevision {
  id: string;
  generationId?: string | null;
  attemptId?: string | null;
  sourceAttemptId?: string | null;
  parentRevisionId?: string | null;
  ordinal: number;
  operation: PayloadRevisionOperation;
  text: string;
  contentHash?: string;
  reasoning?: string;
  provenance?: JsonObject;
  createdAt?: string;
  deletedAt?: string | null;
}

export interface PayloadGenerationDetail {
  generation: PayloadGeneration;
  attempts: PayloadAttempt[];
  revisions: PayloadRevision[];
  outcomes?: PayloadOutcome[];
}

export interface PayloadGenerationList {
  generations: PayloadGenerationDetail[];
  nextCursor: string | null;
  standaloneRevisions?: PayloadRevision[];
  standaloneOutcomes?: PayloadOutcome[];
}

export interface PayloadGenerationEvent {
  type: string;
  data: JsonValue;
}

export interface StreamingPayloadCandidate {
  attemptId: string;
  revisionId?: string;
  ordinal: number;
  text: string;
  reasoning: string;
  status: PayloadGenerationStatus;
  classification: string | null;
  error: string | null;
  evidence?: {
    providerProfileId: string | null;
    modelId: string | null;
    nativeThreadId: string | null;
    nativeTurnId: string | null;
    traceHash: string | null;
    backendSnapshot?: JsonValue;
    usage?: JsonValue | null;
    warnings: string[];
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function boundedCandidateCount(value: unknown): 1 | 2 | 3 | 4 {
  const count = Math.max(1, Math.min(4, Math.round(numberValue(value) ?? defaultPayloadWorkbenchSettings.candidateCount)));
  return count as 1 | 2 | 3 | 4;
}

function attemptError(attempt: PayloadAttempt, normalizedOutput: Record<string, unknown> | null): string | null {
  if (typeof attempt.error === "string") return attempt.error;
  if (attempt.error !== undefined && attempt.error !== null) return JSON.stringify(attempt.error);
  const normalizedError = normalizedOutput?.error;
  if (typeof normalizedError === "string") return normalizedError;
  return stringValue(objectValue(normalizedError)?.message) ?? null;
}

function warningMessages(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => typeof item === "string" ? item : JSON.stringify(item)) : [];
}

function attemptEvidence(attempt: PayloadAttempt, normalizedOutput: Record<string, unknown> | null): NonNullable<StreamingPayloadCandidate["evidence"]> {
  return {
    providerProfileId: attempt.providerProfileId ?? null,
    modelId: attempt.modelId ?? null,
    nativeThreadId: attempt.nativeThreadId ?? null,
    nativeTurnId: attempt.nativeTurnId ?? null,
    traceHash: attempt.traceHash ?? null,
    ...(attempt.backendSnapshot !== undefined ? { backendSnapshot: attempt.backendSnapshot } : {}),
    ...(attempt.usage !== undefined ? { usage: attempt.usage } : {}),
    warnings: [
      ...warningMessages(normalizedOutput?.compileWarnings),
      ...warningMessages(normalizedOutput?.techniqueWarnings),
      ...warningMessages(objectValue(normalizedOutput?.metadata)?.warnings)
    ]
  };
}

export function normalizePayloadWorkbenchSettings(value: unknown): PayloadWorkbenchSettings {
  const source = objectValue(value) ?? {};
  const context = objectValue(source.context) ?? objectValue(source.options) ?? {};
  const mode = source.contextMode ?? source.mode ?? context.contextMode ?? context.mode;
  return {
    defaultGeneratorProfileRevisionId: stringValue(source.defaultGeneratorProfileRevisionId) ?? null,
    defaultInstructionRevisionId: stringValue(source.defaultInstructionRevisionId) ?? null,
    candidateCount: boundedCandidateCount(source.candidateCount),
    diversity: source.diversity === "low" || source.diversity === "high" ? source.diversity : "balanced",
    contextMode: mode === "none" || mode === "full" ? mode : "minimal",
    includeProjectBrief: booleanValue(source.includeProjectBrief ?? context.includeProjectBrief) ?? defaultPayloadWorkbenchSettings.includeProjectBrief,
    includeSessionBrief: booleanValue(source.includeSessionBrief ?? context.includeSessionBrief) ?? defaultPayloadWorkbenchSettings.includeSessionBrief,
    includeTargetConfig: booleanValue(source.includeTargetConfig ?? context.includeTargetConfig) ?? defaultPayloadWorkbenchSettings.includeTargetConfig,
    budgetChars: Math.max(2_000, Math.min(200_000, Math.round(numberValue(source.budgetChars ?? context.budgetChars) ?? defaultPayloadWorkbenchSettings.budgetChars)))
  };
}

function nullableString(source: Record<string, unknown>, key: string, fallback: string | null): string | null {
  if (source[key] === null) return null;
  return stringValue(source[key]) ?? fallback;
}

/**
 * Session choices are a copy-on-write layer over the operator's global
 * defaults. Older/missing rows therefore continue to receive safe defaults.
 */
export function normalizePayloadWorkbenchSessionSettings(
  value: unknown,
  fallback: PayloadWorkbenchSettings
): PayloadWorkbenchSessionSettings {
  const source = objectValue(value) ?? {};
  const normalized = normalizePayloadWorkbenchSettings({ ...fallback, ...source });
  const variables = objectValue(source.variables) ?? {};
  const techniqueIds = Array.isArray(source.techniqueRevisionIds)
    ? source.techniqueRevisionIds.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  return {
    generatorProfileRevisionId: nullableString(source, "generatorProfileRevisionId", fallback.defaultGeneratorProfileRevisionId),
    instructionRevisionId: nullableString(source, "instructionRevisionId", fallback.defaultInstructionRevisionId),
    techniqueRevisionIds: [...new Set(techniqueIds)],
    pipelineRevisionId: nullableString(source, "pipelineRevisionId", null),
    variables: Object.fromEntries(Object.entries(variables).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    operatorInstruction: stringValue(source.operatorInstruction) ?? "",
    candidateCount: normalized.candidateCount,
    diversity: normalized.diversity,
    contextMode: normalized.contextMode,
    includeProjectBrief: normalized.includeProjectBrief,
    includeSessionBrief: normalized.includeSessionBrief,
    includeTargetConfig: normalized.includeTargetConfig,
    budgetChars: normalized.budgetChars
  };
}

export function normalizePayloadContextPreview(value: unknown): PayloadContextPreview {
  const source = objectValue(value) ?? {};
  const manifest = objectValue(source.manifest) ?? {};
  const messages = source.messages;
  const fallbackText = typeof messages === "string" ? messages : messages === undefined ? "" : JSON.stringify(messages, null, 2);
  const blocks = Array.isArray(manifest.blocks) ? manifest.blocks.flatMap((item) => {
    const block = objectValue(item);
    return block ? [block] : [];
  }) : [];
  const hash = stringValue(source.hash) ?? stringValue(manifest.contextHash);
  return {
    text: stringValue(source.text) ?? stringValue(source.preview) ?? fallbackText,
    includedChars: numberValue(source.includedChars) ?? numberValue(manifest.characterCount) ?? (stringValue(source.text) ?? fallbackText).length,
    truncated: booleanValue(source.truncated)
      ?? ((numberValue(manifest.omittedTurnCount) ?? 0) > 0 || blocks.some((item) => item.truncated === true)),
    fits: booleanValue(source.fits ?? manifest.fits) ?? true,
    requiredMinimumChars: numberValue(source.requiredMinimumChars ?? manifest.requiredMinimumChars) ?? null,
    warnings: Array.isArray(source.warnings)
      ? source.warnings.filter((item): item is string => typeof item === "string")
      : Array.isArray(manifest.warnings) ? manifest.warnings.filter((item): item is string => typeof item === "string") : [],
    ...(source.snapshot !== undefined ? { snapshot: source.snapshot as JsonValue } : {}),
    ...(hash ? { hash } : {})
  };
}

export function generationOptions(settings: PayloadWorkbenchSettings): PayloadGenerationOptions {
  return {
    contextMode: settings.contextMode,
    includeProjectBrief: settings.includeProjectBrief,
    includeSessionBrief: settings.includeSessionBrief,
    includeTargetConfig: settings.includeTargetConfig,
    budgetChars: settings.budgetChars
  };
}

/** API requests use `mode`; persisted generation records use `contextMode`. */
export function payloadContextRequestOptions(settings: PayloadWorkbenchSettings): {
  mode: PayloadContextMode;
  includeProjectBrief: boolean;
  includeSessionBrief: boolean;
  includeTargetConfig: boolean;
  budgetChars: number;
} {
  return {
    mode: settings.contextMode,
    includeProjectBrief: settings.includeProjectBrief,
    includeSessionBrief: settings.includeSessionBrief,
    includeTargetConfig: settings.includeTargetConfig,
    budgetChars: settings.budgetChars
  };
}

export function candidatesFromDetail(detail: PayloadGenerationDetail): StreamingPayloadCandidate[] {
  const revisions = detail.revisions
    .filter((revision) => !revision.deletedAt && (revision.operation === "generated" || revision.operation === "refined") && Boolean(revision.attemptId ?? revision.sourceAttemptId))
    .toSorted((left, right) => left.ordinal - right.ordinal);
  if (detail.attempts.length > 0) {
    return detail.attempts.toSorted((left, right) => left.ordinal - right.ordinal).map((attempt) => {
      const revision = revisions.find((item) => (item.attemptId ?? item.sourceAttemptId) === attempt.id);
      const normalizedOutput = objectValue(attempt?.normalizedOutput);
      return {
        attemptId: attempt.id,
        ...(revision ? { revisionId: revision.id } : {}),
        ordinal: attempt.ordinal,
        text: revision?.text ?? attempt.text ?? stringValue(normalizedOutput?.text) ?? "",
        reasoning: revision?.reasoning ?? attempt.reasoning ?? stringValue(normalizedOutput?.reasoning) ?? "",
        status: attempt.status === "awaiting-tool" ? "streaming" : attempt.status,
        classification: attempt.classification ?? null,
        error: attemptError(attempt, normalizedOutput),
        evidence: attemptEvidence(attempt, normalizedOutput)
      };
    });
  }
  return revisions.map((revision) => {
    const attemptId = revision.attemptId ?? revision.sourceAttemptId;
    return {
      attemptId: attemptId ?? `revision:${revision.id}`,
      revisionId: revision.id,
      ordinal: revision.ordinal,
      text: revision.text,
      reasoning: revision.reasoning ?? "",
      status: detail.generation.status,
      classification: null,
      error: null
    };
  });
}

function eventCandidateIdentity(data: Record<string, unknown>): { attemptId: string; ordinal: number } | null {
  const attempt = objectValue(data.attempt);
  const attemptId = stringValue(data.attemptId) ?? stringValue(attempt?.id);
  const ordinal = numberValue(data.ordinal) ?? numberValue(data.candidateOrdinal) ?? numberValue(attempt?.ordinal);
  if (!attemptId && ordinal === undefined) return null;
  return { attemptId: attemptId ?? `candidate:${ordinal}`, ordinal: Math.max(1, Math.round(ordinal ?? 1)) };
}

export function reducePayloadGenerationEvent(
  current: readonly StreamingPayloadCandidate[],
  event: PayloadGenerationEvent
): StreamingPayloadCandidate[] {
  const data = objectValue(event.data) ?? {};
  const identity = eventCandidateIdentity(data);
  if (!identity) return [...current];
  const next = current.map((candidate) => ({ ...candidate }));
  let candidate = next.find((item) => item.attemptId === identity.attemptId)
    ?? next.find((item) => item.ordinal === identity.ordinal);
  if (!candidate) {
    candidate = { attemptId: identity.attemptId, ordinal: identity.ordinal, text: "", reasoning: "", status: "queued", classification: null, error: null };
    next.push(candidate);
  }
  const delta = stringValue(data.delta) ?? stringValue(data.text) ?? "";
  const eventType = event.type.toLowerCase();
  if (eventType.includes("reasoning")) candidate.reasoning += delta;
  else if (eventType.includes("text") || eventType.includes("content") || eventType.includes("candidate.delta")) candidate.text += delta;
  const explicitStatus = stringValue(data.status);
  if (explicitStatus && ["queued", "streaming", "partial", "completed", "failed", "cancelled", "interrupted"].includes(explicitStatus)) {
    candidate.status = explicitStatus as PayloadGenerationStatus;
  } else if (eventType.includes("partial")) candidate.status = "partial";
  else if (eventType.includes("completed") || eventType.includes("done")) candidate.status = "completed";
  else if (eventType.includes("failed") || eventType.includes("error")) candidate.status = "failed";
  else if (eventType.includes("cancel")) candidate.status = "cancelled";
  else if (delta) candidate.status = "streaming";
  candidate.classification = stringValue(data.classification) ?? candidate.classification;
  candidate.error = stringValue(data.error) ?? stringValue(objectValue(data.error)?.message) ?? candidate.error;
  return next.toSorted((left, right) => left.ordinal - right.ordinal);
}

export function payloadTextFromRevision(value: unknown): string {
  const source = objectValue(value);
  return stringValue(source?.text) ?? stringValue(source?.payload) ?? "";
}
