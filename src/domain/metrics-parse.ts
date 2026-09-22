/**
 * Parsing metrics out of OCR text — PRD §26, §27, §40, decision D4.
 *
 * Jatin screenshots the Insights panel, the Mac OCRs it locally, and this
 * turns the resulting text into numbers.
 *
 * The rule that shapes every decision here is §40: never fabricate a metric.
 * A field this parser cannot read with confidence is *absent*, not zero —
 * "the platform did not report this" and "the platform reported zero" are
 * different facts, and conflating them poisons the learning engine that §67
 * says is the whole product.
 *
 * So the parser is deliberately conservative:
 *   - It only claims a metric when a known label sits next to a number.
 *   - It never guesses from position alone.
 *   - It reports a confidence, and anything below the threshold goes to a
 *     human for confirmation rather than being written.
 *
 * Layout definitions live here as data. When Instagram redesigns its Insights
 * panel this is a data change, not a rewrite — treating a platform's UI as
 * stable would be a mistake.
 */

import type { Platform } from './content';

export type MetricKey =
  | 'impressions'
  | 'reach'
  | 'views'
  | 'likes'
  | 'comments'
  | 'saves'
  | 'shares'
  | 'profileVisits'
  | 'follows'
  | 'watchTimeSeconds'
  | 'clicks';

/**
 * Label synonyms, lowercased.
 *
 * Longer, more specific phrases are matched first, so "accounts reached"
 * wins over a bare "reach" and "profile visits" is never read as "visits".
 */
const LABELS: Record<MetricKey, readonly string[]> = {
  reach: ['accounts reached', 'accounts reach', 'reach', 'unique viewers'],
  impressions: ['impressions', 'times shown', 'impression'],
  views: ['plays', 'video views', 'views', 'watch'],
  likes: ['likes', 'reactions', 'like'],
  comments: ['comments', 'comment'],
  saves: ['saves', 'saved', 'bookmarks'],
  shares: ['shares', 'reposts', 'sends', 'share'],
  profileVisits: ['profile visits', 'profile activity', 'profile views'],
  follows: ['follows', 'new followers', 'followers gained', 'follower growth'],
  watchTimeSeconds: ['watch time', 'total watch time', 'view time'],
  clicks: ['link clicks', 'clicks', 'website taps', 'taps'],
};

/**
 * Metrics each platform actually reports.
 *
 * Reading a metric a platform does not report is a sign of a mis-parse, not a
 * discovery — §7.1 forbids inventing platform capabilities, so anything
 * outside this set is dropped.
 */
/**
 * Which metrics each platform reports **at post level**.
 *
 * This is an attribution boundary, not a convenience filter. A number the
 * platform does not report per post cannot be attributed to a post by us:
 * account-level follower growth stays an account-level fact, and assigning it
 * to whatever was published nearby is inference dressed as measurement.
 *
 * Which platforms report post-level follows is a vendor fact that has not been
 * verified from a primary source. The list is therefore the lever, and it is
 * not changed without evidence (§7.1, §7.2).
 */
const PLATFORM_METRICS: Record<Platform, readonly MetricKey[]> = {
  INSTAGRAM: [
    'reach',
    'impressions',
    'views',
    'likes',
    'comments',
    'saves',
    'shares',
    'profileVisits',
    'follows',
    'watchTimeSeconds',
  ],
  LINKEDIN: [
    'impressions',
    'views',
    'likes',
    'comments',
    'shares',
    'clicks',
    'follows',
  ],
  YOUTUBE_SHORTS: ['views', 'likes', 'comments', 'shares', 'watchTimeSeconds'],
  FACEBOOK: ['reach', 'impressions', 'views', 'likes', 'comments', 'shares', 'clicks'],
};

/**
 * Parses a number as displayed in a social analytics panel.
 *
 * Handles thousands separators and the K/M abbreviations these panels use.
 * Returns null rather than NaN or 0 — a number that cannot be read must not
 * become a metric (§40).
 */
export function parseMetricNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(/[,\s]/g, '');

  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(cleaned);
  if (!match?.[1]) return null;

  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;

  const suffix = match[2]?.toLowerCase();
  if (suffix === 'k') return Math.round(value * 1_000);
  if (suffix === 'm') return Math.round(value * 1_000_000);

  // A decimal with no suffix is not a count. "1.5" likes is a mis-read.
  if (!Number.isInteger(value)) return null;

  return value;
}

