/**
 * Brief composition — PRD §13 (STRATEGIC ANALYSIS → CREATION), §21, §51.
 *
 * Under decision D3 the generation step is a human pasting a brief into
 * Claude or Gemini. That makes this module the product: the system's entire
 * contribution to a piece of content is the quality of the brief it hands
 * over, and everything it knows — brand voice, verified claims with sources,
 * platform conventions, past performance — has to arrive in one paste.
 *
 * Rules enforced here rather than left to the writer:
 *
 *   §7.3  Claims are presented with their type, so an inference is never
 *         handed over looking like a fact.
 *   §7.1  Unverified claims are listed separately and explicitly barred from
 *         being stated as fact.
 *   §51   AI-character content is told, in the brief, that it may not claim
 *         real experience the human did not supply.
 *   §21   Platform framing differs; the underlying facts do not.
 *
 * Pure: takes data, returns a string. No database, no framework.
 */

import type { BrandConfig } from './brand';
import type { CharacterMode, ContentFormat, Language, Platform } from './content';
import type { ClaimType, EvidenceTier, VerificationStatus } from './evidence';
import { mayBeStatedAsFact } from './evidence';

export interface BriefClaim {
  readonly text: string;
  readonly claimType: ClaimType;
  readonly verificationStatus: VerificationStatus;
  readonly evidenceUrl?: string | null;
  readonly evidenceTier?: EvidenceTier | null;
  readonly sourceName?: string | null;
}

/** A finding from the learning engine, already filtered for sufficiency. */
export interface BriefFinding {
  readonly summary: string;
  readonly sampleSize: number;
  readonly confidence: string;
}

export interface BriefInput {
  readonly brand: BrandConfig;
  readonly platform: Platform;
  readonly format: ContentFormat;
  readonly language: Language;
  readonly characterMode: CharacterMode;
  readonly pillarName?: string | null;
  readonly opportunityTitle: string;
  readonly opportunityThesis?: string | null;
  readonly angle?: string | null;
  readonly claims: readonly BriefClaim[];
  readonly findings?: readonly BriefFinding[];
  /** Real experience the human supplied, which §51 permits referencing. */
  readonly humanSuppliedExperience?: string | null;
}

/**
 * Platform conventions — §11 formats, §21 framing.
 *
 * Deliberately about *framing and shape*, not about tactics that go stale.
 * Anything resembling "the algorithm rewards X" would be an unverifiable
 * claim about a platform's behaviour, which §7.1 forbids.
 */
const PLATFORM_GUIDANCE: Record<Platform, string> = {
  INSTAGRAM:
    'Fast, visual and concrete. The first line has to earn the second. ' +
    'Written for someone scrolling who has not decided to care yet.',
  LINKEDIN:
    'Professional and analytical. Assume a reader who works in or near the ' +
    'industry and wants the implication, not the announcement.',
  YOUTUBE_SHORTS:
    'Spoken aloud. Short sentences, one idea, a reason to stay past ' +
    'the first three seconds.',
  FACEBOOK: 'Plain and conversational, written for a general audience.',
};

const FORMAT_GUIDANCE: Record<ContentFormat, string> = {
  REEL:
    'Script for 20–40 seconds of spoken delivery. Give a hook line, the ' +
    'body as spoken beats, and an on-screen text suggestion per beat.',
  CAROUSEL:
    'Give 5–8 slides. Slide 1 is the hook, the last is the takeaway or CTA. ' +
    'One idea per slide, and text short enough to read on a phone.',
  STATIC: 'A single image concept plus the caption that carries the substance.',
  TEXT: 'A written post. No image carries the meaning — the words do.',
  DOCUMENT:
    'A document/carousel post of 5–8 pages, written to be read in sequence.',
  VIDEO: 'A script with a hook, the substance, and a close.',
};

const LANGUAGE_GUIDANCE: Record<Language, string> = {
  EN: 'Write in English.',
  HI: 'Write in Hindi (Devanagari script).',
  HINGLISH:
    'Write in natural Hinglish — Hindi and English mixed as an Indian ' +
    'reader actually speaks, not English sentences with Hindi words dropped in.',
};

function bullet(lines: readonly string[]): string {
  return lines.map((l) => `- ${l}`).join('\n');
}

function describeClaim(claim: BriefClaim): string {
  const parts = [`[${claim.claimType}] ${claim.text}`];
  const attribution: string[] = [];
  if (claim.sourceName) attribution.push(claim.sourceName);
  if (claim.evidenceTier) attribution.push(`tier: ${claim.evidenceTier}`);
  if (claim.evidenceUrl) attribution.push(claim.evidenceUrl);
  if (attribution.length > 0) {
    parts.push(`  source: ${attribution.join(' · ')}`);
  }
  return parts.join('\n');
}

/** The JSON contract the response must satisfy. Parsed by generation-parse.ts. */
export const RESPONSE_CONTRACT = `{
  "hook": "string — the opening line",
  "body": "string — the main content, formatted per the format guidance",
  "caption": "string — the caption as it will be posted",
  "cta": "string — the call to action, or \\"\\" if none fits",
  "hashtags": ["string", "..."],
  "altText": "string — image description for accessibility"
}`;

