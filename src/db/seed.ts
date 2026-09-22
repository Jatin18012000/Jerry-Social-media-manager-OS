/**
 * Seed data — PRD §10 (content pillars) and §14 (research sources).
 *
 * §14 requires the source list to be configurable, so this is a starting set
 * rather than a fixed one: every entry is a row that can be edited, disabled
 * or removed without touching code.
 *
 * Feed URLs are best-effort and unverified from this environment. A feed that
 * 404s will record `last_error` against its source row and show up as broken
 * in the dashboard rather than failing silently (§40) — which is the intended
 * way to discover that one has moved.
 *
 * Run with: npm run db:seed
 */

import { eq } from 'drizzle-orm';

import { createDb } from './client';
import { contentPillars, sources } from './schema';
import type { EvidenceTier } from '@/domain/evidence';
import type { FetcherKind, SourceType } from './schema';

/** §10. `description` carries the relevance keywords (see ingest.ts). */
const PILLARS = [
  {
    slug: 'ai-news',
    name: 'AI News & Updates',
    description:
      'released, launches, launch, announces, announced, unveils, model release, now available, general availability, rollout, update, deprecated',
  },
  {
    slug: 'ai-research',
    name: 'AI Research',
    description:
      'paper, arxiv, preprint, benchmark, state of the art, ablation, research, study, findings, evaluation, dataset',
  },
  {
    slug: 'ai-careers',
    name: 'AI Careers',
    description:
      'jobs, hiring, career, careers, salary, salaries, roles, skills, layoffs, recruiting, interview, job market, upskilling',
  },
  {
    slug: 'practical-ai',
    name: 'Practical AI',
    description:
      'workflow, tutorial, how to, guide, productivity, automation, prompt, integration, use case, tool, tips',
  },
] as const;

interface SeedSource {
  readonly name: string;
  readonly type: SourceType;
  readonly fetcher: FetcherKind;
  readonly url: string;
  readonly feedUrl?: string;
  readonly credibilityTier: EvidenceTier;
  readonly pollIntervalMinutes?: number;
}

/**
 * Credibility tiers follow §7.2 strictly: a company's own announcement of its
 * own product is a PRIMARY source for *that announcement*. A publication
 * reporting on it is CREDIBLE_SECONDARY however good the publication is.
 */
