/**
 * The learning engine — PRD §28, §29, §30, §67.
 *
 * §67 is the most important rule in the PRD: "Do not build a machine that
 * produces content. Build a machine that learns how to produce better
 * content." This module is where that is either honoured or quietly
 * abandoned, so its constraints are deliberately strict.
 *
 * §29 is explicit that the system must distinguish observation from causal
 * conclusion, and must not claim "Hinglish causes growth" from three posts.
 * Three rules enforce that:
 *
 *   1. Below a minimum sample size, a finding is INSUFFICIENT_DATA and is
 *      never rendered as a conclusion anywhere.
 *   2. Observational data can reach HYPOTHESIS at most. It can never reach
 *      SUPPORTED, however large the effect or the sample — you cannot get
 *      causation out of a queue of things you happened to post.
 *   3. SUPPORTED is reachable only through a pre-registered experiment
 *      (§30), whose metric and minimum sample size were fixed before it ran.
 *
 * The statistics are real but modest: a Welch t-interval on the difference of
 * two means. It is honest about small samples, which is the situation this
 * system will be in for months.
 *
 * Pure: no database, no framework.
 */

export type FindingStatus =
  | 'INSUFFICIENT_DATA'
  | 'OBSERVATION'
  | 'HYPOTHESIS'
  | 'SUPPORTED';

export type Confidence = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

/** One measured content item, reduced to the dimensions §28 analyses by. */
export interface Observation {
  readonly contentItemId: number;
  /** The metric being analysed. Items missing it are excluded, not zeroed. */
  readonly value: number;
  readonly dimensions: Readonly<Record<string, string | null>>;
}

export interface Finding {
  readonly dimension: string;
  readonly segment: string;
  readonly metric: string;
  readonly sampleSize: number;
  /** Mean of this segment. */
  readonly segmentMean: number;
  /** Mean of everything else, for comparison. */
  readonly baselineMean: number;
  readonly baselineSize: number;
  /** Relative difference against the baseline, as a percentage. */
  readonly effectSize: number;
  /** 95% interval on the absolute difference. Null when incomputable. */
  readonly interval: readonly [number, number] | null;
  readonly confidence: Confidence;
  readonly status: FindingStatus;
  readonly summary: string;
}

/**
 * Below this, nothing is said at all.
 *
 * §29's own example is that three posts cannot establish a language effect.
 * Five is still very few — which is why five only ever reaches OBSERVATION.
 */
export const MIN_SAMPLE_SIZE = 5;

/** Below this, a finding cannot be phrased as a hypothesis. */
export const HYPOTHESIS_SAMPLE_SIZE = 10;

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Sample variance (n−1). Zero for fewer than two values. */
export function variance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return (
    values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1)
  );
}

/**
 * Two-sided 95% critical values of the t distribution.
 *
 * A lookup table rather than an implementation of the inverse CDF: the range
 * that matters here is small samples, the values are standard, and a table is
 * auditable in a way an approximation is not.
 */
const T_CRITICAL_95: Readonly<Record<number, number>> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
  6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145, 15: 2.131,
  16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086,
  22: 2.074, 24: 2.064, 26: 2.056, 28: 2.048, 30: 2.042,
  40: 2.021, 60: 2.0, 120: 1.98,
};

export function tCritical95(df: number): number {
  if (df < 1) return T_CRITICAL_95[1]!;
  const keys = Object.keys(T_CRITICAL_95)
    .map(Number)
    .sort((a, b) => a - b);

  // Round *down* to the nearest tabulated df, which gives a wider interval.
  // Erring toward a wider interval means erring toward saying less.
  let chosen = keys[0]!;
  for (const key of keys) {
    if (key <= df) chosen = key;
  }
  if (df > 120) return 1.96;
  return T_CRITICAL_95[chosen]!;
}

export interface Comparison {
  readonly difference: number;
  readonly interval: readonly [number, number] | null;
  /** True when the 95% interval excludes zero. */
  readonly excludesZero: boolean;
}

/**
 * Welch's t-interval on the difference between two sample means.
 *
 * Welch rather than Student because the two groups will have wildly different
 * sizes and variances — comparing nine Reels against two hundred of
 * everything else is the normal case here, not the exception.
 */
