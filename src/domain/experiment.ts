/**
 * Pre-registered experiments — PRD §30.
 *
 * §29 caps observational analysis at HYPOTHESIS: you cannot get causation out
 * of a queue of things you happened to post. §30 is the only route past that,
 * and it works by fixing the claim *before* the data exists.
 *
 * That ordering is the entire mechanism, so this module is mostly refusals.
 * Six rules, each closing a specific way a pre-registered test degrades into
 * an observational one wearing its clothes:
 *
 *   1. A hypothesis, a metric, two named arms and a minimum sample size are
 *      all required before the experiment may start.
 *   2. Once it is RUNNING, none of those may change. An experiment whose
 *      metric can be edited after the numbers arrive pre-registers nothing.
 *   3. The arms are a *control* and a *treatment*, so the direction of the
 *      claim is fixed by construction. An experiment that does not say in
 *      advance which way it expects the effect to go cannot be wrong.
 *   4. The minimum sample size is per arm, not in total. "n>=10" satisfied by
 *      a nine-one split establishes nothing.
 *   5. It cannot be concluded before both arms reach that minimum. Stopping
 *      the moment the result looks good is optional stopping, and it
 *      manufactures significance out of noise.
 *   6. A null result is a result. NOT_SUPPORTED and INCONCLUSIVE are verdicts
 *      the system records and shows, because an OS that can only conclude in
 *      favour of its own hypotheses is a machine for confirming them.
 *
 * Pure: no database, no framework.
 */

import {
  type Confidence,
  type Finding,
  compareMeans,
  mean,
  promoteWithExperiment,
} from './learning';

export type ExperimentStatus = 'DRAFT' | 'RUNNING' | 'CONCLUDED' | 'ABANDONED';

/**
 * The verdict of a concluded experiment.
 *
 * REFUTED is deliberately distinct from INCONCLUSIVE. "The effect went the
 * other way" and "we could not tell" are different pieces of knowledge, and
 * flattening them would lose the more valuable one (§7.3's reasoning applied
 * to results rather than claims).
 */
export type Verdict = 'SUPPORTED' | 'REFUTED' | 'INCONCLUSIVE';

export const TRANSITIONS: Readonly<Record<ExperimentStatus, readonly ExperimentStatus[]>> = {
  DRAFT: ['RUNNING', 'ABANDONED'],
  RUNNING: ['CONCLUDED', 'ABANDONED'],
  // Terminal. A concluded experiment is a record of what was tested and what
  // came out; reopening it to add data is how a result gets reinterpreted.
  CONCLUDED: [],
  ABANDONED: [],
};

export function canTransition(
  from: ExperimentStatus,
  to: ExperimentStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Smallest number of items per arm the system will accept as a floor. */
export const MIN_ARM_SAMPLE_SIZE = 5;

export interface Arm {
  readonly name: string;
  readonly description: string;
}

/**
 * What is fixed before the experiment runs.
 *
 * Stored as JSON in `experiments.variant_definition` and never rewritten once
 * the experiment is RUNNING.
 */
export interface PreRegistration {
  readonly hypothesis: string;
  readonly metric: string;
  readonly control: Arm;
  readonly treatment: Arm;
  /** Per arm, not in total (rule 4). */
  readonly minSampleSize: number;
}

export class ExperimentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExperimentError';
  }
}

// ---------------------------------------------------------------------------
// Pre-registration
// ---------------------------------------------------------------------------

export interface PreRegistrationInput {
  readonly hypothesis?: string | null;
  readonly metric?: string | null;
  readonly controlName?: string | null;
  readonly controlDescription?: string | null;
  readonly treatmentName?: string | null;
  readonly treatmentDescription?: string | null;
  readonly minSampleSize?: number | null;
}

/**
 * Validates a pre-registration, or says exactly what is missing.
 *
 * Returns errors as a list rather than throwing on the first one: this is
 * filled in by a human on a form, and being told one problem at a time is a
 * poor way to find out there were four.
 */