export const SOURCES: readonly SeedSource[] = [
  // --- Official company blogs: primary for their own announcements ---
  {
    name: 'OpenAI Blog',
    type: 'OFFICIAL_BLOG',
    fetcher: 'RSS',
    url: 'https://openai.com/news/',
    feedUrl: 'https://openai.com/news/rss.xml',
    credibilityTier: 'PRIMARY',
  },
  {
    name: 'Anthropic News',
    type: 'OFFICIAL_BLOG',
    fetcher: 'RSS',
    url: 'https://www.anthropic.com/news',
    feedUrl: 'https://www.anthropic.com/rss.xml',
    credibilityTier: 'PRIMARY',
  },
  {
    name: 'Google DeepMind Blog',
    type: 'OFFICIAL_BLOG',
    fetcher: 'RSS',
    url: 'https://deepmind.google/discover/blog/',
    feedUrl: 'https://deepmind.google/blog/rss.xml',
    credibilityTier: 'PRIMARY',
  },
  {
    name: 'Hugging Face Blog',
    type: 'OFFICIAL_BLOG',
    fetcher: 'RSS',
    url: 'https://huggingface.co/blog',
    feedUrl: 'https://huggingface.co/blog/feed.xml',
    credibilityTier: 'PRIMARY',
  },
  {
    name: 'Meta AI Blog',
    type: 'OFFICIAL_BLOG',
    fetcher: 'RSS',
    url: 'https://ai.meta.com/blog/',
    feedUrl: 'https://ai.meta.com/blog/rss/',
    credibilityTier: 'PRIMARY',
  },

  // --- Research ---
  {
    name: 'arXiv cs.AI / cs.CL / cs.LG / cs.CV',
    type: 'RESEARCH',
    fetcher: 'ARXIV',
    // Empty query URL means "use the fetcher's default categories".
    url: 'arxiv:default',
    credibilityTier: 'ORIGINAL_RESEARCH',
    pollIntervalMinutes: 360,
  },

  // --- Community signal ---
  {
    name: 'Hacker News (AI, 100+ points)',
    type: 'COMMUNITY',
    fetcher: 'HACKER_NEWS',
    url: 'hn:default',
    // A link's authority comes from where it points, never from HN itself.
    credibilityTier: 'OTHER',
    pollIntervalMinutes: 120,
  },

  // --- Publications: credible, but reporting rather than primary ---
  {
    name: 'TechCrunch AI',
    type: 'PUBLICATION',
    fetcher: 'RSS',
    url: 'https://techcrunch.com/category/artificial-intelligence/',
    feedUrl: 'https://techcrunch.com/category/artificial-intelligence/feed/',
    credibilityTier: 'CREDIBLE_SECONDARY',
  },
  {
    name: 'The Verge AI',
    type: 'PUBLICATION',
    fetcher: 'RSS',
    url: 'https://www.theverge.com/ai-artificial-intelligence',
    feedUrl: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    credibilityTier: 'CREDIBLE_SECONDARY',
  },
  {
    name: 'MIT Technology Review — AI',
    type: 'PUBLICATION',
    fetcher: 'RSS',
    url: 'https://www.technologyreview.com/topic/artificial-intelligence/',
    feedUrl: 'https://www.technologyreview.com/topic/artificial-intelligence/feed',
    credibilityTier: 'CREDIBLE_SECONDARY',
  },
];

/**
 * URLs of the sources this file seeds, plus the lazily-created manual bucket.
 *
 * Exported so `db:clean` can tell a seeded §14 source from one a demo run
 * invented, without hardcoding row ids — which shift the moment anything is
 * inserted or deleted.
 */
export const SEED_SOURCE_URLS: readonly string[] = [
  ...SOURCES.map((s) => s.url),
  // Created on demand by the manual-URL path (D5), not by this file, but it
  // is infrastructure rather than demo data.
  'about:manual',
];

export function seed(databaseUrl = process.env.DATABASE_URL ?? './data/os.db') {
  const db = createDb(databaseUrl);

  let pillarsAdded = 0;
  for (const pillar of PILLARS) {
    const existing = db
      .select({ id: contentPillars.id })
      .from(contentPillars)
      .where(eq(contentPillars.slug, pillar.slug))
      .get();

    if (existing) {
      // Keep keyword terms current without clobbering an edited name.
      db.update(contentPillars)
        .set({ description: pillar.description })
        .where(eq(contentPillars.id, existing.id))
        .run();
      continue;
    }

    db.insert(contentPillars)
      .values({
        slug: pillar.slug,
        name: pillar.name,
        description: pillar.description,
      })
      .run();
    pillarsAdded += 1;
  }

  let sourcesAdded = 0;
  for (const source of SOURCES) {
    const existing = db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.url, source.url))
      .get();

    // Never overwrite an existing source row: §14 makes these user-editable,
    // and re-seeding must not undo a deliberate change.
    if (existing) continue;

    db.insert(sources)
      .values({
        name: source.name,
        type: source.type,
        fetcher: source.fetcher,
        url: source.url,
        feedUrl: source.feedUrl ?? null,
        credibilityTier: source.credibilityTier,
        pollIntervalMinutes: source.pollIntervalMinutes ?? 60,
      })
      .run();
    sourcesAdded += 1;
  }

  return { pillarsAdded, sourcesAdded };
}

// Executed directly via `npm run db:seed`.
if (process.argv[1]?.includes('seed')) {
  const result = seed();
  console.log(
    `Seed complete: ${result.pillarsAdded} pillars added, ` +
      `${result.sourcesAdded} sources added (existing rows left untouched).`,
  );
}