/** "1h 23m 45s", "2:03", "45s" -> seconds. */
export function parseDuration(raw: string): number | null {
  const text = raw.trim().toLowerCase();

  const hms = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/.exec(text);
  if (hms && (hms[1] || hms[2] || hms[3])) {
    return (
      Number(hms[1] ?? 0) * 3600 +
      Number(hms[2] ?? 0) * 60 +
      Number(hms[3] ?? 0)
    );
  }

  const clock = /^(\d+):([0-5]\d)$/.exec(text);
  if (clock?.[1] && clock[2]) {
    return Number(clock[1]) * 60 + Number(clock[2]);
  }

  return null;
}

interface LabelHit {
  readonly key: MetricKey;
  readonly label: string;
  readonly index: number;
  readonly length: number;
}

/** All label matches in the text, longest-first so specific labels win. */
function findLabels(
  lower: string,
  allowed: readonly MetricKey[],
): LabelHit[] {
  const hits: LabelHit[] = [];
  const claimed: Array<[number, number]> = [];

  const candidates = allowed
    .flatMap((key) => LABELS[key].map((label) => ({ key, label })))
    .sort((a, b) => b.label.length - a.label.length);

  for (const { key, label } of candidates) {
    let from = 0;
    for (;;) {
      const index = lower.indexOf(label, from);
      if (index === -1) break;
      from = index + label.length;

      // Whole-word only: "like" must not match inside "dislike".
      const before = index === 0 ? ' ' : lower[index - 1]!;
      const afterIndex = index + label.length;
      const after = afterIndex >= lower.length ? ' ' : lower[afterIndex]!;
      if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;

      // A longer label already covered this span.
      if (claimed.some(([s, e]) => index < e && afterIndex > s)) continue;

      claimed.push([index, afterIndex]);
      hits.push({ key, label, index, length: label.length });
    }
  }

  return hits.sort((a, b) => a.index - b.index);
}

/**
 * A displayed number, with an optional K/M suffix.
 *
 * The suffix may be separated by at most one space, and the match never
 * extends past the digits otherwise. An earlier version allowed `\s*` before
 * the suffix, which swallowed the trailing newline — so "45\nLikes 10" left
 * the 45 ending exactly where "Likes" began, and Likes read as 45.
 */
const NUMBER_PATTERN = /\b\d[\d,]*(?:\.\d+)?(?:\s?[KkMm])?\b/g;

interface NumberHit {
  readonly raw: string;
  readonly index: number;
  readonly end: number;
}

function findNumbers(text: string): NumberHit[] {
  const hits: NumberHit[] = [];
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    if (match.index === undefined) continue;
    hits.push({
      raw: match[0],
      index: match.index,
      end: match.index + match[0].length,
    });
  }
  return hits;
}

export interface ParsedMetrics {
  readonly metrics: Partial<Record<MetricKey, number>>;
  /** 0..1 — how much of the panel was read cleanly. */
  readonly confidence: number;
  /** Labels seen whose number could not be read. Shown to the human. */
  readonly unreadable: readonly MetricKey[];
}

/**
 * Maximum characters between a label and its number.
 *
 * Insights panels stack a label and its value adjacently; a number far away
 * belongs to a different tile. Keeping this tight is what stops the parser
 * pairing "Likes" with the follower count from the other side of the screen.
 */
const MAX_PAIR_DISTANCE = 24;

/**
 * Reads metrics out of OCR text for a given platform.
 *
 * A metric is claimed only when a recognised label has a readable number
 * within MAX_PAIR_DISTANCE, on either side (panels put the value above the
 * label as often as after it).
 */