export function validatePreRegistration(
  input: PreRegistrationInput,
  allowedMetrics: readonly string[],
): { ok: true; value: PreRegistration } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const hypothesis = (input.hypothesis ?? '').trim();
  const metric = (input.metric ?? '').trim();
  const controlName = (input.controlName ?? '').trim();
  const treatmentName = (input.treatmentName ?? '').trim();
  const controlDescription = (input.controlDescription ?? '').trim();
  const treatmentDescription = (input.treatmentDescription ?? '').trim();
  const minSampleSize = input.minSampleSize ?? 0;

  // A hypothesis has to be a claim, not a topic. There is no way to enforce
  // that mechanically, but a one-word "hypothesis" is certainly not one.
  if (hypothesis.length < 15) {
    errors.push(
      'State the hypothesis as a claim that could turn out to be false ' +
        '(at least 15 characters).',
    );
  }

  if (!metric) {
    errors.push('Pick the metric this experiment measures.');
  } else if (!allowedMetrics.includes(metric)) {
    // An experiment measuring something the engine cannot compute could never
    // be concluded, so it must not be startable.
    errors.push(
      `"${metric}" is not a metric this system computes. ` +
        `Pick one of: ${allowedMetrics.join(', ')}.`,
    );
  }

  if (!controlName) errors.push('Name the control arm.');
  if (!treatmentName) errors.push('Name the treatment arm.');
  if (
    controlName &&
    treatmentName &&
    controlName.toLowerCase() === treatmentName.toLowerCase()
  ) {
    errors.push('The control and treatment arms must be different.');
  }

  if (!controlDescription) {
    errors.push('Describe what the control arm does, so it can be reproduced.');
  }
  if (!treatmentDescription) {
    errors.push(
      'Describe what the treatment arm does, so it can be reproduced.',
    );
  }

  if (!Number.isInteger(minSampleSize) || minSampleSize < MIN_ARM_SAMPLE_SIZE) {
    errors.push(
      `The minimum sample size must be a whole number of at least ` +
        `${MIN_ARM_SAMPLE_SIZE} per arm.`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      hypothesis,
      metric,
      control: { name: controlName, description: controlDescription },
      treatment: { name: treatmentName, description: treatmentDescription },
      minSampleSize,
    },
  };
}

/** Serialises the arms for storage. */
export function encodeArms(pre: PreRegistration): string {
  return JSON.stringify({ control: pre.control, treatment: pre.treatment });
}

/**
 * Reads the arms back.
 *
 * Throws rather than guessing. A stored definition that cannot be read means
 * the experiment's pre-registration is unknown, and an experiment whose terms
 * are unknown must not be concluded on any terms at all.
 */
export function decodeArms(raw: string): { control: Arm; treatment: Arm } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExperimentError('The stored arm definition is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ExperimentError('The stored arm definition is not an object.');
  }

  const record = parsed as Record<string, unknown>;
  const arm = (key: string): Arm => {
    const value = record[key];
    if (typeof value !== 'object' || value === null) {
      throw new ExperimentError(`The stored definition has no ${key} arm.`);
    }
    const inner = value as Record<string, unknown>;
    if (typeof inner['name'] !== 'string' || !inner['name'].trim()) {
      throw new ExperimentError(`The ${key} arm has no name.`);
    }
    return {
      name: inner['name'],
      description:
        typeof inner['description'] === 'string' ? inner['description'] : '',
    };
  };

  return { control: arm('control'), treatment: arm('treatment') };
}

