/**
 * Quality assurance gate — PRD §13 (QUALITY ASSURANCE), §22, §61.
 *
 * Runs between GENERATING and READY_FOR_REVIEW. Its job is to catch what a
 * machine can catch, so that Jatin's review attention goes to judgement calls
 * rather than to counting hashtags.
 *
 * Two deliberate limits:
 *
 *   It does not judge quality. Whether a hook is good is a human call, and a
 *   heuristic pretending otherwise would add noise to the one gate §22 makes
 *   mandatory.
 *
 *   It blocks only on things that are objectively wrong — a missing caption,
 *   an unverified claim, a platform limit exceeded. Everything else is a
 *   warning the reviewer can overrule, because a gate that cries wolf gets
 *   clicked through.
 *
 * Pure: no database, no framework.
 */

import type { CharacterMode, ContentFormat, Language, Platform } from './content';
import type { ClaimType, VerificationStatus } from './evidence';

export type QaSeverity = 'BLOCKER' | 'WARNING';

export interface QaFinding {
  readonly severity: QaSeverity;
  readonly code: string;
  readonly message: string;
}

export interface QaSubject {
  readonly platform: Platform;
  readonly format: ContentFormat;
  readonly language: Language;
  readonly characterMode: CharacterMode;
  readonly hook: string | null;
  readonly body: string | null;
  readonly caption: string | null;
  readonly cta: string | null;
  readonly hashtags: string | null;
  readonly altText: string | null;
  readonly claims: readonly {
    claimType: ClaimType;
    verificationStatus: VerificationStatus;
  }[];
  readonly humanSuppliedExperience?: string | null;
  readonly brandIsPlaceholder?: boolean;
}

/**
 * Platform limits.
 *
 * These are documented, long-standing platform constraints rather than
 * guesses about ranking behaviour — §7.1 forbids inventing platform
 * capabilities, so nothing here claims to know what "performs well".
 *
 * They are conservative: exceeding them means the platform truncates or
 * rejects, which is a genuine blocker.
 */
export const PLATFORM_LIMITS: Record<
  Platform,
  { captionChars: number; maxHashtags: number }
> = {
  INSTAGRAM: { captionChars: 2200, maxHashtags: 30 },
  LINKEDIN: { captionChars: 3000, maxHashtags: 30 },
  YOUTUBE_SHORTS: { captionChars: 5000, maxHashtags: 15 },
  FACEBOOK: { captionChars: 5000, maxHashtags: 30 },
};

/** Formats whose whole point is an image or video. */
const VISUAL_FORMATS: readonly ContentFormat[] = [
  'REEL',
  'CAROUSEL',
  'STATIC',
  'VIDEO',
  'DOCUMENT',
];

function countHashtags(hashtags: string | null): number {
  if (!hashtags) return 0;
  return hashtags.split(/[\s,]+/).filter((t) => t.trim().length > 0).length;
}

export interface QaReport {
  readonly findings: readonly QaFinding[];
  readonly blockers: readonly QaFinding[];
  readonly warnings: readonly QaFinding[];
  /** True when nothing objectively wrong was found. */
  readonly passed: boolean;
}

export function runQa(subject: QaSubject): QaReport {
  const findings: QaFinding[] = [];

  const add = (severity: QaSeverity, code: string, message: string): void => {
    findings.push({ severity, code, message });
  };

  // --- Completeness ---

  if (!subject.caption?.trim()) {
    add('BLOCKER', 'missing-caption', 'There is no caption to post.');
  }

  if (!subject.body?.trim() && !subject.caption?.trim()) {
    add('BLOCKER', 'missing-content', 'There is no content at all.');
  }

  if (!subject.hook?.trim()) {
    add('WARNING', 'missing-hook', 'No hook — the opening line is unset.');
  }

  if (!subject.cta?.trim()) {
    add('WARNING', 'missing-cta', 'No call to action.');
  }

  // --- Accessibility ---

  if (VISUAL_FORMATS.includes(subject.format) && !subject.altText?.trim()) {
    add(
      'WARNING',
      'missing-alt-text',
      'No alt text. Visual content should describe itself for people using ' +
        'a screen reader.',
    );
  }

  // --- Platform limits ---

  const limits = PLATFORM_LIMITS[subject.platform];
  const captionLength = subject.caption?.length ?? 0;

  if (captionLength > limits.captionChars) {
    add(
      'BLOCKER',
      'caption-too-long',
      `Caption is ${captionLength} characters; ${subject.platform} allows ` +
        `${limits.captionChars}. It would be truncated or rejected.`,
    );
  } else if (captionLength > limits.captionChars * 0.9) {
    add(
      'WARNING',
      'caption-near-limit',
      `Caption is close to ${subject.platform}'s ${limits.captionChars}-character limit.`,
    );
  }

  const hashtagCount = countHashtags(subject.hashtags);
  if (hashtagCount > limits.maxHashtags) {
    add(
      'BLOCKER',
      'too-many-hashtags',
      `${hashtagCount} hashtags; ${subject.platform} allows ${limits.maxHashtags}.`,
    );
  }

  // --- Truth policy (§7, §16) ---

  const unverified = subject.claims.filter(
    (c) => c.verificationStatus === 'UNVERIFIED',
  );
  if (unverified.length > 0) {
    add(
      'BLOCKER',
      'unverified-claims',
      `${unverified.length} claim(s) behind this content are still ` +
        `unverified. Check them before this goes to review (§16).`,
    );
  }

  const disputed = subject.claims.filter(
    (c) => c.verificationStatus === 'DISPUTED',
  );
  if (disputed.length > 0) {
    add(
      'WARNING',
      'disputed-claims',
      `${disputed.length} claim(s) are disputed. Make sure the content ` +
        `frames them as contested rather than settled (§7.3).`,
    );
  }

  const statableFacts = subject.claims.filter(
    (c) => c.claimType === 'FACT' && c.verificationStatus === 'VERIFIED',
  );
  if (subject.claims.length > 0 && statableFacts.length === 0) {
    add(
      'WARNING',
      'no-verified-facts',
      'Nothing behind this content is a verified fact. It must not assert ' +
        'anything as established (§7.4).',
    );
  }

  // --- Authenticity (§51) ---

  if (
    subject.characterMode !== 'HUMAN' &&
    !subject.humanSuppliedExperience?.trim()
  ) {
    add(
      'WARNING',
      'character-authenticity',
      `Character mode is ${subject.characterMode} and no real experience was ` +
        'supplied. Check the content does not imply one (§51).',
    );
  }

  // --- Brand (§57 Risk 1) ---

  if (subject.brandIsPlaceholder) {
    add(
      'WARNING',
      'placeholder-brand',
      'The brand voice is still the placeholder, so this was written to a ' +
        'generic default.',
    );
  }

  const blockers = findings.filter((f) => f.severity === 'BLOCKER');
  const warnings = findings.filter((f) => f.severity === 'WARNING');

  return {
    findings,
    blockers,
    warnings,
    passed: blockers.length === 0,
  };
}
