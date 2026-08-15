ALTER TABLE `checkpoints` ADD `provider_profile_id` text;
--> statement-breakpoint
ALTER TABLE `checkpoints` ADD `model_id` text;
--> statement-breakpoint
ALTER TABLE `checkpoints` ADD `auto_continue_tools` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `checkpoints` ADD `auto_continue_limit` integer NOT NULL DEFAULT 8;
--> statement-breakpoint
ALTER TABLE `checkpoints` ADD `session_state_captured` integer NOT NULL DEFAULT 0;
