import { describe, expect, it } from 'vitest';

import {
  GROUNDING_TOKEN_THRESHOLD,
  checkGrounding,
  normaliseForGrounding,
} from './claim-extraction';

const SOURCE = `
OpenAI released a new reasoning model for developers today. The model was
trained on approximately 15 trillion tokens. The company will expand
availability to enterprise customers next year. Benchmark scores suggest the
training data was heavily filtered.
`;

describe('normaliseForGrounding', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normaliseForGrounding('  A  Model \n Released ')).toBe(
      'a model released',
    );
  });

  it('normalises the smart quotes models substitute', () => {
    expect(normaliseForGrounding('the model’s launch')).toBe(
      "the model's launch",
    );
    expect(normaliseForGrounding('“quoted”')).toBe('"quoted"');
  });

  it('normalises en and em dashes', () => {
    expect(normaliseForGrounding('a—b')).toBe('a-b');
  });

  it('keeps digits, percentages and currency', () => {
    expect(normaliseForGrounding('up 15% to $4.2M')).toContain('15%');
    expect(normaliseForGrounding('up 15% to $4.2M')).toContain('$4.2m');
  });
});

describe('checkGrounding — accepting what is really there', () => {
  it('accepts a verbatim quote', () => {
    const verdict = checkGrounding(
      'OpenAI released a new reasoning model for developers today.',
      SOURCE,
    );
    expect(verdict.grounded).toBe(true);
    if (verdict.grounded) expect(verdict.how).toBe('VERBATIM');
  });

  it('accepts a quote whose whitespace the model reflowed', () => {
    // The source wraps mid-sentence; a model will return it on one line.
    const verdict = checkGrounding(
      'The model was trained on approximately 15 trillion tokens.',
      SOURCE,
    );
    expect(verdict.grounded).toBe(true);
  });

  it('accepts a quote with smart quotes substituted', () => {
    const source = "The company's model shipped.";
    const verdict = checkGrounding('The company’s model shipped.', source);
    expect(verdict.grounded).toBe(true);
  });

  it('accepts a trivially reworded claim as a NEAR match', () => {
    const verdict = checkGrounding(
      'OpenAI released a new reasoning model for developers',
      SOURCE,
    );
    expect(verdict.grounded).toBe(true);
  });
});

describe('checkGrounding — PRD §7.1, rejecting what is not', () => {
  it('rejects a claim that is simply not in the text', () => {
    const verdict = checkGrounding(
      'Google announced a competing model the same week.',
      SOURCE,
    );
    expect(verdict.grounded).toBe(false);
  });

  it('rejects an altered number', () => {
    // The single most dangerous thing a model can return here: "15 trillion"
    // where the source says 1.5 reads perfectly and is false.
    const verdict = checkGrounding(
      'The model was trained on approximately 50 trillion tokens.',
      SOURCE,
    );
    expect(verdict.grounded).toBe(false);
    if (!verdict.grounded) expect(verdict.reason).toContain('50');
  });

  it('rejects an invented number even when the wording matches', () => {
    const verdict = checkGrounding(
      'OpenAI released 3 new reasoning models for developers today.',
      SOURCE,
    );
    expect(verdict.grounded).toBe(false);
  });

  it('rejects a claim strengthened beyond the source', () => {
    const verdict = checkGrounding(
      'OpenAI released a new reasoning model that outperforms every rival.',
      SOURCE,
    );
    expect(verdict.grounded).toBe(false);
  });

  it('rejects an invented entity', () => {
    const verdict = checkGrounding(
      'Anthropic released a new reasoning model for developers today.',
      SOURCE,
    );
    expect(verdict.grounded).toBe(false);
  });

  it('rejects an empty claim', () => {
    expect(checkGrounding('   ', SOURCE).grounded).toBe(false);
  });

  it('rejects anything when there is no source text', () => {
    const verdict = checkGrounding('A claim.', '');
    expect(verdict.grounded).toBe(false);
    if (!verdict.grounded) expect(verdict.reason).toContain('no source text');
  });

  it('explains why it rejected', () => {
    const verdict = checkGrounding('Entirely unrelated wording here.', SOURCE);
    expect(verdict.grounded).toBe(false);
    if (!verdict.grounded) expect(verdict.reason.length).toBeGreaterThan(5);
  });

  it('holds the threshold it documents', () => {
    expect(GROUNDING_TOKEN_THRESHOLD).toBeGreaterThanOrEqual(0.85);
  });
});

describe('checkGrounding — a merged claim is not grounded', () => {
  it('rejects two sentences welded into one stronger statement', () => {
    // Every word is in the source, but the source never said this.
    const verdict = checkGrounding(
      'OpenAI released a new reasoning model trained on approximately 15 ' +
        'trillion tokens and will expand availability to enterprise ' +
        'customers next year, and benchmark scores suggest the training ' +
        'data was heavily filtered, which proves the approach works.',
      SOURCE,
    );
    expect(verdict.grounded).toBe(false);
  });
});

describe('checkGrounding — a reworded claim must match one sentence', () => {
  const TWO = `OpenAI released a new reasoning model for developers today. The company will expand availability to enterprise customers next year.`;

  it('rejects two verbatim sentences welded together with no words added', () => {
    // Every word is in the source and the token overlap is 100%, but the
    // source never made this claim. Worse, it welds a FACT to a PREDICTION,
    // and typing the result FACT is the flattening §7.3 forbids.
    const verdict = checkGrounding(
      'OpenAI released a new reasoning model for developers today and will ' +
        'expand availability to enterprise customers next year.',
      TWO,
    );
    expect(verdict.grounded).toBe(false);
    if (!verdict.grounded) {
      expect(verdict.reason).toContain('no single sentence');
    }
  });

  it('still accepts each of those sentences on its own', () => {
    expect(
      checkGrounding(
        'OpenAI released a new reasoning model for developers today.',
        TWO,
      ).grounded,
    ).toBe(true);
    expect(
      checkGrounding(
        'The company will expand availability to enterprise customers next year.',
        TWO,
      ).grounded,
    ).toBe(true);
  });

  it('still accepts a genuinely verbatim multi-sentence quote', () => {
    // Quoting the source exactly, in order, is not a fabrication.
    expect(checkGrounding(TWO, TWO).grounded).toBe(true);
  });

  it('still accepts light rewording within one sentence', () => {
    expect(
      checkGrounding(
        'OpenAI released a new reasoning model for developers',
        TWO,
      ).grounded,
    ).toBe(true);
  });
});
