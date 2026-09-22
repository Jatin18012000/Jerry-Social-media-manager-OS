ALTER TABLE `research_items` ADD `pillar_id` integer REFERENCES content_pillars(id);--> statement-breakpoint
ALTER TABLE `research_items` ADD `language` text;--> statement-breakpoint
CREATE INDEX `research_items_pillar_idx` ON `research_items` (`pillar_id`);