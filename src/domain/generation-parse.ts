/**
 * Parsing a generation response — decision D3.
 *
 * The human pastes back whatever Claude or Gemini produced. This turns it into
 * structured fields.
 *
 * The governing constraint: under D3, the scarcest resource in the system is
 * Jatin's manual generation effort. A parse failure must never cost him that
 * work. So:
 *
 *   - The raw response is persisted by the caller *before* parsing is tried.
 *   - Parsing never throws. It returns a result describing what it managed.
 *   - A partial parse is returned as a partial parse, not discarded.
 *   - Whatever fails falls through to manual field entry with the raw text.
 *
 * Three strategies, tried in order: a fenced JSON block (what the brief asks
 * for), bare JSON, then a heuristic over markdown headings for when the model
 * ignored the contract — which it sometimes will.
 */

export interface ParsedGeneration {
  readonly hook: string | null;
  readonly body: string | null;
  readonly caption: string | null;
  readonly cta: string | null;
  readonly hashtags: readonly string[];
  readonly altText: string | null;
}

export type ParseStrategy =
  | 'FENCED_JSON'
  | 'BARE_JSON'
  | 'HEADINGS'
  | 'NONE';

export interface ParseResult {
  /** True only when at least one substantive field was recovered. */
  readonly ok: boolean;
  readonly strategy: ParseStrategy;
  readonly parsed: ParsedGeneration;
  /** Fields the strategy could not find. Surfaced for manual completion. */
  readonly missing: readonly (keyof ParsedGeneration)[];
  readonly error?: string;
}

const EMPTY: ParsedGeneration = {
  hook: null,
  body: null,
  caption: null,
  cta: null,
  hashtags: [],
  altText: null,
};

/** Fields whose absence means the parse did not really succeed. */
const SUBSTANTIVE: (keyof ParsedGeneration)[] = ['hook', 'body', 'caption'];

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalises hashtags from the several shapes models emit: an array, a
 * space-separated string, a comma-separated string, with or without '#'.
 */
export function normaliseHashtags(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : [];

  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of raw) {
    const tag = entry.trim().replace(/^#+/, '');
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }

  return out;
}

function fromRecord(record: Record<string, unknown>): ParsedGeneration {
  // Models vary the casing and wording; accept the obvious synonyms rather
  // than making the human re-run generation over a key name.
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      const match = Object.keys(record).find(
        (k) => k.toLowerCase().replace(/[_\s-]/g, '') === key,
      );
      if (match !== undefined) return record[match];
    }
    return undefined;
  };

  return {
    hook: cleanString(pick('hook', 'hookline', 'opening')),
    body: cleanString(pick('body', 'content', 'script', 'slides')),
    caption: cleanString(pick('caption', 'post', 'text')),
    cta: cleanString(pick('cta', 'calltoaction')),
    hashtags: normaliseHashtags(pick('hashtags', 'tags')),
    altText: cleanString(pick('alttext', 'alt', 'imagedescription')),
  };
}

/** Body may arrive as an array of slides or beats. Flatten it readably. */
function flattenBody(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const lines = value
    .map((entry, index) => {
      if (typeof entry === 'string') return `${index + 1}. ${entry.trim()}`;
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const text = Object.values(record)
          .filter((v): v is string => typeof v === 'string')
          .join(' — ');
        return text ? `${index + 1}. ${text}` : null;
      }
      return null;
    })
    .filter((l): l is string => l !== null);

  return lines.length > 0 ? lines.join('\n') : null;
}

function extractFencedJson(input: string): string | null {
  // Non-greedy, and tolerant of ```json / ```JSON / bare ```.
  const match = /```(?:json)?\s*\n([\s\S]*?)\n?```/i.exec(input);
  return match?.[1]?.trim() ?? null;
}

function extractBareJson(input: string): string | null {
  const start = input.indexOf('{');
  const end = input.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return input.slice(start, end + 1);
}

