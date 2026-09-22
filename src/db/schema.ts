/**
 * Database schema — PRD §37.
 *
 * SQLite via Drizzle. The same definitions target Postgres, so the §64
 * FOUNDATION -> PRODUCTION move is a migration concern rather than a rewrite.
 *
 * Conventions:
 *   - Timestamps are stored as integer epoch milliseconds (SQLite has no
 *     native date type; integers sort and compare correctly).
 *   - Enum-ish columns are TEXT with a TypeScript union via $type<>(), plus a
 *     CHECK constraint where the value set is closed. TypeScript guards the
 *     application; the CHECK guards the database.
 *   - Metric columns are nullable by design. §26 says availability depends on
 *     the platform and §40 forbids fabricated metrics, so "not reported" is
 *     NULL and never 0.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import type {
  ClaimType,
  EvidenceTier,
  VerificationStatus,
} from '@/domain/evidence';
import type { ContentAction, ContentState } from '@/domain/content-state';
import type {
  CharacterMode,
  ContentFormat,
  Language,
  Platform,
} from '@/domain/content';

const now = sql`(unixepoch() * 1000)`;

const timestamps = {
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
};

// ---------------------------------------------------------------------------
// Brand & configuration (§8, §19, §20)
// ---------------------------------------------------------------------------

/**
 * Versioned brand configuration: voice, character specification, design
 * system. §20 requires that these are centralised rather than rewritten by
 * hand each time; versioning them makes a change in voice attributable when
 * the learning engine later looks for what changed.
 *
 * Content of the payload is owned by Jatin and ChatGPT (§4); this table only
 * stores and versions it.
 */
export const brandConfig = sqliteTable(
  'brand_config',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    version: integer('version').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(false),
    payloadJson: text('payload_json').notNull(),
    note: text('note'),
    ...timestamps,
  },
  (t) => [uniqueIndex('brand_config_version_idx').on(t.version)],
);

/** Versioned prompt templates — §57 Risk 5 mitigation ("versioned prompts"). */
export const promptTemplates = sqliteTable(
  'prompt_templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex('prompt_templates_key_version_idx').on(t.key, t.version)],
);

/** Content pillars (§10). Rows, not constants — §10 allows new pillars. */
export const contentPillars = sqliteTable(
  'content_pillars',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('content_pillars_slug_idx').on(t.slug)],
);

// ---------------------------------------------------------------------------
// Research (§14, §15, §16)
// ---------------------------------------------------------------------------

export type SourceType =
  | 'OFFICIAL_BLOG'
  | 'RESEARCH'
  | 'PUBLICATION'
  | 'JOB_MARKET'
  | 'COMMUNITY'
  | 'TOOL_REGISTRY'
  | 'MANUAL';

export type FetcherKind = 'RSS' | 'ATOM' | 'ARXIV' | 'HACKER_NEWS' | 'MANUAL';

/** §14: "The exact source list must be configurable." Hence a table. */
export const sources = sqliteTable(
  'sources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    type: text('type').$type<SourceType>().notNull(),
    fetcher: text('fetcher').$type<FetcherKind>().notNull(),
    url: text('url').notNull(),
    feedUrl: text('feed_url'),
    /** Default evidence tier for items from this source (§7.2). */
    credibilityTier: text('credibility_tier').$type<EvidenceTier>().notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    pollIntervalMinutes: integer('poll_interval_minutes')
      .notNull()
      .default(60),
    lastPolledAt: integer('last_polled_at'),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('sources_url_idx').on(t.url),
    index('sources_enabled_idx').on(t.enabled),
  ],
);

export type ResearchItemStatus =
  | 'NEW'
  | 'TRIAGED'
  | 'PROMOTED'
  | 'DISCARDED'
  | 'DUPLICATE';

/** §15: the research record. */
export const researchItems = sqliteTable(
  'research_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: integer('source_id')
      .notNull()
      .references(() => sources.id),
    title: text('title').notNull(),
    summary: text('summary'),
    url: text('url').notNull(),
    publishedAt: integer('published_at'),
    discoveredAt: integer('discovered_at').notNull().default(now),

    /** Hash of fetched content, for change detection. */
    contentHash: text('content_hash'),
    /** Normalised key used to collapse the same story from many sources. */
    dedupeKey: text('dedupe_key').notNull(),
    duplicateOfId: integer('duplicate_of_id'),

    relevanceScore: real('relevance_score'),
    importance: integer('importance'),

    verificationStatus: text('verification_status')
      .$type<VerificationStatus>()
      .notNull()
      .default('UNVERIFIED'),
    verifiedAt: integer('verified_at'),
    status: text('status')
      .$type<ResearchItemStatus>()
      .notNull()
      .default('NEW'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('research_items_url_idx').on(t.url),
    index('research_items_dedupe_idx').on(t.dedupeKey),
    index('research_items_status_idx').on(t.status),
    index('research_items_discovered_idx').on(t.discoveredAt),
  ],
);

