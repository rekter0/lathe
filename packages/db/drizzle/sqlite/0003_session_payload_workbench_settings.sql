CREATE TABLE `session_payload_workbench_settings` (
	`session_id` text PRIMARY KEY NOT NULL,
	`generator_profile_revision_id` text,
	`instruction_revision_id` text,
	`technique_revision_ids` text NOT NULL,
	`pipeline_revision_id` text,
	`operator_instruction` text NOT NULL,
	`variables` text NOT NULL,
	`candidate_count` integer NOT NULL,
	`diversity` text NOT NULL,
	`context_mode` text NOT NULL,
	`include_project_brief` integer NOT NULL,
	`include_session_brief` integer NOT NULL,
	`include_target_config` integer NOT NULL,
	`budget_chars` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
