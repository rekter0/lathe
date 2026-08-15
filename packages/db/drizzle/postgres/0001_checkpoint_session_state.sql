ALTER TABLE "checkpoints" ADD COLUMN "provider_profile_id" text;
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "model_id" text;
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "auto_continue_tools" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "auto_continue_limit" integer DEFAULT 8 NOT NULL;
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "session_state_captured" boolean DEFAULT false NOT NULL;
