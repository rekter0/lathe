CREATE TABLE "session_payload_workbench_settings" (
	"session_id" text PRIMARY KEY NOT NULL,
	"generator_profile_revision_id" text,
	"instruction_revision_id" text,
	"technique_revision_ids" jsonb NOT NULL,
	"pipeline_revision_id" text,
	"operator_instruction" text NOT NULL,
	"variables" jsonb NOT NULL,
	"candidate_count" integer NOT NULL,
	"diversity" text NOT NULL,
	"context_mode" text NOT NULL,
	"include_project_brief" boolean NOT NULL,
	"include_session_brief" boolean NOT NULL,
	"include_target_config" boolean NOT NULL,
	"budget_chars" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "session_payload_workbench_settings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action
);
