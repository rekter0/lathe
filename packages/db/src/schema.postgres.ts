import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import type {
  JsonObject,
  JsonValue,
  MessagePart,
  ModelCapabilities,
  PayloadDiversity,
  PayloadGenerationOptions,
  PayloadGenerationStatus,
  PayloadRevisionOperation,
  ResolvedConfig,
  RunClassification,
  RunStatus
} from "@lathe/domain";

export const projects = pgTable("projects", {
  id: text("id").primaryKey(), name: text("name").notNull(), description: text("description").notNull(),
  targetName: text("target_name").notNull().default(""),
  defaultHarnessRevisionId: text("default_harness_revision_id"), workspaceRoot: text("workspace_root"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull()
});
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(), description: text("description").notNull().default(""), providerProfileId: text("provider_profile_id"), modelId: text("model_id"), activeBranchId: text("active_branch_id"),
  draftConfig: jsonb("draft_config").$type<ResolvedConfig>().notNull(), autoContinueTools: boolean("auto_continue_tools").notNull(),
  autoContinueLimit: integer("auto_continue_limit").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull()
}, (table) => [index("sessions_project_idx").on(table.projectId)]);
export const messageNodes = pgTable("message_nodes", {
  id: text("id").primaryKey(), sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }), parentId: text("parent_id"),
  role: text("role").notNull(), parts: jsonb("parts").$type<MessagePart[]>().notNull(), sourceRunId: text("source_run_id"), configSnapshotId: text("config_snapshot_id"), sourcePayloadRevisionId: text("source_payload_revision_id"), createdAt: text("created_at").notNull()
}, (table) => [index("message_nodes_session_idx").on(table.sessionId), index("message_nodes_parent_idx").on(table.parentId)]);
export const branches = pgTable("branches", {
  id: text("id").primaryKey(), sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }), name: text("name").notNull(),
  headNodeId: text("head_node_id"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull()
}, (table) => [index("branches_session_idx").on(table.sessionId), uniqueIndex("branches_session_name_uq").on(table.sessionId, table.name)]);
export const configSnapshots = pgTable("config_snapshots", {
  id: text("id").primaryKey(), sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  config: jsonb("config").$type<ResolvedConfig>().notNull(), contentHash: text("content_hash").notNull(), createdAt: text("created_at").notNull()
}, (table) => [index("config_snapshots_session_idx").on(table.sessionId)]);
export const checkpoints = pgTable("checkpoints", {
  id: text("id").primaryKey(), sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }), name: text("name").notNull(),
  nodeId: text("node_id"), configSnapshotId: text("config_snapshot_id").notNull().references(() => configSnapshots.id),
  providerProfileId: text("provider_profile_id"), modelId: text("model_id"), autoContinueTools: boolean("auto_continue_tools").notNull().default(false),
  autoContinueLimit: integer("auto_continue_limit").notNull().default(8), sessionStateCaptured: boolean("session_state_captured").notNull().default(false), createdAt: text("created_at").notNull()
}, (table) => [index("checkpoints_session_idx").on(table.sessionId)]);
export const modelRuns = pgTable("model_runs", {
  id: text("id").primaryKey(), sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }), branchId: text("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  contextNodeId: text("context_node_id"), resultNodeId: text("result_node_id"), configSnapshotId: text("config_snapshot_id").notNull().references(() => configSnapshots.id), status: text("status").notNull(),
  classification: text("classification"), operatorLabel: text("operator_label"), operatorNotes: text("operator_notes"), normalizedOutput: jsonb("normalized_output").$type<JsonValue>(),
  usage: jsonb("usage").$type<JsonObject>(), traceHash: text("trace_hash"), startedAt: text("started_at"), finishedAt: text("finished_at"), createdAt: text("created_at").notNull()
}, (table) => [index("model_runs_session_idx").on(table.sessionId), index("model_runs_branch_idx").on(table.branchId)]);
export const providerProfiles = pgTable("provider_profiles", {
  id: text("id").primaryKey(), label: text("label").notNull(), protocol: text("protocol").notNull(), baseUrl: text("base_url").notNull(), endpointOverride: text("endpoint_override"), credential: text("credential").notNull(),
  headers: jsonb("headers").$type<Record<string, string>>().notNull(), extraBody: jsonb("extra_body").$type<JsonObject>().notNull(), models: jsonb("models").$type<Array<{ id: string; label: string; capabilities: ModelCapabilities; discovered: boolean }>>().notNull(),
  revision: integer("revision").notNull(), archivedAt: text("archived_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull()
});
export const secrets = pgTable("secrets", {
  id: text("id").primaryKey(), label: text("label").notNull(), value: text("value").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull()
});
export const assetRevisions = pgTable("asset_revisions", {
  id: text("id").primaryKey(), assetId: text("asset_id").notNull(), kind: text("kind").notNull(), revision: integer("revision").notNull(), name: text("name").notNull(), description: text("description").notNull(),
  tags: jsonb("tags").$type<string[]>().notNull(), provenance: jsonb("provenance").$type<JsonObject>().notNull(), value: jsonb("value").$type<JsonValue>().notNull(), contentHash: text("content_hash").notNull(), trusted: boolean("trusted").notNull(), archivedAt: text("archived_at"), createdAt: text("created_at").notNull()
}, (table) => [uniqueIndex("asset_revisions_asset_revision_uq").on(table.assetId, table.revision), index("asset_revisions_kind_idx").on(table.kind)]);
export const attachments = pgTable("attachments", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }), fileName: text("file_name").notNull(), mediaType: text("media_type").notNull(), size: integer("size").notNull(), sha256: text("sha256").notNull(), createdAt: text("created_at").notNull()
}, (table) => [index("attachments_project_idx").on(table.projectId), index("attachments_hash_idx").on(table.sha256)]);
export const findings = pgTable("findings", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }), sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }), branchId: text("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }), nodeId: text("node_id"),
  title: text("title").notNull(), severity: text("severity").notNull(), summary: text("summary").notNull(), expected: text("expected").notNull(), observed: text("observed").notNull(), tags: jsonb("tags").$type<string[]>().notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull()
}, (table) => [index("findings_project_idx").on(table.projectId)]);
export const automationJobs = pgTable("automation_jobs", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }), sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }), kind: text("kind").notNull(), status: text("status").notNull(), concurrency: integer("concurrency").notNull(), plan: jsonb("plan").$type<JsonObject>().notNull(), progress: jsonb("progress").$type<JsonObject>().notNull(), error: jsonb("error").$type<JsonObject>(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull()
}, (table) => [index("automation_jobs_session_idx").on(table.sessionId)]);