export function parseMetrics(
  text: string,
  platform: Platform,
): ParsedMetrics {
  const allowed = PLATFORM_METRICS[platform];
  const lower = text.toLowerCase();

  const labels = findLabels(lower, allowed);
  const numbers = findNumbers(text);

  const metrics: Partial<Record<MetricKey, number>> = {};
  const unreadable: MetricKey[] = [];
  const usedNumbers = new Set<number>();

  for (const label of labels) {
    if (metrics[label.key] !== undefined) continue;

    const labelStart = label.index;
    const labelEnd = label.index + label.length;

    // A duration is several tokens ("1h 20m"), so it is read from the text
    // window rather than from a single number match.
    if (label.key === 'watchTimeSeconds') {
      const window = text.slice(labelEnd, labelEnd + MAX_PAIR_DISTANCE);
      const candidate = /^[\s:]*((?:\d+\s*[hms]\s*)+|\d+:[0-5]\d)/i.exec(window);
      const seconds = candidate?.[1] ? parseDuration(candidate[1]) : null;
      if (seconds !== null) {
        metrics.watchTimeSeconds = seconds;
        for (const number of numbers) {
          if (number.index >= labelEnd && number.index < labelEnd + candidate![0].length) {
            usedNumbers.add(number.index);
          }
        }
        continue;
      }
    }

    let best: { hit: NumberHit; distance: number } | null = null;

    for (const number of numbers) {
      if (usedNumbers.has(number.index)) continue;

      const distance =
        number.index >= labelEnd
          ? number.index - labelEnd
          : labelStart - number.end;

      if (distance < 0 || distance > MAX_PAIR_DISTANCE) continue;

      // Text between a label and its number should be whitespace or
      // punctuation. Words in between mean they belong to different tiles.
      const between =
        number.index >= labelEnd
          ? text.slice(labelEnd, number.index)
          : text.slice(number.end, labelStart);
      if (/[a-zA-Z]{2,}/.test(between)) continue;

      // Which number belongs to a label is decided by layout, not distance
      // alone:
      //
      //   Same line wins outright. In "Saves 45\nLikes 10" the 10 is Likes',
      //   even though the 45 is a character closer.
      //
      //   Across lines, the number *above* wins. Insights panels stack the
      //   value over its label, and indentation makes the distance above and
      //   below identical, so distance cannot break that tie.
      const sameLine = !between.includes('\n');
      const isAfter = number.index >= labelEnd;
      const ranked = sameLine
        ? distance
        : 1000 + distance + (isAfter ? 0.5 : 0);

      if (best === null || ranked < best.distance) {
        best = { hit: number, distance: ranked };
      }
    }

    if (best === null) {
      unreadable.push(label.key);
      continue;
    }

    const value =
      label.key === 'watchTimeSeconds'
        ? (parseDuration(best.hit.raw) ?? parseMetricNumber(best.hit.raw))
        : parseMetricNumber(best.hit.raw);

    if (value === null) {
      unreadable.push(label.key);
      continue;
    }

    metrics[label.key] = value;
    usedNumbers.add(best.hit.index);
  }

  const found = Object.keys(metrics).length;
  const attempted = found + unreadable.length;

  // Confidence reflects both how much was read and how much of what was
  // recognised could actually be resolved. Reading two metrics out of two
  // labels is not the same as reading two out of nine.
  const completeness = attempted === 0 ? 0 : found / attempted;
  // A real panel shows five or more numbers, so reading one is weak evidence
  // that the screenshot was understood.
  const coverage = Math.min(1, found / 5);
  const confidence = Number((completeness * 0.6 + coverage * 0.4).toFixed(3));

  return { metrics, confidence, unreadable };
}

/**
 * Below this, a reading is never written without a human confirming it.
 *
 * §40 forbids fabricated metrics, and a confidently-wrong OCR read is
 * fabricated data.
 */
export const CONFIRMATION_THRESHOLD = 0.7;

export function needsConfirmation(parsed: ParsedMetrics): boolean {
  return parsed.confidence < CONFIRMATION_THRESHOLD;
}

/**
 * The north-star metric — §27: follows per 1,000 impressions.
 *
 * Returns null when either input is missing. §40 again: a metric that cannot
 * be computed is absent, not zero, and a zero here would look like a real
 * conversion failure rather than missing data.
 */
export function followsPerThousandImpressions(
  follows: number | null | undefined,
  impressions: number | null | undefined,
): number | null {
  if (follows === null || follows === undefined) return null;
  if (impressions === null || impressions === undefined) return null;
  if (impressions <= 0) return null;
  return Number(((follows / impressions) * 1000).toFixed(4));
}

/** Engagement rate against reach, or impressions when reach is absent. */
export function engagementRate(input: {
  likes?: number | null;
  comments?: number | null;
  saves?: number | null;
  shares?: number | null;
  reach?: number | null;
  impressions?: number | null;
}): number | null {
  const denominator = input.reach ?? input.impressions;
  if (denominator === null || denominator === undefined || denominator <= 0) {
    return null;
  }

  const parts = [input.likes, input.comments, input.saves, input.shares].filter(
    (v): v is number => typeof v === 'number',
  );
  if (parts.length === 0) return null;

  const engagements = parts.reduce((sum, v) => sum + v, 0);
  return Number(((engagements / denominator) * 100).toFixed(4));
}

/**
 * Whether this platform reports this metric at post level.
 *
 * The single place that question is answered, so the parser and manual entry
 * cannot disagree about what may be attributed to a post.
 */
export function metricAllowedForPlatform(
  platform: Platform,
  key: MetricKey,
): boolean {
  return PLATFORM_METRICS[platform].includes(key);
}

/** Metrics that may not be attributed to a post on this platform. */
export function disallowedMetricsFor(
  platform: Platform,
  keys: readonly MetricKey[],
): MetricKey[] {
  return keys.filter((key) => !metricAllowedForPlatform(platform, key));
}
