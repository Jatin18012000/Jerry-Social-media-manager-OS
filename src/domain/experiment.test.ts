import { describe, expect, it } from 'vitest';

import {
  ExperimentError,
  MIN_ARM_SAMPLE_SIZE,
  type PreRegistration,
  armFor,
  blocksConclusion,
  canTransition,
  concludeExperiment,
  decodeArms,
  encodeArms,
  findingFor,
  mayAssign,
  validatePreRegistration,
} from './experiment';

const METRICS = ['follows/1k', 'engagement%'];

const GOOD = {
  hypothesis: 'Hinglish captions earn more follows than English ones.',
  metric: 'follows/1k',
  controlName: 'English',
  controlDescription: 'Caption written entirely in English.',
  treatmentName: 'Hinglish',
  treatmentDescription: 'Caption mixing Hindi and English as spoken.',
  minSampleSize: 10,
};

const PRE: PreRegistration = {
  hypothesis: GOOD.hypothesis,
  metric: 'follows/1k',
  control: { name: 'English', description: 'English caption.' },
  treatment: { name: 'Hinglish', description: 'Hinglish caption.' },
  minSampleSize: 5,
};

/** n values around a mean, spread just enough to have a variance. */
function values(count: number, centre: number, spread = 1): number[] {
  return Array.from({ length: count }, (_, i) =>
    centre + ((i % 2 === 0 ? 1 : -1) * spread * (1 + (i % 3))) / 3,
  );
}

describe('the status machine', () => {
  it('runs a draft and concludes a running experiment', () => {
    expect(canTransition('DRAFT', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'CONCLUDED')).toBe(true);
  });

  it('refuses to conclude an experiment that never ran', () => {
    // Otherwise the terms and the data never had to exist in that order.
    expect(canTransition('DRAFT', 'CONCLUDED')).toBe(false);
  });

  it('will not reopen a concluded experiment', () => {
    // Adding data after the verdict is how a result gets reinterpreted.
    for (const to of ['DRAFT', 'RUNNING', 'CONCLUDED', 'ABANDONED'] as const) {
      expect(canTransition('CONCLUDED', to)).toBe(false);
    }
  });

  it('will not restart an abandoned experiment', () => {
    expect(canTransition('ABANDONED', 'RUNNING')).toBe(false);
  });

  it('can abandon from either live state', () => {
    expect(canTransition('DRAFT', 'ABANDONED')).toBe(true);
    expect(canTransition('RUNNING', 'ABANDONED')).toBe(true);
  });
});

