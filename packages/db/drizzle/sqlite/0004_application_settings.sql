CREATE TABLE `application_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`redaction_enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
