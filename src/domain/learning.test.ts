import { describe, expect, it } from 'vitest';

import {
  HYPOTHESIS_SAMPLE_SIZE,
  MIN_SAMPLE_SIZE,
  type Observation,
  analyseDimension,
  compareMeans,
  hookPattern,
  mean,
  postingSlot,
  presentable,
  promoteWithExperiment,
  tCritical95,
  variance,
} from './learning';

/** n observations in one segment, all with the given value (+ jitter). */
function group(
  segment: string,
  values: readonly number[],
  startId = 0,
): Observation[] {
  return values.map((value, index) => ({
    contentItemId: startId + index,
    value,
    dimensions: { language: segment },
  }));
}

describe('basic statistics', () => {
  it('computes a mean', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it('returns zero mean for no values', () => {
    expect(mean([])).toBe(0);
  });

  it('computes sample variance with n-1', () => {
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(4.571, 2);
  });

  it('has no variance for a single value', () => {
    expect(variance([5])).toBe(0);
  });
});

describe('tCritical95', () => {
  it('matches the standard table', () => {
    expect(tCritical95(1)).toBeCloseTo(12.706);
    expect(tCritical95(10)).toBeCloseTo(2.228);
    expect(tCritical95(30)).toBeCloseTo(2.042);
  });

  it('approaches the normal critical value for large df', () => {
    expect(tCritical95(500)).toBeCloseTo(1.96);
  });

  it('rounds df down, widening the interval rather than narrowing it', () => {
    // Erring toward a wider interval means erring toward saying less.
    expect(tCritical95(21)).toBe(tCritical95(20));
    expect(tCritical95(21)).toBeGreaterThan(tCritical95(22));
  });
});

describe('compareMeans', () => {
  it('finds no difference between identical groups', () => {
    const result = compareMeans([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
    expect(result.difference).toBe(0);
    expect(result.excludesZero).toBe(false);
  });

  it('detects a large, consistent difference', () => {
    const result = compareMeans(
      [100, 102, 98, 101, 99, 100, 101, 99, 100, 102],
      [10, 12, 8, 11, 9, 10, 11, 9, 10, 12],
    );
    expect(result.difference).toBeGreaterThan(80);
    expect(result.excludesZero).toBe(true);
  });

  it('does not claim a difference when groups overlap heavily', () => {
    const result = compareMeans(
      [10, 50, 30, 20, 40, 15, 45],
      [12, 48, 33, 22, 38, 18, 42],
    );
    expect(result.excludesZero).toBe(false);
  });

  it('produces no interval when a group is too small', () => {
    expect(compareMeans([5], [1, 2, 3]).interval).toBeNull();
  });

  it('produces no interval when both groups are constant', () => {
    // A difference may be real, but nothing can be said about it.
    const result = compareMeans([5, 5, 5], [3, 3, 3]);
    expect(result.interval).toBeNull();
    expect(result.excludesZero).toBe(false);
  });
});

describe('analyseDimension — PRD §29, small samples say nothing', () => {
  it('marks a segment below the minimum as INSUFFICIENT_DATA', () => {
    // §29's own example: three posts cannot establish a language effect.
    const observations = [
      ...group('HINGLISH', [90, 95, 92], 0),
      ...group('EN', [10, 12, 11, 9, 13, 10, 11], 100),
    ];

    const findings = analyseDimension(observations, 'language', 'follows/1k');
    const hinglish = findings.find((f) => f.segment === 'HINGLISH');

    expect(hinglish?.status).toBe('INSUFFICIENT_DATA');
    expect(hinglish?.confidence).toBe('NONE');
  });

  it('never phrases an insufficient finding as a pattern', () => {
    const observations = [
      ...group('HINGLISH', [90, 95, 92], 0),
      ...group('EN', [10, 12, 11, 9, 13, 10, 11], 100),
    ];
    const hinglish = analyseDimension(
      observations,
      'language',
      'follows/1k',
    ).find((f) => f.segment === 'HINGLISH');

    expect(hinglish?.summary).toContain('Not enough data');
    expect(hinglish?.summary).not.toContain('causes');
  });

  it('excludes insufficient findings from what may be shown', () => {
    const observations = [
      ...group('HINGLISH', [90, 95, 92], 0),
      ...group('EN', [10, 12, 11, 9, 13, 10, 11], 100),
    ];
    const shown = presentable(
      analyseDimension(observations, 'language', 'follows/1k'),
    );
    expect(shown.some((f) => f.segment === 'HINGLISH')).toBe(false);
  });

  it('reaches only OBSERVATION at the minimum sample size', () => {
    const observations = [
      ...group('HINGLISH', [90, 95, 92, 88, 94], 0),
      ...group('EN', [10, 12, 11, 9, 13, 10, 11], 100),
    ];
    const hinglish = analyseDimension(
      observations,
      'language',
      'follows/1k',
    ).find((f) => f.segment === 'HINGLISH');

    expect(hinglish?.sampleSize).toBe(MIN_SAMPLE_SIZE);
    expect(hinglish?.status).toBe('OBSERVATION');
    expect(hinglish?.summary).toContain('Too few to treat as a pattern');
  });

  it('reaches HYPOTHESIS with enough data and a clear difference', () => {
    const observations = [
      ...group('HINGLISH', [90, 95, 92, 88, 94, 91, 93, 89, 96, 90], 0),
      ...group('EN', [10, 12, 11, 9, 13, 10, 11, 12, 10, 11], 100),
    ];
    const hinglish = analyseDimension(
      observations,
      'language',
      'follows/1k',
    ).find((f) => f.segment === 'HINGLISH');

    expect(hinglish?.sampleSize).toBeGreaterThanOrEqual(
      HYPOTHESIS_SAMPLE_SIZE,
    );
    expect(hinglish?.status).toBe('HYPOTHESIS');
    expect(hinglish?.summary).toContain('Worth testing deliberately');
  });

  it('stays at OBSERVATION when the difference could be noise', () => {
    const observations = [
      ...group('HINGLISH', [10, 60, 30, 20, 55, 15, 48, 22, 40, 35], 0),
      ...group('EN', [12, 58, 28, 25, 50, 18, 45, 20, 38, 33], 100),
    ];
    const hinglish = analyseDimension(
      observations,
      'language',
      'follows/1k',
    ).find((f) => f.segment === 'HINGLISH');

    expect(hinglish?.status).toBe('OBSERVATION');
  });

  it('never reaches SUPPORTED from observational data alone', () => {
    // However large the effect or the sample: you cannot get causation out
    // of a queue of things you happened to post.
    const observations = [
      ...group('HINGLISH', Array.from({ length: 200 }, (_, i) => 90 + (i % 5)), 0),
      ...group('EN', Array.from({ length: 200 }, (_, i) => 10 + (i % 5)), 1000),
    ];
    const findings = analyseDimension(observations, 'language', 'follows/1k');
    expect(findings.every((f) => f.status !== 'SUPPORTED')).toBe(true);
  });

  it('marks a segment insufficient when the baseline is too small', () => {
    const observations = [
      ...group('HINGLISH', [90, 95, 92, 88, 94, 91, 93], 0),
      ...group('EN', [10, 12], 100),
    ];
    const hinglish = analyseDimension(
      observations,
      'language',
      'follows/1k',
    ).find((f) => f.segment === 'HINGLISH');
    expect(hinglish?.status).toBe('INSUFFICIENT_DATA');
  });

  it('ignores observations with no value for the dimension', () => {
    const observations: Observation[] = [
      ...group('EN', [10, 11, 12, 13, 14], 0),
      { contentItemId: 99, value: 50, dimensions: { language: null } },
    ];
    const findings = analyseDimension(observations, 'language', 'follows/1k');
    expect(findings.map((f) => f.segment)).toEqual(['EN']);
  });

  it('compares a segment against the others, not against itself', () => {
    // Including a segment in its own baseline understates every difference.
    const observations = [
      ...group('A', [100, 100, 100, 100, 100], 0),
      ...group('B', [0, 0, 0, 0, 0], 100),
    ];
    const a = analyseDimension(observations, 'language', 'm').find(
      (f) => f.segment === 'A',
    );
    expect(a?.baselineMean).toBe(0);
    expect(a?.segmentMean).toBe(100);
  });

  it('returns nothing for no observations', () => {
    expect(analyseDimension([], 'language', 'm')).toEqual([]);
  });

  it('ranks findings that say something above those that do not', () => {
    const observations = [
      ...group('HINGLISH', [90, 95], 0),
      ...group('EN', [10, 12, 11, 9, 13, 10, 11], 100),
      ...group('HI', [50, 52, 48, 51, 49, 50, 53], 200),
    ];
    const findings = analyseDimension(observations, 'language', 'm');
    expect(findings[findings.length - 1]?.status).toBe('INSUFFICIENT_DATA');
  });
});

describe('promoteWithExperiment — PRD §30, the only route to SUPPORTED', () => {
  const finding = {
    dimension: 'language',
    segment: 'HINGLISH',
    metric: 'follows/1k',
    sampleSize: 20,
    segmentMean: 90,
    baselineMean: 10,
    baselineSize: 20,
    effectSize: 800,
    interval: [60, 100] as [number, number],
    confidence: 'MEDIUM' as const,
    status: 'HYPOTHESIS' as const,
    summary: 'x',
  };

  it('promotes on a concluded, matching experiment', () => {
    const promoted = promoteWithExperiment(finding, {
      hypothesis: 'Hinglish converts better',
      metric: 'follows/1k',
      minSampleSize: 20,
      concluded: true,
    });
    expect(promoted.status).toBe('SUPPORTED');
    expect(promoted.summary).toContain('An experiment found');
  });

  it('refuses an experiment that has not concluded', () => {
    expect(() =>
      promoteWithExperiment(finding, {
        hypothesis: 'x',
        metric: 'follows/1k',
        minSampleSize: 20,
        concluded: false,
      }),
    ).toThrow(/proves nothing/);
  });

  it('refuses an experiment that measured something else', () => {
    // §30 fixes the metric before the run precisely to stop this.
    expect(() =>
      promoteWithExperiment(finding, {
        hypothesis: 'x',
        metric: 'engagement',
        minSampleSize: 20,
        concluded: true,
      }),
    ).toThrow(/measured engagement/);
  });

  it('refuses when the pre-registered sample size was not reached', () => {
    expect(() =>
      promoteWithExperiment(finding, {
        hypothesis: 'x',
        metric: 'follows/1k',
        minSampleSize: 50,
        concluded: true,
      }),
    ).toThrow(/pre-registered/);
  });
});

describe('postingSlot', () => {
  it('buckets by IST time of day', () => {
    // 04:30 UTC is 10:00 IST.
    expect(postingSlot(new Date('2026-09-21T04:30:00Z'))).toBe(
      'morning (06-12)',
    );
    // 14:00 UTC is 19:30 IST.
    expect(postingSlot(new Date('2026-09-21T14:00:00Z'))).toBe(
      'evening (17-21)',
    );
  });

  it('uses coarse buckets so segments can reach a usable size', () => {
    const slots = new Set(
      Array.from({ length: 24 }, (_, h) =>
        postingSlot(new Date(`2026-09-21T${String(h).padStart(2, '0')}:00:00Z`)),
      ),
    );
    expect(slots.size).toBeLessThanOrEqual(5);
  });
});

describe('hookPattern', () => {
  it('recognises a listicle', () => {
    expect(hookPattern('5 AI jobs that pay well')).toBe('listicle');
  });

  it('recognises a question', () => {
    expect(hookPattern('Is AI coming for your job?')).toBe('question');
  });

  it('recognises an explainer', () => {
    expect(hookPattern('How retrieval augmentation actually works')).toBe(
      'explainer',
    );
  });

  it('recognises news', () => {
    expect(hookPattern('OpenAI just released a new model')).toBe('news');
  });

  it('recognises an imperative', () => {
    expect(hookPattern('Stop using AI this way')).toBe('imperative');
  });

  it('falls back to statement', () => {
    expect(hookPattern('The model is faster than its predecessor')).toBe(
      'statement',
    );
  });

  it('returns null for nothing', () => {
    expect(hookPattern(null)).toBeNull();
    expect(hookPattern('  ')).toBeNull();
  });
});
