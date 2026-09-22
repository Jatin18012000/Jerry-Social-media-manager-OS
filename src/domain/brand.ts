/**
 * Brand configuration — PRD §8 (positioning), §9 (audience/language),
 * §19 (AI character), §20 (design system).
 *
 * This module defines the *shape* of the brand configuration and nothing
 * about its content. §4 assigns brand and content strategy to ChatGPT and §5
 * forbids this codebase from setting product strategy, so the values are
 * supplied by Jatin and ChatGPT and stored as versioned rows.
 *
 * §20 requires these to be centralised rather than rewritten by hand each
 * time a piece of content is made. Versioning them additionally makes a change
 * in voice attributable when the learning engine later asks what changed.
 */

import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

export const voiceSchema = z.object({
  /** Short adjectives: how the writing should feel. */
  traits: z.array(nonEmpty).min(1),
  /** Concrete instructions to follow. */
  does: z.array(nonEmpty).default([]),
  /** Concrete things to avoid. Usually more useful than `does`. */
  avoids: z.array(nonEmpty).default([]),
  /** Reference lines showing the voice, not to be reused verbatim. */
  exampleLines: z.array(nonEmpty).default([]),
});

/** §19. Supplied to Gemini when generating character assets. */
export const characterSchema = z.object({
  characterId: nonEmpty,
  appearance: z.string().default(''),
  clothing: z.string().default(''),
  colorPalette: z.array(nonEmpty).default([]),
  visualStyle: z.string().default(''),
  personality: z.string().default(''),
  background: z.string().default(''),
  lighting: z.string().default(''),
});

/** §20. */
export const designSystemSchema = z.object({
  fonts: z.array(nonEmpty).default([]),
  colors: z.array(nonEmpty).default([]),
  logoPath: z.string().nullable().default(null),
  watermarkPath: z.string().nullable().default(null),
  carouselNotes: z.string().default(''),
  reelNotes: z.string().default(''),
});

export const brandConfigSchema = z.object({
  /** §8 keeps the public brand name configurable, so it is never hardcoded. */
  brandName: nonEmpty,
  positioning: nonEmpty,
  audiencePrimary: nonEmpty,
  audienceSecondary: z.string().default(''),

  /** §9. Which language to use when, pending measurement. */
  languagePolicy: z.string().default(''),

  voice: voiceSchema,
  character: characterSchema.nullable().default(null),
  designSystem: designSystemSchema.nullable().default(null),

  /**
   * True while the config is still the seeded placeholder. Briefs generated
   * from a placeholder say so loudly — §57 Risk 1 (generic AI content,
   * severity HIGH) is mitigated by a real brand voice or not at all.
   */
  isPlaceholder: z.boolean().default(false),
});

export type BrandConfig = z.infer<typeof brandConfigSchema>;
export type Voice = z.infer<typeof voiceSchema>;

/**
 * The stricter shape a *production* brand must satisfy.
 *
 * `brandConfigSchema` is permissive because it also has to read back the
 * seeded placeholder and older versions. This one governs the only path that
 * can produce a real brand voice, and it is deliberately unforgiving:
 *
 *   Nothing defaults. A field left blank is a validation failure, not an
 *   empty string quietly stored. The incident this guards against was a
 *   production brand that inherited placeholder content field by field, and
 *   defaults are how that happens silently.
 *
 *   `isPlaceholder` must be literally false. A production brand cannot be
 *   created by omitting the flag and letting a default decide.
 *
 * §4 and §5 still apply: this constrains the *shape* of the answer. The
 * answer itself comes from Jatin and ChatGPT and is not proposed here.
 */
export const productionBrandSchema = z.object({
  brandName: nonEmpty,
  positioning: nonEmpty,
  audiencePrimary: nonEmpty,
  audienceSecondary: nonEmpty,
  languagePolicy: nonEmpty,
  voice: z.object({
    traits: z.array(nonEmpty).min(1),
    does: z.array(nonEmpty).min(1),
    avoids: z.array(nonEmpty).min(1),
    // The single most useful field for generation quality, so a production
    // brand may not ship without at least one.
    exampleLines: z.array(nonEmpty).min(1),
  }),
  character: characterSchema.nullable(),
  designSystem: designSystemSchema.nullable(),
  isPlaceholder: z.literal(false),
});

export function safeParseProductionBrand(
  payload: unknown,
): { ok: true; config: BrandConfig } | { ok: false; error: string } {
  const result = productionBrandSchema.safeParse(payload);
  if (result.success) return { ok: true, config: result.data };
  return {
    ok: false,
    error: result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; '),
  };
}

export function parseBrandConfig(payload: unknown): BrandConfig {
  return brandConfigSchema.parse(payload);
}

export function safeParseBrandConfig(
  payload: unknown,
): { ok: true; config: BrandConfig } | { ok: false; error: string } {
  const result = brandConfigSchema.safeParse(payload);
  if (result.success) return { ok: true, config: result.data };
  return {
    ok: false,
    error: result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; '),
  };
}

/**
 * The seeded placeholder.
 *
 * Deliberately generic and flagged as a placeholder. It exists so the system
 * runs end to end before strategy work is done — not so that strategy work can
 * be skipped. Every brief built from it carries a warning.
 */
export const PLACEHOLDER_BRAND: BrandConfig = {
  brandName: 'Jatin — AI & Technology',
  positioning:
    'Helps people understand what is happening in AI, why it matters, ' +
    'how it affects careers, and how to actually use it.',
  audiencePrimary:
    'Indian audience interested in AI, technology, careers and productivity.',
  audienceSecondary: 'Global English-speaking AI and technology audience.',
  languagePolicy:
    'English by default. Hindi/Hinglish selectively for beginner education, ' +
    'AI careers and India-specific topics. Performance to be measured.',
  voice: {
    traits: ['clear', 'specific', 'useful', 'not hyped'],
    does: [
      'Lead with the concrete development, not a wind-up.',
      'Say plainly why it matters to the reader.',
      'Prefer a real detail over an adjective.',
    ],
    avoids: [
      'Breathless hype and "this changes everything".',
      'Vague claims with no source behind them.',
      'Engagement-bait questions with no substance.',
    ],
    exampleLines: [],
  },
  character: null,
  designSystem: null,
  isPlaceholder: true,
};
