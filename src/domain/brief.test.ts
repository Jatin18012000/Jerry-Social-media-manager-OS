import { describe, expect, it } from 'vitest';

import { PLACEHOLDER_BRAND, type BrandConfig } from './brand';
import { type BriefClaim, type BriefInput, composeBrief } from './brief';

const REAL_BRAND: BrandConfig = {
  ...PLACEHOLDER_BRAND,
  brandName: 'Test Brand',
  isPlaceholder: false,
  voice: {
    traits: ['direct', 'concrete'],
    does: ['Lead with the development.'],
    avoids: ['Hype.'],
    exampleLines: ['A reference line.'],
  },
};

const VERIFIED_FACT: BriefClaim = {
  text: 'Company X released Model Y.',
  claimType: 'FACT',
  verificationStatus: 'VERIFIED',
  evidenceUrl: 'https://companyx.example/announcement',
  evidenceTier: 'PRIMARY',
  sourceName: 'Company X Blog',
};

const UNVERIFIED_FACT: BriefClaim = {
  text: 'The model was trained on 20 trillion tokens.',
  claimType: 'FACT',
  verificationStatus: 'UNVERIFIED',
};

const VERIFIED_PREDICTION: BriefClaim = {
  text: 'Adoption will accelerate next year.',
  claimType: 'PREDICTION',
  verificationStatus: 'VERIFIED',
  evidenceUrl: 'https://example.com/analysis',
  evidenceTier: 'CREDIBLE_SECONDARY',
};

function input(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    brand: REAL_BRAND,
    platform: 'INSTAGRAM',
    format: 'REEL',
    language: 'EN',
    characterMode: 'HUMAN',
    opportunityTitle: 'Company X ships Model Y',
    claims: [VERIFIED_FACT],
    ...overrides,
  };
}

describe('composeBrief — structure', () => {
  it('states the platform, format, language and character mode', () => {
    const brief = composeBrief(input());
    expect(brief).toContain('Platform: INSTAGRAM');
    expect(brief).toContain('Format: REEL');
    expect(brief).toContain('Language: EN');
    expect(brief).toContain('Character mode: HUMAN');
  });

  it('includes the output contract so the response can be parsed', () => {
    const brief = composeBrief(input());
    expect(brief).toContain('```json');
    expect(brief).toContain('"hook"');
    expect(brief).toContain('"hashtags"');
  });

  it('includes the thesis and angle when present', () => {
    const brief = composeBrief(
      input({ opportunityThesis: 'The thesis.', angle: 'The angle.' }),
    );
    expect(brief).toContain('The thesis.');
    expect(brief).toContain('The angle.');
  });
});

describe('composeBrief — PRD §7.3, claims are never flattened', () => {
  it('separates verified facts from everything else', () => {
    const brief = composeBrief(
      input({ claims: [VERIFIED_FACT, VERIFIED_PREDICTION] }),
    );
    expect(brief).toContain('may be stated as fact');
    expect(brief).toContain('NOT facts');
  });

  it('labels every claim with its type', () => {
    const brief = composeBrief(
      input({ claims: [VERIFIED_FACT, VERIFIED_PREDICTION] }),
    );
    expect(brief).toContain('[FACT]');
    expect(brief).toContain('[PREDICTION]');
  });

  it('places a verified prediction in context, never among the facts', () => {
    // §7.3: a verified prediction is still a prediction.
    const brief = composeBrief(input({ claims: [VERIFIED_PREDICTION] }));
    const factsIndex = brief.indexOf('## Verified facts');
    const contextIndex = brief.indexOf('## Context');
    expect(contextIndex).toBeGreaterThan(-1);
    expect(
      brief.slice(factsIndex, contextIndex),
    ).toContain('None.');
  });

  it('carries each claim’s source and evidence tier', () => {
    const brief = composeBrief(input());
    expect(brief).toContain('Company X Blog');
    expect(brief).toContain('tier: PRIMARY');
    expect(brief).toContain('https://companyx.example/announcement');
  });

  it('bars unverified claims from being stated as fact', () => {
    const brief = composeBrief(input({ claims: [UNVERIFIED_FACT] }));
    expect(brief).toContain('must NOT be stated as fact');
    expect(brief).toContain('20 trillion tokens');
  });

  it('says plainly when nothing has been verified', () => {
    // §7.4 — better an admitted gap than an implied fact.
    const brief = composeBrief(input({ claims: [UNVERIFIED_FACT] }));
    expect(brief).toContain('must not assert anything as established');
  });

  it('puts the facts before the style instructions', () => {
    const brief = composeBrief(input());
    expect(brief.indexOf('## Verified facts')).toBeLessThan(
      brief.indexOf('## Voice'),
    );
  });
});

