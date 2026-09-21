import { describe, expect, it } from 'vitest';

import {
  CONFIRMATION_THRESHOLD,
  engagementRate,
  followsPerThousandImpressions,
  needsConfirmation,
  parseDuration,
  parseMetricNumber,
  parseMetrics,
} from './metrics-parse';

describe('parseMetricNumber', () => {
  it('reads plain integers', () => {
    expect(parseMetricNumber('1234')).toBe(1234);
  });

  it('reads thousands separators', () => {
    expect(parseMetricNumber('1,234')).toBe(1234);
    expect(parseMetricNumber('12,345,678')).toBe(12345678);
  });

  it('expands K and M abbreviations', () => {
    expect(parseMetricNumber('1.2K')).toBe(1200);
    expect(parseMetricNumber('15k')).toBe(15000);
    expect(parseMetricNumber('2.5M')).toBe(2500000);
  });

  it('rejects a bare decimal — a fractional count is a mis-read', () => {
    expect(parseMetricNumber('1.5')).toBeNull();
  });

  it('rejects anything that is not a number', () => {
    expect(parseMetricNumber('')).toBeNull();
    expect(parseMetricNumber('abc')).toBeNull();
    expect(parseMetricNumber('12abc')).toBeNull();
    expect(parseMetricNumber('-5')).toBeNull();
  });
});

