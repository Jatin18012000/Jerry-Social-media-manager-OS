/**
 * Obsidian note rendering — the automation guide's §10.
 *
 * "Obsidian may be used as a human-readable knowledge/memory layer. It must
 * not become the only system of record. Claude Code may generate or update
 * Markdown notes from structured records, while the application database
 * remains authoritative for content state, approvals, schedules, and
 * analytics."
 *
 * So this is a one-way projection. The database is the system of record; notes
 * are a readable view of it. Nothing reads a note back as authoritative, and
 * there is deliberately no import path — a rule that has to be structurally
 * true rather than merely documented.
 *
 * Pure: renders strings. All filesystem work lives in the adapter, so the
 * parts that are easy to get dangerously wrong — filenames, YAML escaping —
 * are testable without touching a disk.
 */

import type { ClaimType, EvidenceTier, VerificationStatus } from './evidence';

// ---------------------------------------------------------------------------
// Filenames — the security-critical part
// ---------------------------------------------------------------------------

/** Reserved on Windows, and a file named this breaks a vault on any OS. */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

const MAX_SLUG_LENGTH = 80;

/**
 * Turns a title into a safe filename stem.
 *
 * This is the one function here that can cause real harm if it is wrong.
 * Titles arrive from RSS feeds — arbitrary text from the open internet — and
 * are used to build a path on Jatin's machine. A title of `../../.ssh/config`
 * or `/etc/passwd` must not be able to escape the vault directory.
 *
 * The approach is allow-listing rather than blocking: strip everything that is
 * not a letter, digit or space, then join with hyphens. Nothing that could
 * traverse, hide, or collide with a device name can survive that, because
 * separators and dots are not in the allowed set at all.
 */
export function slugify(title: string, fallback = 'untitled'): string {
  const slug = title
    .normalize('NFKD')
    // Allow-list: letters, numbers, whitespace. Everything else goes, which
    // includes '/', '\\', '.', ':' and every control character.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, MAX_SLUG_LENGTH)
    // A trailing hyphen from truncation is ugly; a leading one looks hidden.
    .replace(/^-+|-+$/g, '');

  if (!slug) return fallback;
  if (RESERVED_NAMES.has(slug)) return `${slug}-note`;
  return slug;
}

/** A vault-relative note path. Always includes the id, so titles may collide. */
export function notePath(
  folder: string,
  id: number,
  title: string,
): string {
  return `${folder}/${id}-${slugify(title)}.md`;
}

// ---------------------------------------------------------------------------
// YAML frontmatter
// ---------------------------------------------------------------------------

/**
 * Serialises a value for YAML frontmatter.
 *
 * Titles routinely contain colons, quotes and hashes, any of which breaks
 * naive frontmatter and makes Obsidian show the whole block as body text.
 * Strings are always double-quoted and escaped rather than guessed at.
 */
export function yamlValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map((v) => yamlValue(v)).join(', ')}]`;
  }

  const text = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // A literal newline inside a quoted scalar is invalid YAML.
    .replace(/\r?\n/g, ' ')
    .trim();

  return `"${text}"`;
}

export function frontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${yamlValue(value)}`);

  return ['---', ...lines, '---'].join('\n');
}

/**
 * Escapes text used inside a `[[wikilink]]`.
 *
 * Obsidian treats `|` as an alias separator and `]]` as the closing delimiter,
 * so a title containing either would produce a broken or misleading link.
 */