describe('composeBrief — PRD §51, authenticity', () => {
  it('adds no authenticity rule for HUMAN mode', () => {
    const brief = composeBrief(input({ characterMode: 'HUMAN' }));
    expect(brief).not.toContain('Authenticity rule');
  });

  it('forbids invented experience in AI_CHARACTER mode', () => {
    const brief = composeBrief(input({ characterMode: 'AI_CHARACTER' }));
    expect(brief).toContain('Authenticity rule');
    expect(brief).toContain('must NOT claim or imply any real experience');
  });

  it('forbids invented experience in HYBRID mode', () => {
    const brief = composeBrief(input({ characterMode: 'HYBRID' }));
    expect(brief).toContain('must NOT claim or imply any real experience');
  });

  it('permits only the experience the human actually supplied', () => {
    const brief = composeBrief(
      input({
        characterMode: 'AI_CHARACTER',
        humanSuppliedExperience: 'I spent a week using it daily.',
      }),
    );
    expect(brief).toContain('I spent a week using it daily.');
    expect(brief).toContain('must not invent any other personal experience');
  });
});

describe('composeBrief — placeholder brand warning', () => {
  it('warns loudly when the brand voice is still a placeholder', () => {
    // §57 Risk 1: generic AI content. Mitigated by a real voice or not at all.
    const brief = composeBrief(input({ brand: PLACEHOLDER_BRAND }));
    expect(brief).toContain('BRAND VOICE NOT YET DEFINED');
  });

  it('does not warn once a real brand config is active', () => {
    expect(composeBrief(input())).not.toContain('BRAND VOICE NOT YET DEFINED');
  });
});

describe('composeBrief — PRD §21, platform framing differs', () => {
  it('gives Instagram and LinkedIn different guidance', () => {
    const ig = composeBrief(input({ platform: 'INSTAGRAM', format: 'REEL' }));
    const li = composeBrief(input({ platform: 'LINKEDIN', format: 'TEXT' }));
    expect(ig).toContain('scrolling');
    expect(li).toContain('analytical');
  });

  it('keeps the underlying facts identical across platforms', () => {
    const ig = composeBrief(input({ platform: 'INSTAGRAM', format: 'REEL' }));
    const li = composeBrief(input({ platform: 'LINKEDIN', format: 'TEXT' }));
    expect(ig).toContain('Company X released Model Y.');
    expect(li).toContain('Company X released Model Y.');
  });

  it('gives format-specific shape instructions', () => {
    expect(composeBrief(input({ format: 'CAROUSEL' }))).toContain('slides');
    expect(composeBrief(input({ format: 'REEL' }))).toContain('spoken');
  });

  it('asks for genuine Hinglish, not English with words swapped', () => {
    const brief = composeBrief(input({ language: 'HINGLISH' }));
    expect(brief).toContain('not English sentences with Hindi words');
  });
});

describe('composeBrief — PRD §29, findings are observations', () => {
  it('presents findings with sample size and confidence', () => {
    const brief = composeBrief(
      input({
        findings: [
          {
            summary: 'Career hooks convert better.',
            sampleSize: 17,
            confidence: 'MEDIUM',
          },
        ],
      }),
    );
    expect(brief).toContain('Observations, not rules');
    expect(brief).toContain('n=17');
    expect(brief).toContain('MEDIUM');
  });

  it('omits the section entirely when there is nothing to say', () => {
    expect(composeBrief(input())).not.toContain('past performance suggests');
  });
});

describe('composeBrief — edge cases', () => {
  it('handles an opportunity with no claims at all', () => {
    const brief = composeBrief(input({ claims: [] }));
    expect(brief).toContain('must not assert anything as established');
  });

  it('omits voice subsections that are empty', () => {
    const bare: BrandConfig = {
      ...REAL_BRAND,
      voice: { traits: ['plain'], does: [], avoids: [], exampleLines: [] },
    };
    const brief = composeBrief(input({ brand: bare }));
    expect(brief).not.toContain('### Do');
    expect(brief).not.toContain('### Avoid');
  });
});
