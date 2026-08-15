ALTER TABLE `projects` ADD `target_name` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `sessions` ADD `description` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `message_nodes` ADD `source_payload_revision_id` text;
--> statement-breakpoint
CREATE TABLE `payload_workbench_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`default_generator_profile_revision_id` text,
	`default_instruction_revision_id` text,
	`candidate_count` integer NOT NULL,
	`diversity` text NOT NULL,
	`context_mode` text NOT NULL,
	`include_project_brief` integer NOT NULL,
	`include_session_brief` integer NOT NULL,
	`include_target_config` integer NOT NULL,
	`budget_chars` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payload_generations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`context_node_id` text,
	`parent_revision_id` text,
	`feedback` text,
	`operator_instruction` text NOT NULL,
	`generator_profile_revision_id` text NOT NULL,
	`instruction_revision_id` text,
	`technique_revision_ids` text NOT NULL,
	`pipeline_revision_id` text,
	`variables` text NOT NULL,
	`context_options` text NOT NULL,
	`candidate_count` integer NOT NULL,
	`diversity` text NOT NULL,
	`context_snapshot` text NOT NULL,
	`context_hash` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `payload_generations_session_idx` ON `payload_generations` (`session_id`);
--> statement-breakpoint
CREATE INDEX `payload_generations_branch_idx` ON `payload_generations` (`branch_id`);
--> statement-breakpoint
CREATE INDEX `payload_generations_status_idx` ON `payload_generations` (`status`);
--> statement-breakpoint
CREATE TABLE `payload_generation_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`generation_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`backend_snapshot` text NOT NULL,
	`provider_profile_id` text,
	`model_id` text,
	`config_snapshot_id` text,
	`native_thread_id` text,
	`native_turn_id` text,
	`status` text NOT NULL,
	`classification` text,
	`normalized_output` text,
	`usage` text,
	`trace_hash` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`generation_id`) REFERENCES `payload_generations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payload_attempts_generation_ordinal_uq` ON `payload_generation_attempts` (`generation_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `payload_attempts_generation_idx` ON `payload_generation_attempts` (`generation_id`);
--> statement-breakpoint
CREATE TABLE `payload_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`generation_id` text,
	`attempt_id` text,
	`parent_revision_id` text,
	`ordinal` integer NOT NULL,
	`operation` text NOT NULL,
	`text` text NOT NULL,
	`content_hash` text NOT NULL,
	`provenance` text NOT NULL,
	`created_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`generation_id`) REFERENCES `payload_generations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attempt_id`) REFERENCES `payload_generation_attempts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `payload_revisions_session_idx` ON `payload_revisions` (`session_id`);
--> statement-breakpoint
CREATE INDEX `payload_revisions_generation_idx` ON `payload_revisions` (`generation_id`);
--> statement-breakpoint
CREATE INDEX `payload_revisions_parent_idx` ON `payload_revisions` (`parent_revision_id`);