/** Which arm a variant name refers to, or null when it matches neither. */
export function armFor(
  arms: { control: Arm; treatment: Arm },
  variant: string,
): 'control' | 'treatment' | null {
  const name = variant.trim().toLowerCase();
  if (name === arms.control.name.trim().toLowerCase()) return 'control';
  if (name === arms.treatment.name.trim().toLowerCase()) return 'treatment';
  // A typo must not silently create a third arm nobody pre-registered.
  return null;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * Whether an experiment may take on another content item.
 *
 * Only while RUNNING. Assigning to a DRAFT would mean data existed before the
 * terms were fixed, and assigning to a CONCLUDED one would mean adding data
 * after the verdict.
 */
export function mayAssign(status: ExperimentStatus): boolean {
  return status === 'RUNNING';
}

// ---------------------------------------------------------------------------
// Conclusion
// ---------------------------------------------------------------------------

export interface ArmResult {
  readonly name: string;
  readonly sampleSize: number;
  readonly mean: number;
}

export interface Conclusion {
  readonly verdict: Verdict;
  readonly metric: string;
  readonly control: ArmResult;
  readonly treatment: ArmResult;
  /** Relative difference of treatment against control, as a percentage. */
  readonly effectSize: number | null;
  readonly interval: readonly [number, number] | null;
  readonly confidence: Confidence;
  readonly summary: string;
}

/** Why an experiment cannot be concluded yet, or null when it can. */
export function blocksConclusion(
  pre: PreRegistration,
  controlValues: readonly number[],
  treatmentValues: readonly number[],
): string | null {
  const short: string[] = [];
  if (controlValues.length < pre.minSampleSize) {
    short.push(
      `${pre.control.name} has ${controlValues.length} of ${pre.minSampleSize}`,
    );
  }
  if (treatmentValues.length < pre.minSampleSize) {
    short.push(
      `${pre.treatment.name} has ${treatmentValues.length} of ${pre.minSampleSize}`,
    );
  }

  if (short.length === 0) return null;

  // Rule 5. This refusal is the difference between a test and a search for a
  // moment when the numbers happen to agree with you.
  return (
    `Not enough measured posts yet: ${short.join(', ')}. ` +
    `The minimum was fixed at ${pre.minSampleSize} per arm before the ` +
    `experiment started, and concluding early would mean stopping when the ` +
    `answer looked right.`
  );
}

/**
 * Treatment against control as a percentage, or null when that is meaningless.
 *
 * Exact zero is not the only unusable baseline. A control mean of 3e-8 is
 * effectively zero, and dividing by it yields "150,499,900% higher" — a
 * number that is arithmetically correct and tells the reader nothing. So the
 * baseline is treated as zero whenever it is a negligible fraction of the
 * larger arm, and the absolute means are reported instead.
 *
 * The verdict never depends on this. That comes from the interval, which does
 * not care how close to zero either mean sits.
 */
function relativeEffect(treatmentMean: number, controlMean: number): number | null {
  const scale = Math.max(Math.abs(controlMean), Math.abs(treatmentMean));
  if (scale === 0) return null;
  if (Math.abs(controlMean) < scale / 100) return null;
  return ((treatmentMean - controlMean) / Math.abs(controlMean)) * 100;
}

/**
 * Concludes an experiment on its pre-registered terms.
 *
 * Refuses outright if the sample sizes are short, rather than returning a
 * weaker verdict — a verdict computed on terms other than the registered ones
 * is not a result of this experiment.
 */
export function concludeExperiment(
  pre: PreRegistration,
  controlValues: readonly number[],
  treatmentValues: readonly number[],
): Conclusion {
  const blocked = blocksConclusion(pre, controlValues, treatmentValues);
  if (blocked) throw new ExperimentError(blocked);

  const controlMean = mean(controlValues);
  const treatmentMean = mean(treatmentValues);
  const comparison = compareMeans(treatmentValues, controlValues);
  const effectSize = relativeEffect(treatmentMean, controlMean);

  const control: ArmResult = {
    name: pre.control.name,
    sampleSize: controlValues.length,
    mean: controlMean,
  };
  const treatment: ArmResult = {
    name: pre.treatment.name,
    sampleSize: treatmentValues.length,
    mean: treatmentMean,
  };

  let verdict: Verdict;
  if (!comparison.excludesZero) {
    verdict = 'INCONCLUSIVE';
  } else if (comparison.difference > 0) {
    verdict = 'SUPPORTED';
  } else {
    verdict = 'REFUTED';
  }

  // The smallest arm governs. A confident-looking interval built on one arm of
  // six is confident about very little.
  const smallest = Math.min(controlValues.length, treatmentValues.length);
  const confidence: Confidence =
    verdict === 'INCONCLUSIVE'
      ? 'LOW'
      : smallest >= 30
        ? 'HIGH'
        : smallest >= 10
          ? 'MEDIUM'
          : 'LOW';

  return {
    verdict,
    metric: pre.metric,
    control,
    treatment,
    effectSize,
    interval: comparison.interval,
    confidence,
    summary: summarise(pre, verdict, control, treatment, effectSize),
  };
}

/**
 * How the size of the difference is phrased.
 *
 * A percentage when there is a usable baseline, the two means when there is
 * not. An unreportable percentage is never filled in with a placeholder that
 * reads like a measurement.
 */
function magnitude(
  effectSize: number | null,
  control: ArmResult,
  treatment: ArmResult,
): string {
  if (effectSize !== null) return `${Math.abs(effectSize).toFixed(0)}%`;
  return (
    `${treatment.mean.toFixed(2)} against ${control.mean.toFixed(2)}, too ` +
    `close to zero for a percentage to mean anything`
  );
}

function summarise(
  pre: PreRegistration,
  verdict: Verdict,
  control: ArmResult,
  treatment: ArmResult,
  effectSize: number | null,
): string {
  const n = `n=${control.sampleSize} vs ${treatment.sampleSize}`;
  const size = magnitude(effectSize, control, treatment);
  const registered =
    'The experiment was registered before the data existed, so this is a ' +
    'tested result rather than a pattern noticed afterwards.';

  switch (verdict) {
    case 'SUPPORTED':
      return effectSize !== null
        ? `${treatment.name} produced ${size} higher ${pre.metric} than ` +
            `${control.name} (${n}). ${registered}`
        : `${treatment.name} produced higher ${pre.metric} than ` +
            `${control.name} — ${size} (${n}). ${registered}`;
    case 'REFUTED':
      return effectSize !== null
        ? `${treatment.name} produced ${size} *lower* ${pre.metric} than ` +
            `${control.name} (${n}). The hypothesis was wrong in the ` +
            `opposite direction, which is worth knowing.`
        : `${treatment.name} produced *lower* ${pre.metric} than ` +
            `${control.name} — ${size} (${n}). The hypothesis was wrong in ` +
            `the opposite direction, which is worth knowing.`;
    case 'INCONCLUSIVE':
      return (
        `No detectable difference in ${pre.metric} between ${control.name} ` +
        `and ${treatment.name} (${n}). Not evidence that they are the same — ` +
        `evidence that this many posts cannot tell them apart.`
      );
  }
}

/**
 * The SUPPORTED finding a successful experiment earns.
 *
 * Routed through the domain's `promoteWithExperiment` rather than writing the
 * status directly, so the one guarded path to SUPPORTED stays the only one.
 * A REFUTED or INCONCLUSIVE experiment yields no finding: it is recorded on
 * the experiment itself, where the terms that produced it are visible.
 */
export function findingFor(
  pre: PreRegistration,
  conclusion: Conclusion,
): Finding | null {
  if (conclusion.verdict !== 'SUPPORTED') return null;

  const base: Finding = {
    dimension: 'experiment',
    segment: conclusion.treatment.name,
    metric: pre.metric,
    sampleSize: conclusion.treatment.sampleSize,
    segmentMean: conclusion.treatment.mean,
    baselineMean: conclusion.control.mean,
    baselineSize: conclusion.control.sampleSize,
    effectSize: conclusion.effectSize ?? 0,
    interval: conclusion.interval,
    confidence: conclusion.confidence,
    status: 'HYPOTHESIS',
    summary: conclusion.summary,
  };

  const promoted = promoteWithExperiment(base, {
    hypothesis: pre.hypothesis,
    metric: pre.metric,
    minSampleSize: pre.minSampleSize,
    concluded: true,
  });

  // The experiment's own summary says more than the generic one, and says it
  // in terms of the arms that were actually registered.
  return { ...promoted, summary: conclusion.summary };
}