describe('parseDuration', () => {
  it('reads h/m/s forms', () => {
    expect(parseDuration('1h 23m 45s')).toBe(5025);
    expect(parseDuration('45s')).toBe(45);
    expect(parseDuration('2m')).toBe(120);
  });

  it('reads clock form', () => {
    expect(parseDuration('2:03')).toBe(123);
  });

  it('returns null for anything else', () => {
    expect(parseDuration('later')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });
});

describe('parseMetrics — Instagram panels', () => {
  it('reads a label-above-value layout', () => {
    const text = `
      Accounts reached
      1,234
      Likes
      89
      Comments
      12
      Saves
      45
    `;
    const { metrics } = parseMetrics(text, 'INSTAGRAM');
    expect(metrics.reach).toBe(1234);
    expect(metrics.likes).toBe(89);
    expect(metrics.comments).toBe(12);
    expect(metrics.saves).toBe(45);
  });

  it('reads a value-above-label layout', () => {
    const text = `
      1,234
      Accounts reached
      89
      Likes
    `;
    const { metrics } = parseMetrics(text, 'INSTAGRAM');
    expect(metrics.reach).toBe(1234);
    expect(metrics.likes).toBe(89);
  });

  it('reads inline "Label: value"', () => {
    const { metrics } = parseMetrics(
      'Likes: 234  Comments: 12  Saves: 45',
      'INSTAGRAM',
    );
    expect(metrics.likes).toBe(234);
    expect(metrics.comments).toBe(12);
    expect(metrics.saves).toBe(45);
  });

  it('prefers the more specific label', () => {
    // "Profile visits" must not be read as a bare "visits", and
    // "Accounts reached" must win over "reach".
    const { metrics } = parseMetrics(
      'Accounts reached 5,000\nProfile visits 120',
      'INSTAGRAM',
    );
    expect(metrics.reach).toBe(5000);
    expect(metrics.profileVisits).toBe(120);
  });

  it('reads abbreviated numbers', () => {
    const { metrics } = parseMetrics('Accounts reached\n12.5K', 'INSTAGRAM');
    expect(metrics.reach).toBe(12500);
  });

  it('reads watch time as seconds', () => {
    const { metrics } = parseMetrics('Watch time 1h 20m', 'INSTAGRAM');
    expect(metrics.watchTimeSeconds).toBe(4800);
  });
});

describe('parseMetrics — PRD §40, never inventing a metric', () => {
  it('omits metrics that are not in the text', () => {
    const { metrics } = parseMetrics('Likes 100', 'INSTAGRAM');
    // Absent, not zero. These are different facts.
    expect(metrics.likes).toBe(100);
    expect(metrics.saves).toBeUndefined();
    expect(metrics.follows).toBeUndefined();
  });

  it('never returns zero for something it could not read', () => {
    const { metrics } = parseMetrics('Likes\nnot a number', 'INSTAGRAM');
    expect(metrics.likes).toBeUndefined();
  });

  it('reports a label whose number it could not read', () => {
    const result = parseMetrics('Likes\nnot a number', 'INSTAGRAM');
    expect(result.unreadable).toContain('likes');
  });

  it('does not pair a label with a distant number', () => {
    // A number on the other side of the panel belongs to a different tile.
    const text = 'Likes' + ' '.repeat(80) + '4321';
    expect(parseMetrics(text, 'INSTAGRAM').metrics.likes).toBeUndefined();
  });

  it('does not pair across intervening words', () => {
    const { metrics } = parseMetrics('Likes and other stuff 42', 'INSTAGRAM');
    expect(metrics.likes).toBeUndefined();
  });

  it('never assigns one number to two metrics', () => {
    const { metrics } = parseMetrics('Likes Comments 42', 'INSTAGRAM');
    const assigned = [metrics.likes, metrics.comments].filter(
      (v) => v !== undefined,
    );
    expect(assigned.length).toBeLessThanOrEqual(1);
  });

  it('ignores a metric the platform does not report', () => {
    // §7.1: reading "saves" off LinkedIn would be inventing a capability.
    const { metrics } = parseMetrics('Saves 45\nLikes 10', 'LINKEDIN');
    expect(metrics.saves).toBeUndefined();
    expect(metrics.likes).toBe(10);
  });

  it('does not match a label inside a longer word', () => {
    const { metrics } = parseMetrics('Dislikes 42', 'INSTAGRAM');
    expect(metrics.likes).toBeUndefined();
  });

  it('returns nothing for text with no metrics at all', () => {
    const result = parseMetrics('Good morning, here is your coffee', 'INSTAGRAM');
    expect(Object.keys(result.metrics)).toHaveLength(0);
    expect(result.confidence).toBe(0);
  });

  it('returns nothing for empty input', () => {
    expect(Object.keys(parseMetrics('', 'INSTAGRAM').metrics)).toHaveLength(0);
  });
});

describe('parseMetrics — confidence', () => {
  it('is high for a cleanly read panel', () => {
    const text = `
      Accounts reached 4,210
      Likes 312
      Comments 24
      Saves 88
      Shares 15
    `;
    const result = parseMetrics(text, 'INSTAGRAM');
    expect(result.confidence).toBeGreaterThanOrEqual(CONFIRMATION_THRESHOLD);
    expect(needsConfirmation(result)).toBe(false);
  });

  it('is low when most labels could not be resolved', () => {
    const text = 'Accounts reached\nLikes\nComments\nSaves\nShares 15';
    const result = parseMetrics(text, 'INSTAGRAM');
    expect(needsConfirmation(result)).toBe(true);
  });

  it('is low for a single lonely metric', () => {
    // One number read out of a whole panel is not a confident read.
    const result = parseMetrics('Likes 100', 'INSTAGRAM');
    expect(needsConfirmation(result)).toBe(true);
  });
});

describe('followsPerThousandImpressions — PRD §27', () => {
  it('computes the north-star metric', () => {
    expect(followsPerThousandImpressions(25, 10_000)).toBe(2.5);
  });

  it('is null when follows are unknown', () => {
    // Not zero: unknown conversion and zero conversion are different facts.
    expect(followsPerThousandImpressions(null, 10_000)).toBeNull();
    expect(followsPerThousandImpressions(undefined, 10_000)).toBeNull();
  });

  it('is null when impressions are unknown or zero', () => {
    expect(followsPerThousandImpressions(25, null)).toBeNull();
    expect(followsPerThousandImpressions(25, 0)).toBeNull();
  });

  it('distinguishes high reach from high conversion', () => {
    const viral = followsPerThousandImpressions(10, 100_000);
    const niche = followsPerThousandImpressions(10, 1_000);
    expect(niche).toBeGreaterThan(viral!);
  });
});

describe('engagementRate', () => {
  it('computes against reach when available', () => {
    expect(
      engagementRate({ likes: 80, comments: 10, saves: 10, reach: 1_000 }),
    ).toBe(10);
  });

  it('falls back to impressions when reach is absent', () => {
    expect(engagementRate({ likes: 50, impressions: 1_000 })).toBe(5);
  });

  it('is null when there is no denominator', () => {
    expect(engagementRate({ likes: 50 })).toBeNull();
  });

  it('is null when no engagement metric was reported', () => {
    expect(engagementRate({ reach: 1_000 })).toBeNull();
  });
});