describe('validatePreRegistration', () => {
  it('accepts a complete registration', () => {
    const result = validatePreRegistration(GOOD, METRICS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.treatment.name).toBe('Hinglish');
      expect(result.value.minSampleSize).toBe(10);
    }
  });

  it('reports every problem at once', () => {
    // A form that reveals one missing field at a time is a poor way to find
    // out there were four.
    const result = validatePreRegistration({}, METRICS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(3);
  });

  it('refuses a hypothesis that is not a claim', () => {
    const result = validatePreRegistration(
      { ...GOOD, hypothesis: 'hinglish' },
      METRICS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('could turn out to be false');
    }
  });

  it('refuses a metric the system cannot compute', () => {
    // An experiment measuring something uncomputable could never be
    // concluded, so it must not be startable.
    const result = validatePreRegistration(
      { ...GOOD, metric: 'vibes' },
      METRICS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('vibes');
  });

  it('refuses two arms that are the same thing', () => {
    const result = validatePreRegistration(
      { ...GOOD, treatmentName: 'english' },
      METRICS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('must be different');
  });

  it('requires each arm to be described so it can be reproduced', () => {
    const result = validatePreRegistration(
      { ...GOOD, treatmentDescription: '' },
      METRICS,
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a sample size below the floor', () => {
    const result = validatePreRegistration(
      { ...GOOD, minSampleSize: 2 },
      METRICS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain(String(MIN_ARM_SAMPLE_SIZE));
    }
  });

  it('refuses a fractional sample size', () => {
    expect(validatePreRegistration({ ...GOOD, minSampleSize: 7.5 }, METRICS).ok).toBe(
      false,
    );
  });

  it('trims rather than accepting whitespace as content', () => {
    expect(
      validatePreRegistration({ ...GOOD, controlName: '   ' }, METRICS).ok,
    ).toBe(false);
  });
});

describe('arm encoding', () => {
  it('round-trips', () => {
    const decoded = decodeArms(encodeArms(PRE));
    expect(decoded.control.name).toBe('English');
    expect(decoded.treatment.description).toBe('Hinglish caption.');
  });

  it('throws rather than guessing at a broken definition', () => {
    // An experiment whose terms are unknown must not be concluded on any
    // terms at all.
    expect(() => decodeArms('not json')).toThrow(ExperimentError);
    expect(() => decodeArms('{}')).toThrow(ExperimentError);
    expect(() => decodeArms('{"control":{"name":""}}')).toThrow(ExperimentError);
    expect(() => decodeArms('null')).toThrow(ExperimentError);
    expect(() => decodeArms('[]')).toThrow(ExperimentError);
  });
});

describe('armFor', () => {
  const arms = { control: PRE.control, treatment: PRE.treatment };

  it('matches either arm, ignoring case and padding', () => {
    expect(armFor(arms, 'English')).toBe('control');
    expect(armFor(arms, '  hinglish ')).toBe('treatment');
  });

  it('returns null for a name nobody registered', () => {
    // A typo must not silently create a third arm.
    expect(armFor(arms, 'Hinglsh')).toBeNull();
    expect(armFor(arms, '')).toBeNull();
  });
});

describe('mayAssign', () => {
  it('only accepts items while running', () => {
    expect(mayAssign('RUNNING')).toBe(true);
    // Before: data would exist before the terms were fixed.
    expect(mayAssign('DRAFT')).toBe(false);
    // After: data would arrive after the verdict.
    expect(mayAssign('CONCLUDED')).toBe(false);
    expect(mayAssign('ABANDONED')).toBe(false);
  });
});

describe('blocksConclusion — no optional stopping', () => {
  it('allows it once both arms reach the registered minimum', () => {
    expect(blocksConclusion(PRE, values(5, 10), values(5, 12))).toBeNull();
  });

  it('blocks while either arm is short', () => {
    expect(blocksConclusion(PRE, values(4, 10), values(9, 12))).toContain(
      'English has 4 of 5',
    );
    expect(blocksConclusion(PRE, values(9, 10), values(2, 12))).toContain(
      'Hinglish has 2 of 5',
    );
  });

  it('names both arms when both are short', () => {
    const why = blocksConclusion(PRE, values(1, 10), values(2, 12));
    expect(why).toContain('English has 1 of 5');
    expect(why).toContain('Hinglish has 2 of 5');
  });

  it('says why stopping early is refused, not just that it is', () => {
    expect(blocksConclusion(PRE, [], [])).toContain(
      'stopping when the answer looked right',
    );
  });

  it('is not satisfied by a lopsided total', () => {
    // Rule 4: ten posts split nine-one establishes nothing, even though ten
    // posts were measured.
    const pre = { ...PRE, minSampleSize: 5 };
    expect(blocksConclusion(pre, values(9, 10), values(1, 12))).not.toBeNull();
  });
});

describe('concludeExperiment', () => {
  it('refuses to conclude early rather than returning a weak verdict', () => {
    // A verdict computed on terms other than the registered ones is not a
    // result of this experiment at all.
    expect(() => concludeExperiment(PRE, values(2, 10), values(2, 12))).toThrow(
      ExperimentError,
    );
  });

  it('supports the hypothesis when the treatment clearly wins', () => {
    const result = concludeExperiment(PRE, values(12, 10, 0.5), values(12, 20, 0.5));

    expect(result.verdict).toBe('SUPPORTED');
    expect(result.effectSize).toBeCloseTo(100, 0);
    expect(result.summary).toContain('registered before the data existed');
  });

  it('refutes rather than calling a reversal inconclusive', () => {
    // "The effect went the other way" is more valuable than "we could not
    // tell", and flattening the two would lose it.
    const result = concludeExperiment(PRE, values(12, 20, 0.5), values(12, 10, 0.5));

    expect(result.verdict).toBe('REFUTED');
    expect(result.summary).toContain('*lower*');
    expect(result.summary).toContain('worth knowing');
  });

  it('returns INCONCLUSIVE when the arms overlap', () => {
    const result = concludeExperiment(PRE, values(10, 10, 4), values(10, 10.2, 4));
    expect(result.verdict).toBe('INCONCLUSIVE');
  });

  it('says an inconclusive result is not evidence of no difference', () => {
    const result = concludeExperiment(PRE, values(10, 10, 4), values(10, 10.2, 4));
    expect(result.summary).toContain('Not evidence that they are the same');
  });

  it('reports the confidence from the smaller arm, not the larger', () => {
    // An interval built on one arm of six is confident about very little,
    // however many are in the other.
    const pre = { ...PRE, minSampleSize: 5 };
    const result = concludeExperiment(pre, values(6, 10, 0.5), values(60, 20, 0.5));
    expect(result.confidence).toBe('LOW');
  });

  it('declines a percentage against a baseline that is effectively zero', () => {
    // 3e-8 is not zero, but dividing by it yields "150,499,900% higher" — a
    // figure that is arithmetically correct and tells the reader nothing.
    const result = concludeExperiment(PRE, values(10, 0, 0.0001), values(10, 5, 0.5));

    expect(result.effectSize).toBeNull();
    expect(result.summary).toContain('too close to zero');
    // The verdict comes from the interval and is unaffected.
    expect(result.verdict).toBe('SUPPORTED');
  });

  it('reports the means when it cannot report a percentage', () => {
    const result = concludeExperiment(PRE, values(10, 0, 0.0001), values(10, 5, 0.5));
    expect(result.summary).toMatch(/5\.\d\d against 0\.00/);
  });

  it('still gives a percentage for a large but real effect', () => {
    // The near-zero guard must not swallow a legitimate 10x.
    const result = concludeExperiment(PRE, values(10, 1, 0.05), values(10, 10, 0.05));
    expect(result.effectSize).toBeGreaterThan(800);
    expect(result.summary).toContain('%');
  });

  it('carries both arms’ sample sizes into the record', () => {
    const result = concludeExperiment(PRE, values(7, 10), values(9, 12));
    expect(result.control.sampleSize).toBe(7);
    expect(result.treatment.sampleSize).toBe(9);
  });
});

describe('findingFor — the only route to SUPPORTED', () => {
  it('earns a SUPPORTED finding from a successful experiment', () => {
    const conclusion = concludeExperiment(
      PRE,
      values(12, 10, 0.5),
      values(12, 20, 0.5),
    );
    const finding = findingFor(PRE, conclusion);

    expect(finding?.status).toBe('SUPPORTED');
    expect(finding?.dimension).toBe('experiment');
    expect(finding?.segment).toBe('Hinglish');
    expect(finding?.metric).toBe('follows/1k');
  });

  it('yields nothing from a refuted experiment', () => {
    const conclusion = concludeExperiment(
      PRE,
      values(12, 20, 0.5),
      values(12, 10, 0.5),
    );
    // Recorded on the experiment, where the terms that produced it are
    // visible — not promoted into a belief.
    expect(findingFor(PRE, conclusion)).toBeNull();
  });

  it('yields nothing from an inconclusive experiment', () => {
    const conclusion = concludeExperiment(
      PRE,
      values(10, 10, 4),
      values(10, 10.2, 4),
    );
    expect(findingFor(PRE, conclusion)).toBeNull();
  });

  it('keeps the experiment’s own wording, in terms of the real arms', () => {
    const conclusion = concludeExperiment(
      PRE,
      values(12, 10, 0.5),
      values(12, 20, 0.5),
    );
    expect(findingFor(PRE, conclusion)?.summary).toContain('Hinglish');
  });
});