function tryJson(candidate: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(candidate) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

const HEADING_ALIASES: Record<string, keyof ParsedGeneration> = {
  hook: 'hook',
  'hook line': 'hook',
  opening: 'hook',
  body: 'body',
  content: 'body',
  script: 'body',
  slides: 'body',
  caption: 'caption',
  post: 'caption',
  cta: 'cta',
  'call to action': 'cta',
  hashtags: 'hashtags',
  tags: 'hashtags',
  'alt text': 'altText',
  alt: 'altText',
  'image description': 'altText',
};

/**
 * Last resort: read markdown headings or "Label:" lines.
 *
 * Models that ignore the JSON contract usually still label their sections,
 * and recovering four fields out of six beats handing back nothing.
 */
export function parseHeadings(input: string): ParsedGeneration {
  const result: Record<string, string[]> = {};
  let current: keyof ParsedGeneration | null = null;

  for (const line of input.split('\n')) {
    const heading =
      /^#{1,6}\s*(.+?)\s*:?\s*$/.exec(line) ??
      /^\*\*(.+?)\*\*\s*:?\s*$/.exec(line) ??
      /^([A-Za-z][A-Za-z\s]{1,24}):\s*$/.exec(line);

    if (heading?.[1]) {
      const key = HEADING_ALIASES[heading[1].trim().toLowerCase()];
      if (key) {
        current = key;
        result[key] = [];
        continue;
      }
    }

    // "Label: value" on one line.
    const inline = /^\*{0,2}([A-Za-z][A-Za-z\s]{1,24})\*{0,2}:\s*(.+)$/.exec(
      line,
    );
    if (inline?.[1] && inline[2]) {
      const key = HEADING_ALIASES[inline[1].trim().toLowerCase()];
      if (key) {
        result[key] = [inline[2].trim()];
        current = key;
        continue;
      }
    }

    if (current) {
      (result[current] ??= []).push(line);
    }
  }

  const join = (key: keyof ParsedGeneration): string | null =>
    cleanString((result[key] ?? []).join('\n'));

  return {
    hook: join('hook'),
    body: join('body'),
    caption: join('caption'),
    cta: join('cta'),
    hashtags: normaliseHashtags((result['hashtags'] ?? []).join(' ')),
    altText: join('altText'),
  };
}

function missingFields(parsed: ParsedGeneration): (keyof ParsedGeneration)[] {
  const missing: (keyof ParsedGeneration)[] = [];
  for (const key of ['hook', 'body', 'caption', 'cta', 'altText'] as const) {
    if (parsed[key] === null) missing.push(key);
  }
  if (parsed.hashtags.length === 0) missing.push('hashtags');
  return missing;
}

function hasSubstance(parsed: ParsedGeneration): boolean {
  return SUBSTANTIVE.some((key) => parsed[key] !== null);
}

/**
 * Parses a pasted response. Never throws.
 *
 * Returns the best interpretation available, plus which fields are missing so
 * the UI can pre-fill a form rather than asking for the work again.
 */
export function parseGeneration(raw: string): ParseResult {
  if (!raw || raw.trim().length === 0) {
    return {
      ok: false,
      strategy: 'NONE',
      parsed: EMPTY,
      missing: missingFields(EMPTY),
      error: 'Nothing was pasted.',
    };
  }

  const attempts: { strategy: ParseStrategy; candidate: string | null }[] = [
    { strategy: 'FENCED_JSON', candidate: extractFencedJson(raw) },
    { strategy: 'BARE_JSON', candidate: extractBareJson(raw) },
  ];

  for (const attempt of attempts) {
    if (!attempt.candidate) continue;
    const record = tryJson(attempt.candidate);
    if (!record) continue;

    let parsed = fromRecord(record);

    // A body given as a list of slides or beats is common and valid.
    if (parsed.body === null) {
      const flattened =
        flattenBody(record['body']) ??
        flattenBody(record['slides']) ??
        flattenBody(record['script']);
      if (flattened) parsed = { ...parsed, body: flattened };
    }

    if (hasSubstance(parsed)) {
      return {
        ok: true,
        strategy: attempt.strategy,
        parsed,
        missing: missingFields(parsed),
      };
    }
  }

  const headings = parseHeadings(raw);
  if (hasSubstance(headings)) {
    return {
      ok: true,
      strategy: 'HEADINGS',
      parsed: headings,
      missing: missingFields(headings),
    };
  }

  // Nothing structured survived. The raw text is still held by the caller,
  // and the whole paste becomes the body so none of it is lost.
  const fallback: ParsedGeneration = { ...EMPTY, body: raw.trim() };
  return {
    ok: false,
    strategy: 'NONE',
    parsed: fallback,
    missing: missingFields(fallback),
    error:
      'Could not find structured fields. The full text is kept as the body — ' +
      'fill in the remaining fields by hand, or regenerate.',
  };
}
