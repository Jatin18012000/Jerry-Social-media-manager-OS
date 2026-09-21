import { describe, expect, it } from 'vitest';

import {
  CHARACTER_MODES,
  CONTENT_FORMATS,
  LANGUAGES,
  PLATFORMS,
  V1_PLATFORMS,
  formatsFor,
  isV1Platform,
  mayClaimRealExperience,
  supportsFormat,
} from './content';

describe('platforms (PRD §1, §53)', () => {
  it('ships Instagram and LinkedIn in V1, and nothing else', () => {
    expect([...V1_PLATFORMS]).toEqual(['INSTAGRAM', 'LINKEDIN']);
    expect(isV1Platform('INSTAGRAM')).toBe(true);
    expect(isV1Platform('LINKEDIN')).toBe(true);
    expect(isV1Platform('YOUTUBE_SHORTS')).toBe(false);
    expect(isV1Platform('FACEBOOK')).toBe(false);
  });

  it('defines at least one format for every platform', () => {
    for (const platform of PLATFORMS) {
      expect(formatsFor(platform).length, platform).toBeGreaterThan(0);
    }
  });

  it('only ever lists known formats', () => {
    for (const platform of PLATFORMS) {
      for (const format of formatsFor(platform)) {
        expect(CONTENT_FORMATS).toContain(format);
      }
    }
  });
});

describe('platform/format compatibility (PRD §11)', () => {
  it('accepts the formats the PRD lists for Instagram', () => {
    expect(supportsFormat('INSTAGRAM', 'REEL')).toBe(true);
    expect(supportsFormat('INSTAGRAM', 'CAROUSEL')).toBe(true);
    expect(supportsFormat('INSTAGRAM', 'STATIC')).toBe(true);
  });

  it('accepts the formats the PRD lists for LinkedIn', () => {
    expect(supportsFormat('LINKEDIN', 'TEXT')).toBe(true);
    expect(supportsFormat('LINKEDIN', 'DOCUMENT')).toBe(true);
  });

  it('refuses a combination the platform does not have', () => {
    // A LinkedIn Reel is not a thing; the system should refuse to model one
    // rather than generate content for it.
    expect(supportsFormat('LINKEDIN', 'REEL')).toBe(false);
    expect(supportsFormat('INSTAGRAM', 'DOCUMENT')).toBe(false);
  });
});

describe('language (PRD §9)', () => {
  it('supports the three languages whose performance must be measured', () => {
    expect([...LANGUAGES]).toEqual(['EN', 'HI', 'HINGLISH']);
  });
});

describe('character modes and authenticity (PRD §18, §51)', () => {
  it('defines the three modes', () => {
    expect([...CHARACTER_MODES]).toEqual(['HUMAN', 'AI_CHARACTER', 'HYBRID']);
  });

  it('always allows real experience in HUMAN mode', () => {
    expect(mayClaimRealExperience('HUMAN', true)).toBe(true);
    expect(mayClaimRealExperience('HUMAN', false)).toBe(true);
  });

  it('forbids fabricated lived experience in AI_CHARACTER mode', () => {
    // §51: AI-generated character content must not falsely claim to depict
    // real experiences unless Jatin actually provided them.
    expect(mayClaimRealExperience('AI_CHARACTER', false)).toBe(false);
  });

  it('forbids fabricated lived experience in HYBRID mode', () => {
    expect(mayClaimRealExperience('HYBRID', false)).toBe(false);
  });

  it('allows it in AI_CHARACTER and HYBRID when a human supplied it', () => {
    expect(mayClaimRealExperience('AI_CHARACTER', true)).toBe(true);
    expect(mayClaimRealExperience('HYBRID', true)).toBe(true);
  });
});