export function compareMeans(
  a: readonly number[],
  b: readonly number[],
): Comparison {
  const difference = mean(a) - mean(b);

  if (a.length < 2 || b.length < 2) {
    return { difference, interval: null, excludesZero: false };
  }

  const varA = variance(a);
  const varB = variance(b);
  const seSquared = varA / a.length + varB / b.length;

  if (seSquared <= 0) {
    // Both groups are constant. A difference may be real but no interval is
    // computable, so no claim is made about it.
    return { difference, interval: null, excludesZero: false };
  }

  const se = Math.sqrt(seSquared);

  // Welch–Satterthwaite degrees of freedom.
  const df =
    seSquared ** 2 /
    ((varA / a.length) ** 2 / (a.length - 1) +
      (varB / b.length) ** 2 / (b.length - 1));

  const margin = tCritical95(Math.floor(df)) * se;
  const interval: [number, number] = [difference - margin, difference + margin];

  return {
    difference,
    interval,
    excludesZero: interval[0] > 0 || interval[1] < 0,
  };
}

function confidenceFor(
  sampleSize: number,
  excludesZero: boolean,
): Confidence {
  if (sampleSize < MIN_SAMPLE_SIZE) return 'NONE';
  if (!excludesZero) return 'LOW';
  if (sampleSize < HYPOTHESIS_SAMPLE_SIZE) return 'LOW';
  if (sampleSize < 30) return 'MEDIUM';
  return 'HIGH';
}

function statusFor(
  sampleSize: number,
  baselineSize: number,
  excludesZero: boolean,
): FindingStatus {
  if (sampleSize < MIN_SAMPLE_SIZE || baselineSize < MIN_SAMPLE_SIZE) {
    return 'INSUFFICIENT_DATA';
  }
  if (sampleSize >= HYPOTHESIS_SAMPLE_SIZE && excludesZero) {
    return 'HYPOTHESIS';
  }
  return 'OBSERVATION';
  // SUPPORTED is unreachable from here by design. See promoteWithExperiment.
}

function describe(finding: Omit<Finding, 'summary'>): string {
  const direction = finding.effectSize >= 0 ? 'higher' : 'lower';
  const magnitude = Math.abs(finding.effectSize).toFixed(0);

  switch (finding.status) {
    case 'INSUFFICIENT_DATA':
      return `Not enough data on ${finding.dimension} "${finding.segment}" to say anything (n=${finding.sampleSize}).`;
    case 'OBSERVATION':
      return `${finding.segment} has averaged ${magnitude}% ${direction} ${finding.metric} than the rest, across ${finding.sampleSize} posts. Too few to treat as a pattern.`;
    case 'HYPOTHESIS':
      return `${finding.segment} has averaged ${magnitude}% ${direction} ${finding.metric} than the rest across ${finding.sampleSize} posts, and the difference is unlikely to be noise. Worth testing deliberately.`;
    case 'SUPPORTED':
      return `An experiment found ${finding.segment} produces ${magnitude}% ${direction} ${finding.metric} (n=${finding.sampleSize}).`;
  }
}

export interface AnalyseOptions {
  readonly minSampleSize?: number;
}

/**
 * Analyses one dimension, producing a finding per segment.
 *
 * Each segment is compared against every *other* observation rather than
 * against the overall mean, because a segment is part of its own overall mean
 * and comparing against it understates every difference.
 */
export function analyseDimension(
  observations: readonly Observation[],
  dimension: string,
  metric: string,
  opts: AnalyseOptions = {},
): Finding[] {
  const minSample = opts.minSampleSize ?? MIN_SAMPLE_SIZE;

  const segments = new Map<string, Observation[]>();
  for (const observation of observations) {
    const segment = observation.dimensions[dimension];
    if (segment === null || segment === undefined) continue;
    const list = segments.get(segment) ?? [];
    list.push(observation);
    segments.set(segment, list);
  }

  const findings: Finding[] = [];

  for (const [segment, members] of segments) {
    const memberIds = new Set(members.map((m) => m.contentItemId));
    const others = observations.filter(
      (o) =>
        !memberIds.has(o.contentItemId) &&
        o.dimensions[dimension] !== null &&
        o.dimensions[dimension] !== undefined,
    );

    const segmentValues = members.map((m) => m.value);
    const baselineValues = others.map((o) => o.value);

    const segmentMean = mean(segmentValues);
    const baselineMean = mean(baselineValues);

    const comparison = compareMeans(segmentValues, baselineValues);

    const effectSize =
      baselineMean === 0
        ? 0
        : ((segmentMean - baselineMean) / Math.abs(baselineMean)) * 100;

    const status =
      members.length < minSample || others.length < minSample
        ? 'INSUFFICIENT_DATA'
        : statusFor(members.length, others.length, comparison.excludesZero);

    const base: Omit<Finding, 'summary'> = {
      dimension,
      segment,
      metric,
      sampleSize: members.length,
      segmentMean: Number(segmentMean.toFixed(4)),
      baselineMean: Number(baselineMean.toFixed(4)),
      baselineSize: others.length,
      effectSize: Number(effectSize.toFixed(2)),
      interval: comparison.interval
        ? [
            Number(comparison.interval[0].toFixed(4)),
            Number(comparison.interval[1].toFixed(4)),
          ]
        : null,
      confidence:
        status === 'INSUFFICIENT_DATA'
          ? 'NONE'
          : confidenceFor(members.length, comparison.excludesZero),
      status,
    };

    findings.push({ ...base, summary: describe(base) });
  }

  // Largest absolute effect first, but never let an INSUFFICIENT_DATA finding
  // outrank one that says something.
  return findings.sort((a, b) => {
    const rank = (f: Finding) => (f.status === 'INSUFFICIENT_DATA' ? 1 : 0);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return Math.abs(b.effectSize) - Math.abs(a.effectSize);
  });
}

