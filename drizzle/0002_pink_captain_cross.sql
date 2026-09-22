ALTER TABLE `experiments` ADD `verdict` text;--> statement-breakpoint
ALTER TABLE `learning_findings` ADD `experiment_id` integer REFERENCES experiments(id);--> statement-breakpoint
CREATE INDEX `learning_findings_experiment_idx` ON `learning_findings` (`experiment_id`);