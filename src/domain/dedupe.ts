/**
 * Deduplication — PRD §14, §15.
 *
 * The same story reaches the system from several sources: a company's own
 * blog, then a research paper, then three publications reporting on both. §50
 * warns that repurposing must not become blind duplication; the first defence
 * is noticing that these are one story.
 *
 * Two mechanisms, deliberately separate:
 *
 *   Canonical URL  — a hard signal. Two items with the same canonical URL are
 *                    the same item, enforced by a UNIQUE index.
 *   Dedupe key     — a soft signal. Titles describing one event share a key,
 *                    which flags a *candidate* duplicate for confirmation.
 *
 * The soft signal never silently discards anything. §7.4 prefers admitting
 * uncertainty to acting confidently on a guess, and a wrongly-dropped research
 * item is invisible once dropped.
 */

/** Query parameters that identify a referrer, never the content. */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'ref',
  'ref_src',
  'source',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'igshid',
  's',
]);

/**
 * Reduces a URL to a stable identity.
 *
 * Returns the input unchanged if it cannot be parsed — an unparseable URL is
 * still a usable key, and throwing here would drop a research item.
 */
export function canonicalUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return input.trim();
  }

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.hash = '';

  for (const param of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(param.toLowerCase())) {
      url.searchParams.delete(param);
    }
  }
  url.searchParams.sort();

  // Trailing slash on a path is not a distinction; on the root it is noise.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString().replace(/\/$/, '');
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'for', 'to', 'in', 'on', 'at',
  'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it',
  'its', 'this', 'that', 'these', 'those', 'has', 'have', 'had', 'will',
  'would', 'can', 'could', 'new', 'now', 'how', 'why', 'what', 'you', 'your',
  'we', 'our', 'they', 'their',
]);

/**
 * The significant words of a title, lowercased and stripped of punctuation.
 * Short tokens are kept when numeric ("5", "4o") because version numbers
 * carry most of the meaning in AI release news.
 */
export function significantTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 0)
    .filter((t) => !STOPWORDS.has(t))
    .filter((t) => t.length > 1 || /\d/.test(t));
}

/**
 * A key shared by titles describing the same event, regardless of word order.
 *
 * "OpenAI releases GPT-5" and "GPT-5 released by OpenAI" produce the same key;
 * "OpenAI releases GPT-5" and "Anthropic releases Claude" do not.
 */
export function dedupeKey(title: string): string {
  const unique = [...new Set(stemmedTokens(title))].sort();
  return unique.join('-');
}

/**
 * Reduces a token to a form shared by its inflections.
 *
 * Not a real stemmer — deliberately. Different outlets write "releases",
 * "released" and "release" for one event, and without this the dedupe key
 * fails at exactly the job it exists to do. Strip one inflectional suffix,
 * then a trailing "e", so all three collapse to "releas".
 *
 * Tokens containing digits are left alone: "gpt-5" and "gpt-4" must never
 * merge.
 */
export function stem(token: string): string {
  if (/\d/.test(token)) return token;
  if (token.length <= 3) return token;

  let out = token;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (out.endsWith(suffix) && out.length - suffix.length >= 3) {
      out = out.slice(0, -suffix.length);
      break;
    }
  }
  return out.endsWith('e') && out.length > 3 ? out.slice(0, -1) : out;
}

/** Significant tokens reduced to their stems. The dedupe comparison basis. */
export function stemmedTokens(title: string): string[] {
  return significantTokens(title).map(stem);
}

/** Jaccard similarity of two titles' stemmed tokens, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const setA = new Set(stemmedTokens(a));
  const setB = new Set(stemmedTokens(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

export interface DuplicateCandidate {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly publishedAt?: Date | undefined;
}

export interface DuplicateVerdict {
  readonly isDuplicate: boolean;
  readonly of?: number;
  readonly similarity: number;
  readonly reason: 'SAME_URL' | 'SIMILAR_TITLE' | 'DISTINCT';
}

export const DEFAULT_SIMILARITY_THRESHOLD = 0.6;

/** Stories more than this far apart are treated as separate events. */
export const DEFAULT_WINDOW_HOURS = 72;

/**
 * Decides whether an incoming item duplicates something already stored.
 *
 * A same-canonical-URL match is decisive. A title match is only accepted
 * within a time window, because AI topics recur: "OpenAI announces a new
 * model" in January and again in June are two stories, not one.
 */
export function classifyDuplicate(
  incoming: { title: string; url: string; publishedAt?: Date | undefined },
  existing: readonly DuplicateCandidate[],
  opts: { threshold?: number; windowHours?: number } = {},
): DuplicateVerdict {
  const threshold = opts.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
  const incomingUrl = canonicalUrl(incoming.url);

  for (const candidate of existing) {
    if (canonicalUrl(candidate.url) === incomingUrl) {
      return {
        isDuplicate: true,
        of: candidate.id,
        similarity: 1,
        reason: 'SAME_URL',
      };
    }
  }

  let best: { id: number; similarity: number } | null = null;

  for (const candidate of existing) {
    if (!withinWindow(incoming.publishedAt, candidate.publishedAt, windowHours)) {
      continue;
    }
    const similarity = titleSimilarity(incoming.title, candidate.title);
    if (similarity >= threshold && (best === null || similarity > best.similarity)) {
      best = { id: candidate.id, similarity };
    }
  }

  if (best !== null) {
    return {
      isDuplicate: true,
      of: best.id,
      similarity: best.similarity,
      reason: 'SIMILAR_TITLE',
    };
  }

  return { isDuplicate: false, similarity: 0, reason: 'DISTINCT' };
}

function withinWindow(
  a: Date | undefined,
  b: Date | undefined,
  windowHours: number,
): boolean {
  // An unknown publication date should not prevent a match; treating it as
  // out-of-window would let obvious duplicates through.
  if (!a || !b) return true;
  const deltaHours = Math.abs(a.getTime() - b.getTime()) / 3_600_000;
  return deltaHours <= windowHours;
}