export const payloadWorkbenchSettings = pgTable("payload_workbench_settings", {
  id: text("id").primaryKey(),
  defaultGeneratorProfileRevisionId: text("default_generator_profile_revision_id"),
  defaultInstructionRevisionId: text("default_instruction_revision_id"),
  candidateCount: integer("candidate_count").notNull(), diversity: text("diversity").$type<PayloadDiversity>().notNull(),
  contextMode: text("context_mode").$type<PayloadGenerationOptions["contextMode"]>().notNull(),
  includeProjectBrief: boolean("include_project_brief").notNull(), includeSessionBrief: boolean("include_session_brief").notNull(),
  includeTargetConfig: boolean("include_target_config").notNull(), budgetChars: integer("budget_chars").notNull(),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull()
});
export const payloadGenerations = pgTable("payload_generations", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }), branchId: text("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  contextNodeId: text("context_node_id"), parentRevisionId: text("parent_revision_id"), feedback: text("feedback"), operatorInstruction: text("operator_instruction").notNull(),
  generatorProfileRevisionId: text("generator_profile_revision_id").notNull(), instructionRevisionId: text("instruction_revision_id"),
  techniqueRevisionIds: jsonb("technique_revision_ids").$type<string[]>().notNull(), pipelineRevisionId: text("pipeline_revision_id"),
  variables: jsonb("variables").$type<JsonObject>().notNull(), contextOptions: jsonb("context_options").$type<PayloadGenerationOptions>().notNull(),
  candidateCount: integer("candidate_count").notNull(), diversity: text("diversity").$type<PayloadDiversity>().notNull(),
  contextSnapshot: jsonb("context_snapshot").$type<JsonObject>().notNull(), contextHash: text("context_hash").notNull(),
  status: text("status").$type<PayloadGenerationStatus>().notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(), deletedAt: text("deleted_at")
}, (table) => [index("payload_generations_session_idx").on(table.sessionId), index("payload_generations_branch_idx").on(table.branchId), index("payload_generations_status_idx").on(table.status)]);
export const payloadGenerationAttempts = pgTable("payload_generation_attempts", {
  id: text("id").primaryKey(), generationId: text("generation_id").notNull().references(() => payloadGenerations.id, { onDelete: "cascade" }), ordinal: integer("ordinal").notNull(),
  backendSnapshot: jsonb("backend_snapshot").$type<JsonObject>().notNull(), providerProfileId: text("provider_profile_id"), modelId: text("model_id"), configSnapshotId: text("config_snapshot_id"),
  nativeThreadId: text("native_thread_id"), nativeTurnId: text("native_turn_id"), status: text("status").$type<RunStatus>().notNull(), classification: text("classification").$type<RunClassification>(),
  normalizedOutput: jsonb("normalized_output").$type<JsonValue>(), usage: jsonb("usage").$type<JsonObject>(), traceHash: text("trace_hash"), startedAt: text("started_at"), finishedAt: text("finished_at"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull()
}, (table) => [uniqueIndex("payload_attempts_generation_ordinal_uq").on(table.generationId, table.ordinal), index("payload_attempts_generation_idx").on(table.generationId)]);
export const payloadRevisions = pgTable("payload_revisions", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }), sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  generationId: text("generation_id").references(() => payloadGenerations.id, { onDelete: "cascade" }), attemptId: text("attempt_id").references(() => payloadGenerationAttempts.id, { onDelete: "set null" }),
  parentRevisionId: text("parent_revision_id"), ordinal: integer("ordinal").notNull(), operation: text("operation").$type<PayloadRevisionOperation>().notNull(), text: text("text").notNull(), contentHash: text("content_hash").notNull(),
  provenance: jsonb("provenance").$type<JsonObject>().notNull(), createdAt: text("created_at").notNull(), deletedAt: text("deleted_at")
}, (table) => [index("payload_revisions_session_idx").on(table.sessionId), index("payload_revisions_generation_idx").on(table.generationId), index("payload_revisions_parent_idx").on(table.parentRevisionId)]);

export const postgresSchema = {
  projects, sessions, messageNodes, branches, configSnapshots, checkpoints, modelRuns, providerProfiles, secrets,
  assetRevisions, attachments, findings, automationJobs, payloadWorkbenchSettings, payloadGenerations,
  payloadGenerationAttempts, payloadRevisions
};