/**
 * Builds the brief.
 *
 * Structured so the most decision-relevant material — what is actually
 * verified — comes before the stylistic instructions. A writer skimming this
 * should hit the facts first.
 */
export function composeBrief(input: BriefInput): string {
  const {
    brand,
    platform,
    format,
    language,
    characterMode,
    claims,
    findings = [],
  } = input;

  const verified = claims.filter((c) =>
    mayBeStatedAsFact(c.claimType, c.verificationStatus),
  );
  const contextual = claims.filter(
    (c) =>
      !mayBeStatedAsFact(c.claimType, c.verificationStatus) &&
      c.verificationStatus !== 'UNVERIFIED',
  );
  const unverified = claims.filter((c) => c.verificationStatus === 'UNVERIFIED');

  const sections: string[] = [];

  if (brand.isPlaceholder) {
    sections.push(
      `!! BRAND VOICE NOT YET DEFINED !!\n` +
        `This brief uses a placeholder brand configuration. Output will be ` +
        `generic until the real voice, positioning and examples are supplied. ` +
        `Treat the voice section below as a rough default, not as the brand.`,
    );
  }

  sections.push(
    `# Brief: ${input.opportunityTitle}`,
    [
      `Platform: ${platform}`,
      `Format: ${format}`,
      `Language: ${language}`,
      `Character mode: ${characterMode}`,
      input.pillarName ? `Pillar: ${input.pillarName}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (input.opportunityThesis) {
    sections.push(`## The story\n${input.opportunityThesis}`);
  }
  if (input.angle) {
    sections.push(`## Angle\n${input.angle}`);
  }

  // --- Facts first. This is the part that must not be got wrong. ---
  if (verified.length > 0) {
    sections.push(
      `## Verified facts — these may be stated as fact\n` +
        verified.map(describeClaim).join('\n'),
    );
  } else {
    sections.push(
      `## Verified facts\n` +
        `None. Nothing in this brief has been verified as fact, so the ` +
        `content must not assert anything as established.`,
    );
  }

  if (contextual.length > 0) {
    sections.push(
      `## Context — NOT facts. Frame each as what it is.\n` +
        contextual.map(describeClaim).join('\n'),
    );
  }

  if (unverified.length > 0) {
    sections.push(
      `## Unverified — must NOT be stated as fact\n` +
        `These have not been checked. Use them only as questions or ` +
        `explicitly attributed reports, or leave them out.\n` +
        unverified.map(describeClaim).join('\n'),
    );
  }

  // --- §51 authenticity ---
  if (characterMode !== 'HUMAN') {
    const supplied = input.humanSuppliedExperience;
    sections.push(
      `## Authenticity rule (non-negotiable)\n` +
        (supplied
          ? `This content may reference the following real experience, ` +
            `because Jatin supplied it:\n"${supplied}"\n` +
            `It must not invent any other personal experience, opinion or ` +
            `statement attributed to him.`
          : `Jatin has supplied no personal experience for this piece. ` +
            `The content must NOT claim or imply any real experience, ` +
            `opinion, meeting, conversation or statement of his. Write about ` +
            `the subject, not about him.`),
    );
  }

  // --- Voice ---
  const voiceLines: string[] = [
    `Brand: ${brand.brandName}`,
    `Positioning: ${brand.positioning}`,
    `Primary audience: ${brand.audiencePrimary}`,
  ];
  if (brand.audienceSecondary) {
    voiceLines.push(`Secondary audience: ${brand.audienceSecondary}`);
  }
  voiceLines.push(`Voice: ${brand.voice.traits.join(', ')}`);

  sections.push(`## Voice\n${voiceLines.join('\n')}`);

  if (brand.voice.does.length > 0) {
    sections.push(`### Do\n${bullet(brand.voice.does)}`);
  }
  if (brand.voice.avoids.length > 0) {
    sections.push(`### Avoid\n${bullet(brand.voice.avoids)}`);
  }
  if (brand.voice.exampleLines.length > 0) {
    sections.push(
      `### Voice reference — match the register, do not reuse the wording\n` +
        bullet(brand.voice.exampleLines),
    );
  }

  // --- Platform and format ---
  sections.push(
    `## Platform and format\n` +
      `${PLATFORM_GUIDANCE[platform]}\n\n` +
      `${FORMAT_GUIDANCE[format]}\n\n` +
      `${LANGUAGE_GUIDANCE[language]}`,
  );

  if (brand.designSystem?.carouselNotes && format === 'CAROUSEL') {
    sections.push(`### Design notes\n${brand.designSystem.carouselNotes}`);
  }
  if (brand.designSystem?.reelNotes && format === 'REEL') {
    sections.push(`### Design notes\n${brand.designSystem.reelNotes}`);
  }

  // --- What we have learned ---
  if (findings.length > 0) {
    sections.push(
      `## What past performance suggests\n` +
        `Observations, not rules — each says how much data it rests on.\n` +
        bullet(
          findings.map(
            (f) =>
              `${f.summary} (n=${f.sampleSize}, confidence: ${f.confidence})`,
          ),
        ),
    );
  }

  // --- Output contract ---
  sections.push(
    `## Output format\n` +
      `Reply with a single fenced JSON code block and nothing else:\n\n` +
      '```json\n' +
      RESPONSE_CONTRACT +
      '\n```',
  );

  return sections.join('\n\n');
}