export function wikilink(target: string, alias?: string): string {
  const safe = (s: string) => s.replace(/[[\]|#^]/g, ' ').replace(/\s+/g, ' ').trim();
  const cleanTarget = safe(target);
  if (!cleanTarget) return '';
  return alias ? `[[${cleanTarget}|${safe(alias)}]]` : `[[${cleanTarget}]]`;
}

function tag(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean ? `#${clean}` : null;
}

// ---------------------------------------------------------------------------
// The generated region
// ---------------------------------------------------------------------------

export const GENERATED_START = '<!-- smos:generated:start -->';
export const GENERATED_END = '<!-- smos:generated:end -->';

/**
 * Wraps generated content in markers, with a space below for the human.
 *
 * Re-exporting replaces only what is between the markers. Anything Jatin
 * writes below them survives, because a knowledge layer people cannot annotate
 * is not a knowledge layer — and silently overwriting someone's notes is the
 * kind of data loss that makes a tool untrustworthy after exactly one
 * occurrence.
 */
export function wrapGenerated(body: string): string {
  return [
    GENERATED_START,
    body.trimEnd(),
    GENERATED_END,
    '',
    '## My notes',
    '',
    '',
  ].join('\n');
}

/**
 * Replaces the generated region of an existing note, preserving the rest.
 *
 * When the markers are missing — a note the user created by hand at the same
 * path, or one from an older export — the existing content is kept in full and
 * the new generated block is placed above it. Nothing is ever discarded.
 */
export function mergeGenerated(existing: string, body: string): string {
  const start = existing.indexOf(GENERATED_START);
  const end = existing.indexOf(GENERATED_END);

  if (start === -1 || end === -1 || end < start) {
    return `${GENERATED_START}\n${body.trimEnd()}\n${GENERATED_END}\n\n${existing.trimStart()}`;
  }

  const before = existing.slice(0, start);
  const after = existing.slice(end + GENERATED_END.length);

  return `${before}${GENERATED_START}\n${body.trimEnd()}\n${GENERATED_END}${after}`;
}

// ---------------------------------------------------------------------------
// Note bodies
// ---------------------------------------------------------------------------

export interface ResearchNote {
  readonly id: number;
  readonly title: string;
  readonly summary: string | null;
  readonly url: string;
  readonly sourceName: string;
  readonly credibilityTier: EvidenceTier;
  readonly publishedAt: number | null;
  readonly discoveredAt: number;
  readonly relevanceScore: number | null;
  readonly status: string;
  readonly pillarName: string | null;
  readonly claims: readonly {
    text: string;
    claimType: ClaimType;
    verificationStatus: VerificationStatus;
    evidenceUrl: string | null;
    evidenceTier: EvidenceTier | null;
  }[];
}

function isoDate(ms: number | null): string | null {
  if (ms === null) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

export function renderResearchNote(note: ResearchNote): string {
  const tags = [tag(note.pillarName), '#research'].filter(Boolean);

  const head = frontmatter({
    type: 'research',
    smos_id: note.id,
    title: note.title,
    source: note.sourceName,
    source_tier: note.credibilityTier,
    url: note.url,
    published: isoDate(note.publishedAt),
    discovered: isoDate(note.discoveredAt),
    relevance: note.relevanceScore,
    status: note.status,
    pillar: note.pillarName,
  });

  const lines: string[] = [`# ${note.title}`, '', tags.join(' '), ''];

  if (note.summary) lines.push(note.summary, '');

  lines.push(`[Source](${note.url}) · ${note.sourceName} · ${note.credibilityTier}`, '');

  if (note.claims.length > 0) {
    lines.push('## Claims', '');
    // §7.3 — the type is shown on every claim, because a knowledge layer that
    // renders an inference identically to a verified fact is worse than none.
    for (const claim of note.claims) {
      const evidence = claim.evidenceUrl
        ? ` ([evidence](${claim.evidenceUrl}), ${claim.evidenceTier})`
        : '';
      lines.push(
        `- **${claim.claimType}** · ${claim.verificationStatus} — ${claim.text}${evidence}`,
      );
    }
    lines.push('');

    const unverified = note.claims.filter(
      (c) => c.verificationStatus === 'UNVERIFIED',
    ).length;
    if (unverified > 0) {
      lines.push(
        `> ${unverified} of these claims are unverified. Nothing here has ` +
          `been checked unless it says VERIFIED.`,
        '',
      );
    }
  }

  return `${head}\n\n${wrapGenerated(lines.join('\n'))}`;
}

export interface OpportunityNote {
  readonly id: number;
  readonly title: string;
  readonly thesis: string | null;
  readonly angle: string | null;
  readonly status: string;
  readonly pillarName: string | null;
  readonly createdAt: number;
  readonly research: readonly { id: number; title: string }[];
  readonly variants: readonly {
    id: number;
    platform: string;
    format: string;
    state: string;
    title: string;
  }[];
}

export function renderOpportunityNote(note: OpportunityNote): string {
  const head = frontmatter({
    type: 'opportunity',
    smos_id: note.id,
    title: note.title,
    status: note.status,
    pillar: note.pillarName,
    created: isoDate(note.createdAt),
  });

  const lines: string[] = [
    `# ${note.title}`,
    '',
    [tag(note.pillarName), '#opportunity'].filter(Boolean).join(' '),
    '',
  ];

  if (note.thesis) lines.push(note.thesis, '');
  if (note.angle) lines.push(`**Angle:** ${note.angle}`, '');

  if (note.research.length > 0) {
    lines.push('## Research behind this', '');
    for (const item of note.research) {
      lines.push(`- ${wikilink(`${item.id}-${slugify(item.title)}`, item.title)}`);
    }
    lines.push('');
  }

  if (note.variants.length > 0) {
    lines.push('## Variants', '');
    for (const variant of note.variants) {
      lines.push(
        `- ${variant.platform} ${variant.format} — ${variant.state} · ` +
          wikilink(`${variant.id}-${slugify(variant.title)}`, 'note'),
      );
    }
    lines.push('');
  }

  return `${head}\n\n${wrapGenerated(lines.join('\n'))}`;
}

export interface PublishedNote {
  readonly id: number;
  readonly title: string;
  readonly platform: string;
  readonly format: string;
  readonly language: string;
  readonly characterMode: string;
  readonly publishedAt: number | null;
  readonly externalUrl: string | null;
  readonly hook: string | null;
  readonly body: string | null;
  readonly caption: string | null;
  readonly cta: string | null;
  readonly hashtags: string | null;
  readonly pillarName: string | null;
  readonly opportunity: { id: number; title: string } | null;
  readonly metrics: {
    impressions: number | null;
    reach: number | null;
    likes: number | null;
    comments: number | null;
    saves: number | null;
    shares: number | null;
    follows: number | null;
    followsPerThousand: number | null;
    engagementRatePct: number | null;
    capturedAt: number;
  } | null;
}

/** An em-dash, never 0 — §40's absent-versus-zero rule reaches the vault too. */
function metric(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('en-IN');
}

export function renderPublishedNote(note: PublishedNote): string {
  const head = frontmatter({
    type: 'published',
    smos_id: note.id,
    title: note.title,
    platform: note.platform,
    format: note.format,
    language: note.language,
    character_mode: note.characterMode,
    published: isoDate(note.publishedAt),
    url: note.externalUrl,
    pillar: note.pillarName,
    impressions: note.metrics?.impressions ?? null,
    reach: note.metrics?.reach ?? null,
    follows: note.metrics?.follows ?? null,
    follows_per_1k: note.metrics?.followsPerThousand ?? null,
  });

  const lines: string[] = [
    `# ${note.title}`,
    '',
    [
      tag(note.pillarName),
      tag(note.platform),
      tag(note.format),
      '#published',
    ]
      .filter(Boolean)
      .join(' '),
    '',
  ];

  if (note.externalUrl) lines.push(`[View the post](${note.externalUrl})`, '');

  if (note.opportunity) {
    lines.push(
      `From ${wikilink(
        `${note.opportunity.id}-${slugify(note.opportunity.title)}`,
        note.opportunity.title,
      )}`,
      '',
    );
  }

  lines.push('## What went out', '');
  if (note.hook) lines.push(`**Hook:** ${note.hook}`, '');
  if (note.caption) lines.push(note.caption, '');
  if (note.body) lines.push('```', note.body, '```', '');
  if (note.cta) lines.push(`**CTA:** ${note.cta}`, '');
  if (note.hashtags) {
    lines.push(
      note.hashtags
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((t) => `#${t.replace(/^#+/, '')}`)
        .join(' '),
      '',
    );
  }

  lines.push('## How it did', '');
  if (!note.metrics) {
    lines.push('No metrics captured yet.', '');
  } else {
    lines.push(
      '| Metric | Value |',
      '| --- | --- |',
      `| Reach | ${metric(note.metrics.reach ?? note.metrics.impressions)} |`,
      `| Likes | ${metric(note.metrics.likes)} |`,
      `| Comments | ${metric(note.metrics.comments)} |`,
      `| Saves | ${metric(note.metrics.saves)} |`,
      `| Shares | ${metric(note.metrics.shares)} |`,
      `| Follows | ${metric(note.metrics.follows)} |`,
      `| Engagement % | ${
        note.metrics.engagementRatePct === null
          ? '—'
          : note.metrics.engagementRatePct.toFixed(1)
      } |`,
      `| **Follows / 1k** | ${
        note.metrics.followsPerThousand === null
          ? '—'
          : note.metrics.followsPerThousand.toFixed(2)
      } |`,
      '',
      `Captured ${isoDate(note.metrics.capturedAt)}. ` +
        `"—" means not reported, not zero.`,
      '',
    );
  }

  return `${head}\n\n${wrapGenerated(lines.join('\n'))}`;
}
