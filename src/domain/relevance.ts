/**
 * Relevance scoring — PRD §10 (content pillars), §15 (relevance_score).
 *
 * Scores an incoming research item against the configured pillars so that the
 * triage queue is ordered by something better than arrival time.
 *
 * This is deliberately a transparent keyword model, not a learned one:
 *   - It is free and local, which §32 and §34 require.
 *   - Its output is explainable — the matched terms are returned, so a low
 *     score can be understood and the pillar's terms corrected.
 *   - §29 forbids presenting weak signals as conclusions. A score here orders
 *     a queue for human triage; it never decides anything on its own.
 */

export interface PillarTerms {
  readonly pillarId: number;
  readonly slug: string;
  /** Terms that strongly indicate this pillar. */
  readonly terms: readonly string[];
  /** Terms that merely hint at it. Weighted lower. */
  readonly weakTerms?: readonly string[];
}

export interface RelevanceScore {
  readonly score: number;
  readonly pillarId: number | null;
  readonly pillarSlug: string | null;
  readonly matched: readonly string[];
}

/**
 * Terms that indicate the item is about AI at all. An item matching no pillar
 * but clearly on-topic still deserves triage; an item matching neither is
 * noise from a feed that also carries unrelated content.
 */
const TOPIC_TERMS = [
  'ai', 'artificial intelligence', 'machine learning', 'llm',
  'language model', 'neural', 'transformer', 'gpt', 'claude', 'gemini',
  'openai', 'anthropic', 'deepmind', 'hugging face', 'inference',
  'fine-tune', 'fine tune', 'benchmark', 'agent', 'multimodal',
];

/** Counts whole-word or phrase occurrences, case-insensitively. */
function matchTerms(haystack: string, terms: readonly string[]): string[] {
  const lower = haystack.toLowerCase();
  return terms.filter((term) => {
    const t = term.toLowerCase();
    if (t.includes(' ') || t.includes('-')) return lower.includes(t);
    return new RegExp(`\\b${escapeRegExp(t)}\\b`).test(lower);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scores an item 0..1 and attributes it to its best-matching pillar.
 *
 * The title is weighted more heavily than the body: a term in the headline
 * says what the piece is about, the same term in paragraph nine may be an
 * aside.
 */
export function scoreRelevance(
  item: { title: string; summary?: string | undefined },
  pillars: readonly PillarTerms[],
): RelevanceScore {
  const title = item.title ?? '';
  const summary = item.summary ?? '';

  const topicHits = new Set([
    ...matchTerms(title, TOPIC_TERMS),
    ...matchTerms(summary, TOPIC_TERMS),
  ]);

  let best: {
    pillarId: number;
    slug: string;
    score: number;
    matched: string[];
  } | null = null;

  for (const pillar of pillars) {
    const titleStrong = matchTerms(title, pillar.terms);
    const summaryStrong = matchTerms(summary, pillar.terms);
    const titleWeak = matchTerms(title, pillar.weakTerms ?? []);
    const summaryWeak = matchTerms(summary, pillar.weakTerms ?? []);

    const raw =
      titleStrong.length * 3 +
      summaryStrong.length * 1.5 +
      titleWeak.length * 1 +
      summaryWeak.length * 0.5;

    if (raw === 0) continue;

    const matched = [
      ...new Set([
        ...titleStrong,
        ...summaryStrong,
        ...titleWeak,
        ...summaryWeak,
      ]),
    ];

    // Saturating rather than linear: ten matches is not ten times as relevant
    // as one, and a long article should not outscore a precise one.
    const pillarScore = raw / (raw + 4);

    if (best === null || pillarScore > best.score) {
      best = {
        pillarId: pillar.pillarId,
        slug: pillar.slug,
        score: pillarScore,
        matched,
      };
    }
  }

  // On-topic lift, capped, so a clearly-AI item without a pillar match still
  // surfaces above genuine noise.
  const topicLift = Math.min(0.3, topicHits.size * 0.1);

  if (best === null) {
    return {
      score: Number(topicLift.toFixed(4)),
      pillarId: null,
      pillarSlug: null,
      matched: [...topicHits],
    };
  }

  const score = Math.min(1, best.score + topicLift);

  return {
    score: Number(score.toFixed(4)),
    pillarId: best.pillarId,
    pillarSlug: best.slug,
    matched: best.matched,
  };
}

/**
 * Below this, an item is unlikely to be worth a human's triage time. It is
 * still stored — §14's source list is configurable and a wrong threshold
 * should be recoverable without having lost the data.
 */
export const TRIAGE_THRESHOLD = 0.25;

export function meetsTriageThreshold(score: number): boolean {
  return score >= TRIAGE_THRESHOLD;
}
