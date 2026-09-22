import { describe, expect, it } from 'vitest';

import {
  disallowedMetricsFor,
  followsPerThousandImpressions,
  metricAllowedForPlatform,
  parseMetrics,
} from './metrics-parse';
import { analyseDimension } from './learning';

/**
 * K — follower attribution.
 *
 * Locked product rule: follower growth is never attributed to an individual
 * post unless the platform explicitly reports it at post level. Account-level
 * changes stay account-level, and nothing infers attribution from timing.
 *
 * This file exists because that rule is easy to state and easy to lose: the
 * failure would not look like a bug, it would look like a confident number.
 */

describe('K — a metric the platform does not report per post is not attributed', () => {
  it('does not read follows from a YouTube Shorts panel', () => {
    // YouTube Shorts is not in the post-level follows list, so a number
    // labelled "Follows" in that panel is not a post metric.
    const parsed = parseMetrics(
      'Views\n10,000\nLikes\n420\nFollows\n137\n',
      'YOUTUBE_SHORTS',
    );

    expect(parsed.metrics.views).toBe(10_000);
    expect(parsed.metrics.likes).toBe(420);
    expect(parsed.metrics.follows).toBeUndefined();
  });

  it('does not read follows from a Facebook panel', () => {
    const parsed = parseMetrics('Reach\n5,000\nFollows\n42\n', 'FACEBOOK');
    expect(parsed.metrics.reach).toBe(5_000);
    expect(parsed.metrics.follows).toBeUndefined();
  });

  it('names the boundary explicitly per platform', () => {
    expect(metricAllowedForPlatform('YOUTUBE_SHORTS', 'follows')).toBe(false);
    expect(metricAllowedForPlatform('FACEBOOK', 'follows')).toBe(false);
  });

  it('reports which requested metrics may not be attributed', () => {
    expect(disallowedMetricsFor('YOUTUBE_SHORTS', ['views', 'follows'])).toEqual([
      'follows',
    ]);
    expect(disallowedMetricsFor('INSTAGRAM', ['views', 'likes'])).toEqual([]);
  });
});

describe('K — absent follower data is absent, never zero', () => {
  it('yields no north-star value when follows were not reported', () => {
    // §40. A post with no reported follows has no follows-per-thousand — it
    // does not have zero, which would read as "reached people and converted
    // none of them".
    expect(followsPerThousandImpressions(null, 10_000)).toBeNull();
    expect(followsPerThousandImpressions(undefined, 10_000)).toBeNull();
  });

  it('yields no value when impressions are missing', () => {
    expect(followsPerThousandImpressions(10, null)).toBeNull();
  });

  it('does not divide by zero impressions', () => {
    expect(followsPerThousandImpressions(10, 0)).toBeNull();
  });

  it('computes only when the platform reported both', () => {
    expect(followsPerThousandImpressions(37, 4210)).toBeCloseTo(8.7886, 3);
  });
});

describe('K — correlation is not attribution', () => {
  it('cannot conclude a segment caused growth, however large the gap', () => {
    // The shape of the forbidden claim: one group has far more follows than
    // the other, over a large sample. Observational analysis may notice it
    // and must stop at HYPOTHESIS (§29).
    const observations = Array.from({ length: 80 }, (_, i) => ({
      contentItemId: i + 1,
      value: i % 2 === 0 ? 50 : 1,
      dimensions: { language: i % 2 === 0 ? 'HINGLISH' : 'EN' },
    }));

    const findings = analyseDimension(observations, 'language', 'follows/1k');

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.status === 'SUPPORTED')).toBe(false);
    expect(findings.every((f) => f.status !== 'SUPPORTED')).toBe(true);
  });

  it('phrases the strongest observational finding as something to test', () => {
    // Real spread within each group, so an interval is computable and the
    // finding can reach the highest rung observation is allowed.
    const observations = Array.from({ length: 80 }, (_, i) => ({
      contentItemId: i + 1,
      value: (i % 2 === 0 ? 50 : 10) + (i % 5),
      dimensions: { language: i % 2 === 0 ? 'HINGLISH' : 'EN' },
    }));

    const finding = analyseDimension(observations, 'language', 'follows/1k')
      .find((f) => f.segment === 'HINGLISH');

    expect(finding?.status).toBe('HYPOTHESIS');
    // Not "caused", not "drives" — worth testing deliberately.
    expect(finding?.summary).toContain('Worth testing deliberately');
    expect(finding?.summary).not.toMatch(/\bcaus/i);
  });

  it('makes no claim at all when a segment has no internal variation', () => {
    // Zero variance means no computable interval, so the system declines to
    // say the difference is unlikely to be noise — even at n=40 a side.
    const observations = Array.from({ length: 80 }, (_, i) => ({
      contentItemId: i + 1,
      value: i % 2 === 0 ? 50 : 1,
      dimensions: { language: i % 2 === 0 ? 'HINGLISH' : 'EN' },
    }));

    const findings = analyseDimension(observations, 'language', 'follows/1k');
    expect(findings.every((f) => f.status === 'OBSERVATION')).toBe(true);
    expect(findings.every((f) => f.interval === null)).toBe(true);
  });

  it('says nothing at all below the minimum sample size', () => {
    const observations = Array.from({ length: 4 }, (_, i) => ({
      contentItemId: i + 1,
      value: i % 2 === 0 ? 50 : 1,
      dimensions: { language: i % 2 === 0 ? 'HINGLISH' : 'EN' },
    }));

    const findings = analyseDimension(observations, 'language', 'follows/1k');
    expect(findings.every((f) => f.status === 'INSUFFICIENT_DATA')).toBe(true);
  });
});
