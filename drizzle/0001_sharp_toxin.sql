CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`severity` text DEFAULT 'INFO' NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`content_item_id` integer,
	`dedupe_key` text,
	`read_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_read_idx` ON `notifications` (`read_at`);--> statement-breakpoint
CREATE INDEX `notifications_created_idx` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_idx` ON `notifications` (`dedupe_key`);