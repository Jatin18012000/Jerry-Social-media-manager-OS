ALTER TABLE `brand_config` ADD `is_placeholder` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `brand_config` ADD `activated_by` text;--> statement-breakpoint
ALTER TABLE `brand_config` ADD `activated_at` integer;