/**
 * §16: source provenance, at claim granularity.
 *
 * Content links to claims, not to articles. This is what makes "every
 * published post resting on an unverified claim" a single query, which is the
 * system's main defence against §57 Risk 2 (research errors).
 */
export const claims = sqliteTable(
  'claims',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    researchItemId: integer('research_item_id')
      .notNull()
      .references(() => researchItems.id),
    text: text('text').notNull(),
    claimType: text('claim_type').$type<ClaimType>().notNull(),
    verificationStatus: text('verification_status')
      .$type<VerificationStatus>()
      .notNull()
      .default('UNVERIFIED'),
    evidenceUrl: text('evidence_url'),
    evidenceTier: text('evidence_tier').$type<EvidenceTier>(),
    verifiedAt: integer('verified_at'),
    verifiedBy: text('verified_by'),
    note: text('note'),
    ...timestamps,
  },
  (t) => [
    index('claims_research_item_idx').on(t.researchItemId),
    index('claims_verification_idx').on(t.verificationStatus),
    // A verified claim must say what evidence verified it (§7.2).
    check(
      'claims_verified_requires_evidence',
      sql`${t.verificationStatus} <> 'VERIFIED' OR (${t.evidenceUrl} IS NOT NULL AND ${t.evidenceTier} IS NOT NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Opportunities & content (§12, §17)
// ---------------------------------------------------------------------------

export type OpportunityStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'EXHAUSTED'
  | 'EXPIRED'
  | 'DISCARDED';

/** §12: the fundamental unit is the Content Opportunity, not the post. */
export const contentOpportunities = sqliteTable(
  'content_opportunities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    thesis: text('thesis'),
    angle: text('angle'),
    pillarId: integer('pillar_id').references(() => contentPillars.id),
    priority: integer('priority').notNull().default(0),
    status: text('status')
      .$type<OpportunityStatus>()
      .notNull()
      .default('OPEN'),
    /** AI news decays; a stale opportunity should say so rather than linger. */
    windowExpiresAt: integer('window_expires_at'),
    ...timestamps,
  },
  (t) => [
    index('opportunities_status_idx').on(t.status),
    index('opportunities_priority_idx').on(t.priority),
  ],
);

export const opportunityResearch = sqliteTable(
  'opportunity_research',
  {
    opportunityId: integer('opportunity_id')
      .notNull()
      .references(() => contentOpportunities.id),
    researchItemId: integer('research_item_id')
      .notNull()
      .references(() => researchItems.id),
  },
  (t) => [primaryKey({ columns: [t.opportunityId, t.researchItemId] })],
);

/** §17: the content item. */
export const contentItems = sqliteTable(
  'content_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    opportunityId: integer('opportunity_id').references(
      () => contentOpportunities.id,
    ),
    platform: text('platform').$type<Platform>().notNull(),
    format: text('format').$type<ContentFormat>().notNull(),
    language: text('language').$type<Language>().notNull().default('EN'),
    pillarId: integer('pillar_id').references(() => contentPillars.id),
    topic: text('topic'),
    characterMode: text('character_mode')
      .$type<CharacterMode>()
      .notNull()
      .default('HUMAN'),

    /** State is owned by src/domain/content-state.ts. Never set ad hoc. */
    state: text('state').$type<ContentState>().notNull().default('IDEA'),

    hook: text('hook'),
    body: text('body'),
    caption: text('caption'),
    cta: text('cta'),
    hashtags: text('hashtags'),
    altText: text('alt_text'),

    scheduledAt: integer('scheduled_at'),
    publishedAt: integer('published_at'),
    ...timestamps,
  },
  (t) => [
    index('content_items_state_idx').on(t.state),
    index('content_items_platform_idx').on(t.platform),
    index('content_items_scheduled_idx').on(t.scheduledAt),
    index('content_items_opportunity_idx').on(t.opportunityId),
  ],
);

/** §16: which claims this content rests on. The provenance join. */
export const contentItemSources = sqliteTable(
  'content_item_sources',
  {
    contentItemId: integer('content_item_id')
      .notNull()
      .references(() => contentItems.id),
    claimId: integer('claim_id')
      .notNull()
      .references(() => claims.id),
  },
  (t) => [primaryKey({ columns: [t.contentItemId, t.claimId] })],
);

export type MediaKind = 'IMAGE' | 'VIDEO' | 'CAROUSEL_SLIDE' | 'THUMBNAIL';

export const mediaAssets = sqliteTable(
  'media_assets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    contentItemId: integer('content_item_id').references(() => contentItems.id),
    kind: text('kind').$type<MediaKind>().notNull(),
    /** Path on disk. Media lives outside the repo and outside the DB (§34). */
    path: text('path').notNull(),
    width: integer('width'),
    height: integer('height'),
    checksum: text('checksum'),
    generatedBy: text('generated_by'),
    promptId: integer('prompt_id').references(() => promptTemplates.id),
    ...timestamps,
  },
  (t) => [index('media_assets_content_idx').on(t.contentItemId)],
);

// ---------------------------------------------------------------------------
// Generation (§17 creation, and the D3 human-in-the-loop loop)
// ---------------------------------------------------------------------------

/** The brief handed to a human or a model. */
export const briefs = sqliteTable(
  'briefs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    contentItemId: integer('content_item_id')
      .notNull()
      .references(() => contentItems.id),
    promptText: text('prompt_text').notNull(),
    promptTemplateId: integer('prompt_template_id').references(
      () => promptTemplates.id,
    ),
    brandConfigId: integer('brand_config_id').references(() => brandConfig.id),
    providerHint: text('provider_hint'),
    ...timestamps,
  },
  (t) => [index('briefs_content_idx').on(t.contentItemId)],
);

export type GenerationMode = 'MANUAL' | 'API' | 'LOCAL';

/**
 * A response to a brief.
 *
 * `rawResponse` is persisted *before* parsing is attempted. Under D3 the
 * scarcest resource in the system is Jatin's manual generation effort, and it
 * must never be lost to a parser bug. A failed parse can be re-parsed later.
 */
export const generations = sqliteTable(
  'generations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    briefId: integer('brief_id')
      .notNull()
      .references(() => briefs.id),
    contentItemId: integer('content_item_id')
      .notNull()
      .references(() => contentItems.id),
    mode: text('mode').$type<GenerationMode>().notNull(),
    provider: text('provider'),
    model: text('model'),
    rawResponse: text('raw_response').notNull(),
    parsedOk: integer('parsed_ok', { mode: 'boolean' })
      .notNull()
      .default(false),
    parseError: text('parse_error'),
    ...timestamps,
  },
  (t) => [index('generations_content_idx').on(t.contentItemId)],
);

// ---------------------------------------------------------------------------
// Approval, scheduling, publishing (§22, §23, §24, §39)
// ---------------------------------------------------------------------------

/**
 * Every state change, without exception. §41 audit log, §43 observability.
 * Written in the same transaction as the state change it describes.
 */
export const approvalEvents = sqliteTable(
  'approval_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    contentItemId: integer('content_item_id')
      .notNull()
      .references(() => contentItems.id),
    actor: text('actor').notNull(),
    action: text('action').$type<ContentAction>(),
    fromState: text('from_state').$type<ContentState>().notNull(),
    toState: text('to_state').$type<ContentState>().notNull(),
    note: text('note'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('approval_events_content_idx').on(t.contentItemId)],
);

export type JobStatus =
  | 'PENDING'
  | 'RUNNING'
  /** Manual publisher has handed the work to a person; §40 forbids calling
   *  this published until they confirm they actually posted it. */
  | 'AWAITING_HUMAN'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'MISSED'
  | 'CANCELLED';

/**
 * §24 scheduler, §39 idempotency.
 *
 * MISSED exists because of decision D2: the machine is a MacBook and will be
 * asleep at some scheduled times. On wake, a job overdue beyond its grace
 * window is marked MISSED and surfaced for a human decision rather than fired
 * blindly — publishing a 9am post at 4pm is usually worse than not publishing.
 */
export const scheduleJobs = sqliteTable(
  'schedule_jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    contentItemId: integer('content_item_id')
      .notNull()
      .references(() => contentItems.id),
    runAt: integer('run_at').notNull(),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    status: text('status').$type<JobStatus>().notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    graceWindowMinutes: integer('grace_window_minutes').notNull().default(30),
    /** hash(contentItemId, platform, runAt). First line of §39 defence. */
    idempotencyKey: text('idempotency_key').notNull(),
    lockedAt: integer('locked_at'),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('schedule_jobs_idempotency_idx').on(t.idempotencyKey),
    index('schedule_jobs_due_idx').on(t.status, t.runAt),
  ],
);

export type PublisherKind = 'MANUAL' | 'INSTAGRAM_API' | 'LINKEDIN_API';

/**
 * §39: "Every external publication should have a unique internal publication
 * job ID and external platform ID where available."
 *
 * The UNIQUE(content_item_id, platform) index is a database-level guarantee
 * against double publishing that survives any application bug.
 */
export const publicationRecords = sqliteTable(
  'publication_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    contentItemId: integer('content_item_id')
      .notNull()
      .references(() => contentItems.id),
    jobId: integer('job_id').references(() => scheduleJobs.id),
    platform: text('platform').$type<Platform>().notNull(),
    publisherKind: text('publisher_kind').$type<PublisherKind>().notNull(),
    /** Platform's own ID. NULL for a manual publish. */
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    /** Set when a human confirms a manual publish actually happened. */
    confirmedBy: text('confirmed_by'),
    publishedAt: integer('published_at').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('publication_records_item_platform_idx').on(
      t.contentItemId,
      t.platform,
    ),
    // §40: a publication record must carry evidence — an external ID from the
    // platform, or an explicit human confirmation. Never neither.
    check(
      'publication_records_require_evidence',
      sql`${t.externalId} IS NOT NULL OR ${t.confirmedBy} IS NOT NULL`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Analytics & learning (§26, §27, §28, §29, §30)
// ---------------------------------------------------------------------------

export type AnalyticsSourceKind = 'OCR' | 'MANUAL' | 'API';

/**
 * §26. Append-only snapshots, not mutable columns: metrics move for days
 * after publishing and §29's pattern analysis needs the time series.
 *
 * Every metric is nullable. §26 says availability depends on the platform and
 * §40 forbids fabricating metrics, so "not reported" is NULL, never 0.
 */
export const analyticsSnapshots = sqliteTable(
  'analytics_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    contentItemId: integer('content_item_id')
      .notNull()
      .references(() => contentItems.id),
    capturedAt: integer('captured_at').notNull().default(now),
    source: text('source').$type<AnalyticsSourceKind>().notNull(),

    impressions: integer('impressions'),
    reach: integer('reach'),
    views: integer('views'),
    likes: integer('likes'),
    comments: integer('comments'),
    saves: integer('saves'),
    shares: integer('shares'),
    profileVisits: integer('profile_visits'),
    follows: integer('follows'),
    watchTimeSeconds: integer('watch_time_seconds'),
    retentionPct: real('retention_pct'),
    clicks: integer('clicks'),

    /** Retained so a parser improvement can re-run over old screenshots. */
    rawOcrText: text('raw_ocr_text'),
    ocrConfidence: real('ocr_confidence'),
    screenshotPath: text('screenshot_path'),
    confirmedBy: text('confirmed_by'),
    ...timestamps,
  },
  (t) => [
    index('analytics_content_idx').on(t.contentItemId),
    index('analytics_captured_idx').on(t.capturedAt),
  ],
);

/** §30. A null result is a result, so all three are recorded. */
export type Verdict = 'SUPPORTED' | 'REFUTED' | 'INCONCLUSIVE';

export type ExperimentStatus =
  | 'DRAFT'
  | 'RUNNING'
  | 'CONCLUDED'
  | 'ABANDONED';

/**
 * §30. min_sample_size and the metric are fixed before the test runs, so a
 * result cannot be reinterpreted after the fact.
 */
export const experiments = sqliteTable(
  'experiments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    hypothesis: text('hypothesis').notNull(),
    metric: text('metric').notNull(),
    variantDefinition: text('variant_definition').notNull(),
    minSampleSize: integer('min_sample_size').notNull(),
    startAt: integer('start_at'),
    endAt: integer('end_at'),
    status: text('status').$type<ExperimentStatus>().notNull().default('DRAFT'),
    /**
     * §30. Queryable so a REFUTED or INCONCLUSIVE experiment is as findable
     * as a successful one. An OS that can only surface its own confirmations
     * is a machine for confirming them.
     */
    verdict: text('verdict').$type<Verdict>(),
    result: text('result'),
    confidence: text('confidence'),
    ...timestamps,
  },
  (t) => [index('experiments_status_idx').on(t.status)],
);

export const contentExperiments = sqliteTable(
  'content_experiments',
  {
    contentItemId: integer('content_item_id')
      .notNull()
      .references(() => contentItems.id),
    experimentId: integer('experiment_id')
      .notNull()
      .references(() => experiments.id),
    variant: text('variant').notNull(),
  },
  (t) => [primaryKey({ columns: [t.contentItemId, t.experimentId] })],
);

export type FindingStatus =
  | 'INSUFFICIENT_DATA'
  | 'OBSERVATION'
  | 'HYPOTHESIS'
  | 'SUPPORTED';

/**
 * §29. Every finding carries effect size, sample size and confidence, and a
 * status that distinguishes observation from conclusion.
 *
 * A finding below its dimension's minimum sample size is INSUFFICIENT_DATA and
 * is never rendered as a conclusion anywhere. This is the direct
 * implementation of "must not claim Hinglish causes growth from three posts".
 */
export const learningFindings = sqliteTable(
  'learning_findings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** One of the §28 dimensions: topic, pillar, format, language, hook, ... */
    dimension: text('dimension').notNull(),
    segment: text('segment').notNull(),
    metric: text('metric').notNull(),
    effectSize: real('effect_size'),
    sampleSize: integer('sample_size').notNull(),
    confidence: text('confidence').notNull(),
    status: text('status').$type<FindingStatus>().notNull(),
    summary: text('summary').notNull(),
    computedAt: integer('computed_at').notNull().default(now),
    /**
     * Set when this finding was earned by a concluded experiment (§30).
     *
     * Load-bearing, not decorative. Recomputing observational findings
     * replaces the whole set for a metric, and without this column that
     * delete would silently destroy every SUPPORTED result the moment new
     * analytics arrived — the one status that costs an experiment to obtain.
     */
    experimentId: integer('experiment_id').references(() => experiments.id),
    ...timestamps,
  },
  (t) => [
    index('learning_findings_dimension_idx').on(t.dimension, t.segment),
    index('learning_findings_status_idx').on(t.status),
    index('learning_findings_experiment_idx').on(t.experimentId),
  ],
);

// ---------------------------------------------------------------------------
// Observability & cost (§43, §44)
// ---------------------------------------------------------------------------

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agent: text('agent').notNull(),
    provider: text('provider'),
    model: text('model'),
    operation: text('operation').notNull(),
    contentItemId: integer('content_item_id').references(() => contentItems.id),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    estimatedCost: real('estimated_cost'),
    durationMs: integer('duration_ms'),
    status: text('status').notNull(),
    error: text('error'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('agent_runs_created_idx').on(t.createdAt)],
);

export const costRecords = sqliteTable(
  'cost_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agentRunId: integer('agent_run_id').references(() => agentRuns.id),
    category: text('category').notNull(),
    amount: real('amount').notNull(),
    currency: text('currency').notNull().default('USD'),
    incurredAt: integer('incurred_at').notNull().default(now),
  },
  (t) => [index('cost_records_incurred_idx').on(t.incurredAt)],
);

/**
 * Notifications — §47.
 *
 * Distinct from system_events, which logs everything that happened for
 * observability (§43). A notification is *addressed to a person* and carries
 * read state, so the two answer different questions: "what did the system do"
 * versus "what still needs me".
 *
 * §48: email is a channel for these, never the database or the orchestration
 * mechanism. The database row is the notification; a channel may later deliver
 * it.
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(),
    severity: text('severity').$type<EventSeverity>().notNull().default('INFO'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    contentItemId: integer('content_item_id').references(() => contentItems.id),
    /** Collapses repeats of the same thing; see the notifier adapter. */
    dedupeKey: text('dedupe_key'),
    readAt: integer('read_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('notifications_read_idx').on(t.readAt),
    index('notifications_created_idx').on(t.createdAt),
    uniqueIndex('notifications_dedupe_idx').on(t.dedupeKey),
  ],
);

export type EventSeverity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export const systemEvents = sqliteTable(
  'system_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(),
    severity: text('severity').$type<EventSeverity>().notNull().default('INFO'),
    payload: text('payload'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('system_events_created_idx').on(t.createdAt),
    index('system_events_severity_idx').on(t.severity),
  ],
);
