/**
 * Research classification — PRD §15, §36, and the automation guide's §8.
 *
 * Decides, for one research item: which pillar, how relevant, what language.
 *
 * Two implementations of the same judgement, and the fallback is the point.
 * Qwen running locally produces better judgement than keyword matching. But
 * the laptop may not be running Ollama, the model may be mid-download, the
 * request may time out — and when that happens the research queue must keep
 * working. So the deterministic heuristics stay, and they are not a
 * second-class path: they are what runs by default.
 *
 * Every run is recorded in `agent_runs` (§43, §44) whichever path took it, so
 * "is the local model actually being used, and is it any better" is a
 * question the data can answer rather than a matter of belief.
 */

import { eq } from 'drizzle-orm';

import type { DB } from '@/db/client';
import { agentRuns, contentPillars } from '@/db/schema';
import type { Language } from '@/domain/content';
import { type PillarTerms, scoreRelevance } from '@/domain/relevance';
import type { StructuredProvider } from '@/ports';

export interface Classification {
  readonly pillarId: number | null;
  readonly pillarSlug: string | null;
  /** 0..1 */
  readonly relevance: number;
  readonly language: Language | null;
  readonly reason: string;
  readonly source: 'LOCAL_MODEL' | 'HEURISTIC';
}

export interface ClassifyInput {
  readonly title: string;
  readonly summary?: string | null;
}

const LANGUAGES: readonly Language[] = ['EN', 'HI', 'HINGLISH'];

/**
 * Validates a model's classification.
 *
 * Deliberately strict. An unknown pillar slug, a relevance outside 0..1 or a
 * language the system does not model all mean the output is not usable, and
 * returning null sends the caller to the heuristics. §7.1 — the model does
 * not get to invent a pillar.
 */
export function parseClassification(
  raw: unknown,
  pillarSlugs: readonly string[],
): {
  pillarSlug: string | null;
  relevance: number;
  language: Language | null;
  reason: string;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;

  const relevanceRaw = record['relevance'];
  if (typeof relevanceRaw !== 'number' || !Number.isFinite(relevanceRaw)) {
    return null;
  }
  if (relevanceRaw < 0 || relevanceRaw > 1) return null;

  const pillarRaw = record['pillar'];
  let pillarSlug: string | null = null;
  if (typeof pillarRaw === 'string' && pillarRaw.trim()) {
    const candidate = pillarRaw.trim().toLowerCase();
    // An unrecognised pillar is a hallucination, not a discovery.
    if (!pillarSlugs.includes(candidate)) return null;
    pillarSlug = candidate;
  }

  const languageRaw = record['language'];
  let language: Language | null = null;
  if (typeof languageRaw === 'string' && languageRaw.trim()) {
    const candidate = languageRaw.trim().toUpperCase() as Language;
    if (!LANGUAGES.includes(candidate)) return null;
    language = candidate;
  }

  const reasonRaw = record['reason'];
  const reason =
    typeof reasonRaw === 'string' && reasonRaw.trim()
      ? reasonRaw.trim().slice(0, 300)
      : '';

  return { pillarSlug, relevance: relevanceRaw, language, reason };
}

const INSTRUCTION = [
  'You classify AI/technology news items for a content pipeline.',
  'Given a title and summary, return JSON with these fields:',
  '  pillar: one of the provided slugs, or omit if none fit',
  '  relevance: a number from 0 to 1',
  '  language: "EN", "HI" or "HINGLISH" — the language of the item itself',
  '  reason: one short sentence explaining the relevance score',
  'Do not invent a pillar that is not in the list.',
  'Judge relevance to an audience interested in AI news, AI research,',
  'AI careers and practical AI use. A story unrelated to those scores low.',
].join('\n');

function pillarRows(db: DB) {
  return db
    .select({
      id: contentPillars.id,
      slug: contentPillars.slug,
      name: contentPillars.name,
      description: contentPillars.description,
    })
    .from(contentPillars)
    .where(eq(contentPillars.active, true))
    .all();
}

function heuristicTerms(
  rows: readonly { id: number; slug: string; description: string | null }[],
): PillarTerms[] {
  return rows.map((row) => ({
    pillarId: row.id,
    slug: row.slug,
    terms: (row.description ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0),
  }));
}

/** The deterministic path. Free, offline, explainable, always available. */
export function classifyWithHeuristics(
  db: DB,
  input: ClassifyInput,
): Classification {
  const rows = pillarRows(db);
  const scored = scoreRelevance(
    { title: input.title, summary: input.summary ?? undefined },
    heuristicTerms(rows),
  );

  return {
    pillarId: scored.pillarId,
    pillarSlug: scored.pillarSlug,
    relevance: scored.score,
    // Keyword matching cannot tell Hinglish from English; saying nothing is
    // honest, and null means "not determined" rather than "English".
    language: null,
    reason:
      scored.matched.length > 0
        ? `matched: ${scored.matched.slice(0, 6).join(', ')}`
        : 'no pillar terms matched',
    source: 'HEURISTIC',
  };
}

/**
 * Classifies one item, preferring the local model and falling back silently.
 *
 * "Silently" for the caller, not for the record: every attempt writes an
 * `agent_runs` row with its status and duration, so a model that is quietly
 * failing shows up in the data rather than just degrading quality.
 */
export async function classifyResearchItem(
  db: DB,
  input: ClassifyInput,
  provider: StructuredProvider | null,
  opts: { now?: Date } = {},
): Promise<Classification> {
  const now = opts.now ?? new Date();
  const rows = pillarRows(db);
  const slugs = rows.map((r) => r.slug);

  if (provider && (await provider.available())) {
    const run = await provider.run({
      task: 'classify-research',
      instruction: `${INSTRUCTION}\n\nAvailable pillar slugs: ${slugs.join(', ')}`,
      input: {
        title: input.title,
        summary: (input.summary ?? '').slice(0, 2_000),
      },
      parse: (raw) => parseClassification(raw, slugs),
    });

    db.insert(agentRuns)
      .values({
        agent: 'qwen',
        provider: run.provider,
        model: run.model,
        operation: 'classify-research',
        durationMs: run.durationMs,
        status: run.status,
        error: run.error ?? null,
        createdAt: now.getTime(),
      })
      .run();

    if (run.output) {
      const matched = run.output.pillarSlug
        ? rows.find((r) => r.slug === run.output!.pillarSlug)
        : undefined;

      return {
        pillarId: matched?.id ?? null,
        pillarSlug: matched?.slug ?? null,
        relevance: Number(run.output.relevance.toFixed(4)),
        language: run.output.language,
        reason: run.output.reason || 'classified by local model',
        source: 'LOCAL_MODEL',
      };
    }
    // Anything other than a clean, valid answer falls through.
  }

  const heuristic = classifyWithHeuristics(db, input);

  db.insert(agentRuns)
    .values({
      agent: 'heuristic',
      provider: 'local',
      model: null,
      operation: 'classify-research',
      durationMs: 0,
      status: 'OK',
      createdAt: now.getTime(),
    })
    .run();

  return heuristic;
}
