CREATE TABLE `agent_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent` text NOT NULL,
	`provider` text,
	`model` text,
	`operation` text NOT NULL,
	`content_item_id` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`estimated_cost` real,
	`duration_ms` integer,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_runs_created_idx` ON `agent_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `analytics_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_item_id` integer NOT NULL,
	`captured_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`source` text NOT NULL,
	`impressions` integer,
	`reach` integer,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`saves` integer,
	`shares` integer,
	`profile_visits` integer,
	`follows` integer,
	`watch_time_seconds` integer,
	`retention_pct` real,
	`clicks` integer,
	`raw_ocr_text` text,
	`ocr_confidence` real,
	`screenshot_path` text,
	`confirmed_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `analytics_content_idx` ON `analytics_snapshots` (`content_item_id`);--> statement-breakpoint
CREATE INDEX `analytics_captured_idx` ON `analytics_snapshots` (`captured_at`);--> statement-breakpoint
CREATE TABLE `approval_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_item_id` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text,
	`from_state` text NOT NULL,
	`to_state` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `approval_events_content_idx` ON `approval_events` (`content_item_id`);--> statement-breakpoint
CREATE TABLE `brand_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version` integer NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`payload_json` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brand_config_version_idx` ON `brand_config` (`version`);--> statement-breakpoint
CREATE TABLE `briefs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_item_id` integer NOT NULL,
	`prompt_text` text NOT NULL,
	`prompt_template_id` integer,
	`brand_config_id` integer,
	`provider_hint` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prompt_template_id`) REFERENCES `prompt_templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`brand_config_id`) REFERENCES `brand_config`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `briefs_content_idx` ON `briefs` (`content_item_id`);--> statement-breakpoint
CREATE TABLE `claims` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`research_item_id` integer NOT NULL,
	`text` text NOT NULL,
	`claim_type` text NOT NULL,
	`verification_status` text DEFAULT 'UNVERIFIED' NOT NULL,
	`evidence_url` text,
	`evidence_tier` text,
	`verified_at` integer,
	`verified_by` text,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`research_item_id`) REFERENCES `research_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "claims_verified_requires_evidence" CHECK("claims"."verification_status" <> 'VERIFIED' OR ("claims"."evidence_url" IS NOT NULL AND "claims"."evidence_tier" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `claims_research_item_idx` ON `claims` (`research_item_id`);--> statement-breakpoint
CREATE INDEX `claims_verification_idx` ON `claims` (`verification_status`);--> statement-breakpoint
CREATE TABLE `content_experiments` (
	`content_item_id` integer NOT NULL,
	`experiment_id` integer NOT NULL,
	`variant` text NOT NULL,
	PRIMARY KEY(`content_item_id`, `experiment_id`),
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `content_item_sources` (
	`content_item_id` integer NOT NULL,
	`claim_id` integer NOT NULL,
	PRIMARY KEY(`content_item_id`, `claim_id`),
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `content_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`opportunity_id` integer,
	`platform` text NOT NULL,
	`format` text NOT NULL,
	`language` text DEFAULT 'EN' NOT NULL,
	`pillar_id` integer,
	`topic` text,
	`character_mode` text DEFAULT 'HUMAN' NOT NULL,
	`state` text DEFAULT 'IDEA' NOT NULL,
	`hook` text,
	`body` text,
	`caption` text,
	`cta` text,
	`hashtags` text,
	`alt_text` text,
	`scheduled_at` integer,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`opportunity_id`) REFERENCES `content_opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pillar_id`) REFERENCES `content_pillars`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `content_items_state_idx` ON `content_items` (`state`);--> statement-breakpoint
CREATE INDEX `content_items_platform_idx` ON `content_items` (`platform`);--> statement-breakpoint
CREATE INDEX `content_items_scheduled_idx` ON `content_items` (`scheduled_at`);--> statement-breakpoint
CREATE INDEX `content_items_opportunity_idx` ON `content_items` (`opportunity_id`);--> statement-breakpoint
CREATE TABLE `content_opportunities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`thesis` text,
	`angle` text,
	`pillar_id` integer,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`window_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`pillar_id`) REFERENCES `content_pillars`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `opportunities_status_idx` ON `content_opportunities` (`status`);--> statement-breakpoint
CREATE INDEX `opportunities_priority_idx` ON `content_opportunities` (`priority`);--> statement-breakpoint
CREATE TABLE `content_pillars` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_pillars_slug_idx` ON `content_pillars` (`slug`);--> statement-breakpoint
CREATE TABLE `cost_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_run_id` integer,
	`category` text NOT NULL,
	`amount` real NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`incurred_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cost_records_incurred_idx` ON `cost_records` (`incurred_at`);--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`hypothesis` text NOT NULL,
	`metric` text NOT NULL,
	`variant_definition` text NOT NULL,
	`min_sample_size` integer NOT NULL,
	`start_at` integer,
	`end_at` integer,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`result` text,
	`confidence` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `experiments_status_idx` ON `experiments` (`status`);--> statement-breakpoint
CREATE TABLE `generations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brief_id` integer NOT NULL,
	`content_item_id` integer NOT NULL,
	`mode` text NOT NULL,
	`provider` text,
	`model` text,
	`raw_response` text NOT NULL,
	`parsed_ok` integer DEFAULT false NOT NULL,
	`parse_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`brief_id`) REFERENCES `briefs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `generations_content_idx` ON `generations` (`content_item_id`);--> statement-breakpoint
CREATE TABLE `learning_findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dimension` text NOT NULL,
	`segment` text NOT NULL,
	`metric` text NOT NULL,
	`effect_size` real,
	`sample_size` integer NOT NULL,
	`confidence` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`computed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `learning_findings_dimension_idx` ON `learning_findings` (`dimension`,`segment`);--> statement-breakpoint
CREATE INDEX `learning_findings_status_idx` ON `learning_findings` (`status`);--> statement-breakpoint
CREATE TABLE `media_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_item_id` integer,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`width` integer,
	`height` integer,
	`checksum` text,
	`generated_by` text,
	`prompt_id` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompt_templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `media_assets_content_idx` ON `media_assets` (`content_item_id`);--> statement-breakpoint
CREATE TABLE `opportunity_research` (
	`opportunity_id` integer NOT NULL,
	`research_item_id` integer NOT NULL,
	PRIMARY KEY(`opportunity_id`, `research_item_id`),
	FOREIGN KEY (`opportunity_id`) REFERENCES `content_opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`research_item_id`) REFERENCES `research_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `prompt_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_templates_key_version_idx` ON `prompt_templates` (`key`,`version`);--> statement-breakpoint
CREATE TABLE `publication_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_item_id` integer NOT NULL,
	`job_id` integer,
	`platform` text NOT NULL,
	`publisher_kind` text NOT NULL,
	`external_id` text,
	`external_url` text,
	`confirmed_by` text,
	`published_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `schedule_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "publication_records_require_evidence" CHECK("publication_records"."external_id" IS NOT NULL OR "publication_records"."confirmed_by" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_records_item_platform_idx` ON `publication_records` (`content_item_id`,`platform`);--> statement-breakpoint
CREATE TABLE `research_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`url` text NOT NULL,
	`published_at` integer,
	`discovered_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`content_hash` text,
	`dedupe_key` text NOT NULL,
	`duplicate_of_id` integer,
	`relevance_score` real,
	`importance` integer,
	`verification_status` text DEFAULT 'UNVERIFIED' NOT NULL,
	`verified_at` integer,
	`status` text DEFAULT 'NEW' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_items_url_idx` ON `research_items` (`url`);--> statement-breakpoint
CREATE INDEX `research_items_dedupe_idx` ON `research_items` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `research_items_status_idx` ON `research_items` (`status`);--> statement-breakpoint
CREATE INDEX `research_items_discovered_idx` ON `research_items` (`discovered_at`);--> statement-breakpoint
CREATE TABLE `schedule_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_item_id` integer NOT NULL,
	`run_at` integer NOT NULL,
	`timezone` text DEFAULT 'Asia/Kolkata' NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`grace_window_minutes` integer DEFAULT 30 NOT NULL,
	`idempotency_key` text NOT NULL,
	`locked_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_jobs_idempotency_idx` ON `schedule_jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `schedule_jobs_due_idx` ON `schedule_jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`fetcher` text NOT NULL,
	`url` text NOT NULL,
	`feed_url` text,
	`credibility_tier` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`poll_interval_minutes` integer DEFAULT 60 NOT NULL,
	`last_polled_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_url_idx` ON `sources` (`url`);--> statement-breakpoint
CREATE INDEX `sources_enabled_idx` ON `sources` (`enabled`);--> statement-breakpoint
CREATE TABLE `system_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`severity` text DEFAULT 'INFO' NOT NULL,
	`payload` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `system_events_created_idx` ON `system_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `system_events_severity_idx` ON `system_events` (`severity`);