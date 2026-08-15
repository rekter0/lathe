CREATE TABLE `projects` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL,
  `default_harness_revision_id` text,
  `workspace_root` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
  `name` text NOT NULL,
  `provider_profile_id` text,
  `model_id` text,
  `active_branch_id` text,
  `draft_config` text NOT NULL,
  `auto_continue_tools` integer NOT NULL,
  `auto_continue_limit` integer NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_project_idx` ON `sessions` (`project_id`);
--> statement-breakpoint
CREATE TABLE `branches` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE cascade,
  `name` text NOT NULL,
  `head_node_id` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `branches_session_idx` ON `branches` (`session_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `branches_session_name_uq` ON `branches` (`session_id`,`name`);
--> statement-breakpoint
CREATE TABLE `config_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE cascade,
  `config` text NOT NULL,
  `content_hash` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `config_snapshots_session_idx` ON `config_snapshots` (`session_id`);
--> statement-breakpoint
CREATE TABLE `message_nodes` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE cascade,
  `parent_id` text,
  `role` text NOT NULL,
  `parts` text NOT NULL,
  `source_run_id` text,
  `config_snapshot_id` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `message_nodes_session_idx` ON `message_nodes` (`session_id`);
--> statement-breakpoint
CREATE INDEX `message_nodes_parent_idx` ON `message_nodes` (`parent_id`);
--> statement-breakpoint
CREATE TABLE `checkpoints` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE cascade,
  `name` text NOT NULL,
  `node_id` text,
  `config_snapshot_id` text NOT NULL REFERENCES `config_snapshots`(`id`),
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `checkpoints_session_idx` ON `checkpoints` (`session_id`);
--> statement-breakpoint
CREATE TABLE `model_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE cascade,
  `branch_id` text NOT NULL REFERENCES `branches`(`id`) ON DELETE cascade,
  `context_node_id` text,
  `result_node_id` text,
  `config_snapshot_id` text NOT NULL REFERENCES `config_snapshots`(`id`),
  `status` text NOT NULL,
  `classification` text,
  `operator_label` text,
  `operator_notes` text,
  `normalized_output` text,
  `usage` text,
  `trace_hash` text,
  `started_at` text,
  `finished_at` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_runs_session_idx` ON `model_runs` (`session_id`);
--> statement-breakpoint
CREATE INDEX `model_runs_branch_idx` ON `model_runs` (`branch_id`);
--> statement-breakpoint
CREATE TABLE `provider_profiles` (
  `id` text PRIMARY KEY NOT NULL,
  `label` text NOT NULL,
  `protocol` text NOT NULL,
  `base_url` text NOT NULL,
  `endpoint_override` text,
  `credential` text NOT NULL,
  `headers` text NOT NULL,
  `extra_body` text NOT NULL,
  `models` text NOT NULL,
  `revision` integer NOT NULL,
  `archived_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secrets` (
  `id` text PRIMARY KEY NOT NULL,
  `label` text NOT NULL,
  `value` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `asset_revisions` (
  `id` text PRIMARY KEY NOT NULL,
  `asset_id` text NOT NULL,
  `kind` text NOT NULL,
  `revision` integer NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL,
  `tags` text NOT NULL,
  `provenance` text NOT NULL,
  `value` text NOT NULL,
  `content_hash` text NOT NULL,
  `trusted` integer NOT NULL,
  `archived_at` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_revisions_asset_revision_uq` ON `asset_revisions` (`asset_id`,`revision`);
--> statement-breakpoint
CREATE INDEX `asset_revisions_kind_idx` ON `asset_revisions` (`kind`);
--> statement-breakpoint
CREATE TABLE `attachments` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
  `file_name` text NOT NULL,
  `media_type` text NOT NULL,
  `size` integer NOT NULL,
  `sha256` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attachments_project_idx` ON `attachments` (`project_id`);
--> statement-breakpoint
CREATE INDEX `attachments_hash_idx` ON `attachments` (`sha256`);
--> statement-breakpoint
CREATE TABLE `findings` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE cascade,
  `branch_id` text NOT NULL REFERENCES `branches`(`id`) ON DELETE cascade,
  `node_id` text,
  `title` text NOT NULL,
  `severity` text NOT NULL,
  `summary` text NOT NULL,
  `expected` text NOT NULL,
  `observed` text NOT NULL,
  `tags` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `findings_project_idx` ON `findings` (`project_id`);
--> statement-breakpoint
CREATE TABLE `automation_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE cascade,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `concurrency` integer NOT NULL,
  `plan` text NOT NULL,
  `progress` text NOT NULL,
  `error` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `automation_jobs_session_idx` ON `automation_jobs` (`session_id`);