/** The §28 dimensions. */
export const DIMENSIONS = [
  'platform',
  'format',
  'language',
  'pillar',
  'characterMode',
  'hookPattern',
  'postingHour',
] as const;

export function analyseAll(
  observations: readonly Observation[],
  metric: string,
  opts: AnalyseOptions = {},
): Finding[] {
  return DIMENSIONS.flatMap((dimension) =>
    analyseDimension(observations, dimension, metric, opts),
  );
}

/**
 * Only findings that may be shown as something the system believes.
 *
 * §29: an INSUFFICIENT_DATA finding is never rendered as a conclusion
 * anywhere. This is the filter that makes that true rather than aspirational,
 * and every UI and brief reads through it.
 */
export function presentable(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.status !== 'INSUFFICIENT_DATA');
}

/**
 * Promotes a finding to SUPPORTED on the strength of a completed experiment.
 *
 * This is the only route to SUPPORTED. §30 requires a hypothesis, a metric
 * and a minimum sample size fixed *before* the test runs, precisely so the
 * result cannot be reinterpreted afterwards — which is exactly what
 * observational analysis invites.
 */
export function promoteWithExperiment(
  finding: Finding,
  experiment: {
    readonly hypothesis: string;
    readonly metric: string;
    readonly minSampleSize: number;
    readonly concluded: boolean;
  },
): Finding {
  if (!experiment.concluded) {
    throw new Error('An experiment that has not concluded proves nothing.');
  }
  if (experiment.metric !== finding.metric) {
    throw new Error(
      `The experiment measured ${experiment.metric}, not ${finding.metric}.`,
    );
  }
  if (finding.sampleSize < experiment.minSampleSize) {
    throw new Error(
      `The experiment pre-registered n>=${experiment.minSampleSize}; only ${finding.sampleSize} were collected.`,
    );
  }

  const promoted = { ...finding, status: 'SUPPORTED' as const };
  return { ...promoted, summary: describe(promoted) };
}

/**
 * Buckets a posting time into a coarse slot — §28 "posting time".
 *
 * Coarse on purpose: with dozens of posts rather than thousands, 24 hourly
 * buckets would put every segment under the minimum sample size and the
 * dimension would never say anything at all.
 */
export function postingSlot(date: Date, timeZone = 'Asia/Kolkata'): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hour12: false,
      timeZone,
    }).format(date),
  );

  if (hour < 6) return 'night (00-06)';
  if (hour < 12) return 'morning (06-12)';
  if (hour < 17) return 'afternoon (12-17)';
  if (hour < 21) return 'evening (17-21)';
  return 'late (21-24)';
}

/**
 * Classifies a hook into a coarse pattern — §28 "hook".
 *
 * Same reasoning as posting slots: a few recognisable shapes accumulate
 * enough samples to say something, where free text never would.
 */
export function hookPattern(hook: string | null): string | null {
  if (!hook || !hook.trim()) return null;
  const text = hook.trim();
  const lower = text.toLowerCase();

  if (/^\d+\s/.test(text) || /^\d+\s*(ways|things|tips|jobs|tools)/i.test(text)) {
    return 'listicle';
  }
  if (text.includes('?')) return 'question';
  if (/^(how|why|what|when|where)\b/i.test(lower)) return 'explainer';
  if (/\b(just|now|today|breaking|announced|released)\b/i.test(lower)) {
    return 'news';
  }
  if (/^(stop|start|don't|do not|never|always)\b/i.test(lower)) {
    return 'imperative';
  }
  return 'statement';
}
