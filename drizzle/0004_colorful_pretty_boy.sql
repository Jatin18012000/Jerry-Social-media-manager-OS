CREATE TABLE `research_item_pillars` (
	`research_item_id` integer NOT NULL,
	`pillar_id` integer NOT NULL,
	`assigned_by` text NOT NULL,
	`assigned_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`research_item_id`, `pillar_id`),
	FOREIGN KEY (`research_item_id`) REFERENCES `research_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pillar_id`) REFERENCES `content_pillars`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `research_items` ADD `primary_pillar_id` integer REFERENCES content_pillars(id);--> statement-breakpoint
CREATE INDEX `research_items_pillar_idx` ON `research_items` (`primary_pillar_id`);