ALTER TABLE "projects" ADD COLUMN "target_name" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "description" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "message_nodes" ADD COLUMN "source_payload_revision_id" text;
--> statement-breakpoint
CREATE TABLE "payload_workbench_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"default_generator_profile_revision_id" text,
	"default_instruction_revision_id" text,
	"candidate_count" integer NOT NULL,
	"diversity" text NOT NULL,
	"context_mode" text NOT NULL,
	"include_project_brief" boolean NOT NULL,
	"include_session_brief" boolean NOT NULL,
	"include_target_config" boolean NOT NULL,
	"budget_chars" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payload_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"session_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"context_node_id" text,
	"parent_revision_id" text,
	"feedback" text,
	"operator_instruction" text NOT NULL,
	"generator_profile_revision_id" text NOT NULL,
	"instruction_revision_id" text,
	"technique_revision_ids" jsonb NOT NULL,
	"pipeline_revision_id" text,
	"variables" jsonb NOT NULL,
	"context_options" jsonb NOT NULL,
	"candidate_count" integer NOT NULL,
	"diversity" text NOT NULL,
	"context_snapshot" jsonb NOT NULL,
	"context_hash" text NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	CONSTRAINT "payload_generations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "payload_generations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "payload_generations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payload_generations_session_idx" ON "payload_generations" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "payload_generations_branch_idx" ON "payload_generations" USING btree ("branch_id");
--> statement-breakpoint
CREATE INDEX "payload_generations_status_idx" ON "payload_generations" USING btree ("status");
--> statement-breakpoint
CREATE TABLE "payload_generation_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"backend_snapshot" jsonb NOT NULL,
	"provider_profile_id" text,
	"model_id" text,
	"config_snapshot_id" text,
	"native_thread_id" text,
	"native_turn_id" text,
	"status" text NOT NULL,
	"classification" text,
	"normalized_output" jsonb,
	"usage" jsonb,
	"trace_hash" text,
	"started_at" text,
	"finished_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "payload_generation_attempts_generation_id_payload_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."payload_generations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "payload_attempts_generation_ordinal_uq" UNIQUE("generation_id","ordinal")
);
--> statement-breakpoint
CREATE INDEX "payload_attempts_generation_idx" ON "payload_generation_attempts" USING btree ("generation_id");
--> statement-breakpoint
CREATE TABLE "payload_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"session_id" text NOT NULL,
	"generation_id" text,
	"attempt_id" text,
	"parent_revision_id" text,
	"ordinal" integer NOT NULL,
	"operation" text NOT NULL,
	"text" text NOT NULL,
	"content_hash" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"deleted_at" text,
	CONSTRAINT "payload_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "payload_revisions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "payload_revisions_generation_id_payload_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."payload_generations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "payload_revisions_attempt_id_payload_generation_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payload_generation_attempts"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payload_revisions_session_idx" ON "payload_revisions" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "payload_revisions_generation_idx" ON "payload_revisions" USING btree ("generation_id");
--> statement-breakpoint
CREATE INDEX "payload_revisions_parent_idx" ON "payload_revisions" USING btree ("parent_revision_id");
