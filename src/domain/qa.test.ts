import { describe, expect, it } from 'vitest';

import { PLATFORM_LIMITS, type QaSubject, runQa } from './qa';

function subject(overrides: Partial<QaSubject> = {}): QaSubject {
  return {
    platform: 'INSTAGRAM',
    format: 'REEL',
    language: 'EN',
    characterMode: 'HUMAN',
    hook: 'A hook.',
    body: 'A body.',
    caption: 'A caption.',
    cta: 'Follow.',
    hashtags: 'ai tech',
    altText: 'Alt text.',
    claims: [{ claimType: 'FACT', verificationStatus: 'VERIFIED' }],
    ...overrides,
  };
}

const codes = (s: QaSubject) => runQa(s).findings.map((f) => f.code);

describe('runQa — a complete item passes', () => {
  it('reports no blockers', () => {
    const report = runQa(subject());
    expect(report.passed).toBe(true);
    expect(report.blockers).toEqual([]);
  });
});

describe('runQa — completeness', () => {
  it('blocks on a missing caption', () => {
    const report = runQa(subject({ caption: null }));
    expect(report.passed).toBe(false);
    expect(report.blockers.map((b) => b.code)).toContain('missing-caption');
  });

  it('blocks when there is no content at all', () => {
    const report = runQa(subject({ caption: null, body: null }));
    expect(report.blockers.map((b) => b.code)).toContain('missing-content');
  });

  it('warns but does not block on a missing hook', () => {
    const report = runQa(subject({ hook: null }));
    expect(report.passed).toBe(true);
    expect(report.warnings.map((w) => w.code)).toContain('missing-hook');
  });

  it('warns on a missing CTA', () => {
    expect(codes(subject({ cta: null }))).toContain('missing-cta');
  });
});

describe('runQa — accessibility', () => {
  it('warns when visual content has no alt text', () => {
    expect(codes(subject({ format: 'CAROUSEL', altText: null }))).toContain(
      'missing-alt-text',
    );
  });

  it('does not ask a text post for alt text', () => {
    expect(
      codes(subject({ platform: 'LINKEDIN', format: 'TEXT', altText: null })),
    ).not.toContain('missing-alt-text');
  });
});

describe('runQa — platform limits', () => {
  it('blocks a caption over the platform limit', () => {
    const long = 'x'.repeat(PLATFORM_LIMITS.INSTAGRAM.captionChars + 1);
    const report = runQa(subject({ caption: long }));
    expect(report.passed).toBe(false);
    expect(report.blockers.map((b) => b.code)).toContain('caption-too-long');
  });

  it('warns when a caption is close to the limit', () => {
    const near = 'x'.repeat(
      Math.floor(PLATFORM_LIMITS.INSTAGRAM.captionChars * 0.95),
    );
    const report = runQa(subject({ caption: near }));
    expect(report.passed).toBe(true);
    expect(report.warnings.map((w) => w.code)).toContain('caption-near-limit');
  });

  it('applies LinkedIn’s higher limit to LinkedIn', () => {
    const between = 'x'.repeat(2500);
    expect(
      runQa(subject({ platform: 'LINKEDIN', format: 'TEXT', caption: between }))
        .blockers.map((b) => b.code),
    ).not.toContain('caption-too-long');
    expect(
      runQa(subject({ caption: between })).blockers.map((b) => b.code),
    ).toContain('caption-too-long');
  });

  it('blocks too many hashtags', () => {
    const many = Array.from({ length: 35 }, (_, i) => `tag${i}`).join(' ');
    expect(
      runQa(subject({ hashtags: many })).blockers.map((b) => b.code),
    ).toContain('too-many-hashtags');
  });

  it('counts hashtags correctly when they are comma-separated', () => {
    const many = Array.from({ length: 35 }, (_, i) => `tag${i}`).join(', ');
    expect(
      runQa(subject({ hashtags: many })).blockers.map((b) => b.code),
    ).toContain('too-many-hashtags');
  });
});

describe('runQa — PRD §7 and §16, the truth policy', () => {
  it('blocks while any claim is unverified', () => {
    const report = runQa(
      subject({
        claims: [
          { claimType: 'FACT', verificationStatus: 'VERIFIED' },
          { claimType: 'FACT', verificationStatus: 'UNVERIFIED' },
        ],
      }),
    );
    expect(report.passed).toBe(false);
    expect(report.blockers.map((b) => b.code)).toContain('unverified-claims');
  });

  it('warns rather than blocks on a disputed claim', () => {
    // Disputed is an examined outcome a writer can frame honestly.
    const report = runQa(
      subject({
        claims: [{ claimType: 'FACT', verificationStatus: 'DISPUTED' }],
      }),
    );
    expect(report.passed).toBe(true);
    expect(report.warnings.map((w) => w.code)).toContain('disputed-claims');
  });

  it('warns when nothing behind the content is a verified fact', () => {
    const report = runQa(
      subject({
        claims: [{ claimType: 'PREDICTION', verificationStatus: 'VERIFIED' }],
      }),
    );
    expect(report.warnings.map((w) => w.code)).toContain('no-verified-facts');
  });

  it('does not complain when there are no claims at all', () => {
    // An opinion piece rests on no external claim; requiring one would make
    // that category unpublishable.
    const report = runQa(subject({ claims: [] }));
    expect(report.passed).toBe(true);
    expect(codes(subject({ claims: [] }))).not.toContain('no-verified-facts');
  });
});

describe('runQa — PRD §51 authenticity', () => {
  it('warns when an AI character has no supplied experience', () => {
    expect(codes(subject({ characterMode: 'AI_CHARACTER' }))).toContain(
      'character-authenticity',
    );
  });

  it('is quiet when the human supplied the experience', () => {
    expect(
      codes(
        subject({
          characterMode: 'HYBRID',
          humanSuppliedExperience: 'I used it for a week.',
        }),
      ),
    ).not.toContain('character-authenticity');
  });

  it('is quiet in HUMAN mode', () => {
    expect(codes(subject())).not.toContain('character-authenticity');
  });
});

describe('runQa — brand', () => {
  it('warns while the brand is a placeholder', () => {
    expect(codes(subject({ brandIsPlaceholder: true }))).toContain(
      'placeholder-brand',
    );
  });
});

describe('runQa — the gate stays credible', () => {
  it('never blocks on anything subjective', () => {
    // A gate that cries wolf gets clicked through, so only objectively
    // wrong things block.
    const objective = new Set([
      'missing-caption',
      'missing-content',
      'caption-too-long',
      'too-many-hashtags',
      'unverified-claims',
    ]);
    const report = runQa(
      subject({
        hook: null,
        cta: null,
        altText: null,
        brandIsPlaceholder: true,
        characterMode: 'AI_CHARACTER',
        claims: [{ claimType: 'FACT', verificationStatus: 'DISPUTED' }],
      }),
    );
    for (const blocker of report.blockers) {
      expect(objective.has(blocker.code), blocker.code).toBe(true);
    }
  });
});
