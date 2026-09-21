import { describe, expect, it } from 'vitest';

import {
  classifySentence,
  extractClaimCandidates,
  splitSentences,
} from './claim-extraction';

describe('splitSentences', () => {
  it('splits on sentence boundaries', () => {
    expect(splitSentences('One thing happened. Then another did.')).toEqual([
      'One thing happened.',
      'Then another did.',
    ]);
  });

  it('does not split inside a version number', () => {
    const out = splitSentences('They shipped v1.5 today. It is faster.');
    expect(out).toEqual(['They shipped v1.5 today.', 'It is faster.']);
  });

  it('does not split on common abbreviations', () => {
    const out = splitSentences('Acme Inc. released a model. It is open.');
    expect(out).toEqual(['Acme Inc. released a model.', 'It is open.']);
  });
});

describe('classifySentence — PRD §7.3 categories', () => {
  it('proposes FACT for a concrete, checkable event', () => {
    const c = classifySentence(
      'OpenAI released a new reasoning model for developers today.',
    );
    expect(c?.claimType).toBe('FACT');
  });

  it('proposes PREDICTION for forward-looking language', () => {
    const c = classifySentence(
      'The company will launch the enterprise tier sometime next year.',
    );
    expect(c?.claimType).toBe('PREDICTION');
  });

  it('proposes ESTIMATE for hedged quantities', () => {
    const c = classifySentence(
      'The model was trained on approximately 15 trillion tokens of data.',
    );
    expect(c?.claimType).toBe('ESTIMATE');
  });

  it('proposes OPINION for judgement', () => {
    const c = classifySentence(
      'This is arguably the most impressive release of the entire year.',
    );
    expect(c?.claimType).toBe('OPINION');
  });

  it('proposes INFERENCE for reasoning from evidence', () => {
    const c = classifySentence(
      'The benchmark scores suggest the training data was heavily filtered.',
    );
    expect(c?.claimType).toBe('INFERENCE');
  });

  it('defaults to ASSUMPTION when nothing indicates a category', () => {
    // §7.3: the honest default is the weaker category, not FACT.
    const c = classifySentence(
      'The interface uses a fairly conventional sidebar arrangement.',
    );
    expect(c?.claimType).toBe('ASSUMPTION');
  });

  it('prefers the weaker category when signals conflict', () => {
    // Over-claiming is the failure mode §7 exists to prevent, so a sentence
    // that both predicts and asserts is a prediction.
    const c = classifySentence(
      'OpenAI announced that it will release the model to everyone next year.',
    );
    expect(c?.claimType).toBe('PREDICTION');
  });

  it('rejects questions, which assert nothing', () => {
    expect(
      classifySentence('Will this model actually change anything at all?'),
    ).toBeNull();
  });

  it('rejects fragments too short to be a claim', () => {
    expect(classifySentence('It shipped.')).toBeNull();
  });

  it('explains which signals fired', () => {
    const c = classifySentence(
      'Anthropic announced 5 new enterprise features this week.',
    );
    expect(c?.signals).toContain('contains-number');
    expect(c?.signals.some((s) => s.startsWith('fact:'))).toBe(true);
  });
});

describe('extractClaimCandidates', () => {
  const text = `
    OpenAI released a new reasoning model today for all developers.
    It will probably reach general availability sometime next year.
    This is arguably the most significant launch of the whole year.
    Will developers actually adopt it?
    The system was trained on approximately 15 trillion tokens.
  `;

  it('proposes candidates across several claim types', () => {
    const out = extractClaimCandidates(text);
    const types = new Set(out.map((c) => c.claimType));
    expect(types.has('FACT')).toBe(true);
    expect(types.has('PREDICTION')).toBe(true);
    expect(types.has('ESTIMATE')).toBe(true);
  });

  it('never proposes a question as a claim', () => {
    const out = extractClaimCandidates(text);
    expect(out.some((c) => c.text.endsWith('?'))).toBe(false);
  });

  it('orders candidates strongest first', () => {
    const out = extractClaimCandidates(text);
    const strengths = out.map((c) => c.strength);
    expect([...strengths].sort((a, b) => b - a)).toEqual(strengths);
  });

  it('respects the limit', () => {
    const out = extractClaimCandidates(text, { limit: 2 });
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it('deduplicates repeated sentences', () => {
    const repeated = 'OpenAI released a new model today. '.repeat(3);
    expect(extractClaimCandidates(repeated).length).toBe(1);
  });

  it('returns nothing for empty input rather than throwing', () => {
    expect(extractClaimCandidates('')).toEqual([]);
  });

  it('proposes nothing it can claim to have verified', () => {
    // The module has no verification capability, so its output must never
    // imply one (§7.1, §7.4). Candidates carry a type and a strength only —
    // no verification status field exists on them to be wrongly set.
    const out = extractClaimCandidates(text);
    for (const candidate of out) {
      expect(candidate).not.toHaveProperty('verificationStatus');
      expect(candidate).not.toHaveProperty('verified');
    }
  });
});
