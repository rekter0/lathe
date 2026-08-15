import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import type { JsonObject, JsonValue, MessagePart, ModelCapabilities, ResolvedConfig } from "@lathe/domain";

export const projects = pgTable("projects", {
  id: text("id").primaryKey(), name: text("name").notNull(), description: text("description").notNull(),
  defaultHarnessRevisionId: text("default_harness_revision_id"), workspaceRoot: text("workspace_root"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull()
});
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(), providerProfileId: text("provider_profile_id"), modelId: text("model_id"), activeBranchId: text("active_branch_id"),
  draftConfig: jsonb("draft_config").$type<ResolvedConfig>().notNull(), autoContinueTools: boolean("auto_continue_tools").notNull(),
  autoContinueLimit: integer("auto_continue_limit").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull()
}, (table) => [index("sessions_project_idx").on(table.projectId)]);
export const messageNodes = pgTable("message_nodes", {
  id: text("id").primaryKey(), sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }), parentId: text("parent_id"),
  role: text("role").notNull(), parts: jsonb("parts").$type<MessagePart[]>().notNull(), sourceRunId: text("source_run_id"), configSnapshotId: text("config_snapshot_id"), createdAt: text("created_at").notNull()
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

export const postgresSchema = { projects, sessions, messageNodes, branches, configSnapshots, checkpoints, modelRuns, providerProfiles, secrets, assetRevisions, attachments, findings, automationJobs };
