/**
 * Core content vocabulary — PRD §11 (formats), §9 (language), §18 (character
 * modes), §1 (platforms).
 *
 * These live in the domain, not in the database schema. The schema imports
 * them; they import nothing. That direction is what allows the storage layer
 * to be replaced (§65) without the meaning of "a Reel" or "HYBRID" changing.
 */

/** §1. Instagram and LinkedIn are V1; the others are §55/§56 futures. */
export const PLATFORMS = [
  'INSTAGRAM',
  'LINKEDIN',
  'YOUTUBE_SHORTS',
  'FACEBOOK',
] as const;

export type Platform = (typeof PLATFORMS)[number];

/** §53: V1 ships Instagram and LinkedIn only. */
export const V1_PLATFORMS: readonly Platform[] = ['INSTAGRAM', 'LINKEDIN'];

export function isV1Platform(platform: Platform): boolean {
  return V1_PLATFORMS.includes(platform);
}

/** §11. */
export const CONTENT_FORMATS = [
  'REEL',
  'CAROUSEL',
  'STATIC',
  'TEXT',
  'DOCUMENT',
  'VIDEO',
] as const;

export type ContentFormat = (typeof CONTENT_FORMATS)[number];

/**
 * §11 lists formats per platform. A LinkedIn Reel is not a thing, and the
 * system should refuse to model one rather than generate content for it.
 */
const PLATFORM_FORMATS: Readonly<Record<Platform, readonly ContentFormat[]>> =
  Object.freeze({
    INSTAGRAM: ['REEL', 'CAROUSEL', 'STATIC'],
    LINKEDIN: ['TEXT', 'DOCUMENT', 'STATIC', 'VIDEO'],
    YOUTUBE_SHORTS: ['VIDEO'],
    FACEBOOK: ['STATIC', 'VIDEO', 'TEXT'],
  });

export function supportsFormat(
  platform: Platform,
  format: ContentFormat,
): boolean {
  return PLATFORM_FORMATS[platform].includes(format);
}

export function formatsFor(platform: Platform): readonly ContentFormat[] {
  return PLATFORM_FORMATS[platform];
}

/** §9. Language performance must be measured, so it is a first-class field. */
export const LANGUAGES = ['EN', 'HI', 'HINGLISH'] as const;

export type Language = (typeof LANGUAGES)[number];

/** §18. */
export const CHARACTER_MODES = ['HUMAN', 'AI_CHARACTER', 'HYBRID'] as const;

export type CharacterMode = (typeof CHARACTER_MODES)[number];

/**
 * §51: "AI-generated character content must not falsely claim to depict real
 * events, real experiences, or real statements from Jatin unless those are
 * actually provided by Jatin."
 *
 * So a content item in AI_CHARACTER mode may not assert lived experience
 * unless a human supplied it. The flag travels with the item and is checked
 * before generation and at QA.
 */
export function mayClaimRealExperience(
  mode: CharacterMode,
  experienceSuppliedByHuman: boolean,
): boolean {
  if (mode === 'HUMAN') return true;
  return experienceSuppliedByHuman;
}
