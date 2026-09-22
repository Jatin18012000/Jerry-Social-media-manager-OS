/**
 * Claim candidate extraction — PRD §7, §15, §16.
 *
 * What this does: splits research text into sentences and proposes which ones
 * carry a checkable assertion, with a proposed §7.3 type.
 *
 * What this deliberately does NOT do: decide that anything is true. Every
 * candidate is produced as UNVERIFIED. §7.1 forbids inventing verification,
 * §7.4 prefers "I could not verify this" to "this is probably correct", and a
 * heuristic over sentence shape cannot establish a fact.
 *
 * Under decision D3 a human verifies claims; later a local model may propose
 * better candidates. Either way the output of this module is a proposal, and
 * the database enforces that a VERIFIED claim cites its evidence.
 */

import type { ClaimType } from './evidence';

export interface ClaimCandidate {
  readonly text: string;
  /** Proposed §7.3 category. Always subject to human confirmation. */
  readonly claimType: ClaimType;
  /** 0..1 — how strongly the sentence looks like a checkable assertion. */
  readonly strength: number;
  /** Which signals fired, so a reviewer can see why it was proposed. */
  readonly signals: readonly string[];
}

/** Hedges and forward-looking language: §7.3 PREDICTION / ESTIMATE. */
const PREDICTION_MARKERS = [
  'will ', 'expected to', 'plans to', 'is set to', 'could ', 'may ',
  'might ', 'likely', 'forecast', 'predict', 'upcoming', 'soon',
  'next year', 'by 2027', 'roadmap',
];

const ESTIMATE_MARKERS = [
  'approximately', 'around ', 'about ', 'roughly', 'an estimated',
  'up to ', 'as many as', 'nearly ',
];

/** Attributed judgement rather than assertion: §7.3 OPINION. */
const OPINION_MARKERS = [
  'i think', 'we think', 'believe', 'argues', 'claims that',
  'in my view', 'arguably', 'should ', 'best ', 'worst ', 'impressive',
  'disappointing',
];

/** Reasoning from something else: §7.3 INFERENCE. */
const INFERENCE_MARKERS = [
  // "suggest" unspaced so it catches both "suggests" and the plural
  // "scores suggest"; a missed inflection here silently downgrades an
  // inference to an assumption.
  'suggest', 'implies', 'imply', 'indicates', 'indicate', 'points to',
  'which means', 'therefore', 'as a result', 'this means', 'consistent with',
];

/** Concrete, checkable events: §7.3 FACT (proposed, not established). */
const FACT_MARKERS = [
  'released', 'launched', 'announced', 'published', 'introduced',
  'reported', 'acquired', 'raised', 'partnered', 'shipped', 'unveiled',
  'available', 'open-sourced', 'open sourced', 'deprecated', 'discontinued',
];

const MIN_SENTENCE_LENGTH = 25;
const MAX_SENTENCE_LENGTH = 400;

/**
 * Splits text into sentences.
 *
 * Abbreviations and version numbers ("v1.5", "Inc.", "e.g.") break naive
 * splitting on periods, so those are protected before the split.
 */
export function splitSentences(text: string): string[] {
  const protectedText = text
    .replace(/\b(Inc|Ltd|Corp|Co|Dr|Mr|Mrs|Ms|Prof|St|vs|etc|eg|ie|al)\./gi, '$1<DOT>')
    .replace(/\b(e\.g|i\.e|et al)\./gi, '$1<DOT>')
    .replace(/(\d)\.(\d)/g, '$1<DOT>$2');

  return protectedText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/<DOT>/g, '.').trim())
    .filter((s) => s.length > 0);
}

function countMatches(lower: string, markers: readonly string[]): string[] {
  return markers.filter((m) => lower.includes(m));
}

/**
 * Classifies one sentence.
 *
 * Order matters: a sentence that both predicts and asserts is a prediction,
 * because over-claiming is the failure mode §7 exists to prevent. When in
 * doubt the weaker category wins.
 */
export function classifySentence(sentence: string): ClaimCandidate | null {
  const trimmed = sentence.trim();
  if (
    trimmed.length < MIN_SENTENCE_LENGTH ||
    trimmed.length > MAX_SENTENCE_LENGTH
  ) {
    return null;
  }

  // A question asserts nothing.
  if (trimmed.endsWith('?')) return null;

  const lower = trimmed.toLowerCase();
  const signals: string[] = [];

  const hasNumber = /\d/.test(trimmed);
  if (hasNumber) signals.push('contains-number');

  const opinion = countMatches(lower, OPINION_MARKERS);
  const prediction = countMatches(lower, PREDICTION_MARKERS);
  const estimate = countMatches(lower, ESTIMATE_MARKERS);
  const inference = countMatches(lower, INFERENCE_MARKERS);
  const fact = countMatches(lower, FACT_MARKERS);

  let claimType: ClaimType;
  let base: number;

  if (opinion.length > 0) {
    claimType = 'OPINION';
    base = 0.4;
    signals.push(...opinion.map((m) => `opinion:${m.trim()}`));
  } else if (prediction.length > 0) {
    claimType = 'PREDICTION';
    base = 0.45;
    signals.push(...prediction.map((m) => `prediction:${m.trim()}`));
  } else if (estimate.length > 0) {
    claimType = 'ESTIMATE';
    base = 0.5;
    signals.push(...estimate.map((m) => `estimate:${m.trim()}`));
  } else if (inference.length > 0) {
    claimType = 'INFERENCE';
    base = 0.5;
    signals.push(...inference.map((m) => `inference:${m.trim()}`));
  } else if (fact.length > 0) {
    claimType = 'FACT';
    base = 0.7;
    signals.push(...fact.map((m) => `fact:${m.trim()}`));
  } else {
    // No signal at all: still potentially a factual sentence, but there is no
    // basis to say so. ASSUMPTION is the honest default (§7.3).
    claimType = 'ASSUMPTION';
    base = 0.25;
    signals.push('no-marker');
  }

  const strength = Math.min(1, base + (hasNumber ? 0.1 : 0));

  return { text: trimmed, claimType, strength, signals };
}

export interface ExtractionOptions {
  /** Candidates below this strength are not proposed. */
  readonly minStrength?: number;
  /** Cap on candidates returned, strongest first. */
  readonly limit?: number;
}

/**
 * Proposes claim candidates from research text.
 *
 * Every candidate is UNVERIFIED by construction — this function has no way to
 * verify anything and must not imply that it has.
 */
export function extractClaimCandidates(
  text: string,
  opts: ExtractionOptions = {},
): ClaimCandidate[] {
  const minStrength = opts.minStrength ?? 0.4;
  const limit = opts.limit ?? 12;

  const seen = new Set<string>();
  const candidates: ClaimCandidate[] = [];

  for (const sentence of splitSentences(text)) {
    const candidate = classifySentence(sentence);
    if (candidate === null) continue;
    if (candidate.strength < minStrength) continue;

    const key = candidate.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push(candidate);
  }

  return candidates
    .sort((a, b) => b.strength - a.strength)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Groundedness — §7.1
// ---------------------------------------------------------------------------

/**
 * Whether a proposed claim actually appears in the text it is attributed to.
 *
 * This is the safeguard that makes model-proposed claims acceptable at all.
 *
 * The heuristic extractor above cannot invent anything: it only ever returns
 * sentences it was given. A model can, and a model asked to "extract claims"
 * will cheerfully synthesise, paraphrase, or round a number. That matters more
 * here than anywhere else in the system, because a claim is stored with its
 * source's name and §7.2 evidence tier and then handed to a writer. An
 * invented claim would arrive wearing a primary source's authority — which is
 * §57's Risk 2 (research errors) in its purest form.
 *
 * So every proposed claim is checked against the source text, and anything
 * that cannot be found there is dropped.
 */

/** Lowercase, collapse whitespace, and normalise the punctuation models alter. */
export function normaliseForGrounding(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\p{L}\p{N}\s'"%$.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function groundingTokens(text: string): string[] {
  return normaliseForGrounding(text)
    .split(' ')
    .map((t) => t.replace(/^[.'-]+|[.'-]+$/g, ''))
    .filter((t) => t.length > 2 || /\d/.test(t));
}

export type GroundingVerdict =
  | { readonly grounded: true; readonly how: 'VERBATIM' | 'NEAR' }
  | { readonly grounded: false; readonly reason: string };

/** Below this share of matching tokens, a reworded claim is not accepted. */
export const GROUNDING_TOKEN_THRESHOLD = 0.9;

/**
 * Checks a claim against its source text.
 *
 * Verbatim containment passes outright. A lightly reworded claim passes only
 * if almost all of its content words appear in the source *and* every
 * number-bearing token does — because a transformed number is the single most
 * dangerous thing a model can return here. "15 trillion" where the source
 * says "1.5 trillion" reads perfectly and is false.
 */
export function checkGrounding(
  claim: string,
  sourceText: string,
  opts: { threshold?: number } = {},
): GroundingVerdict {
  const threshold = opts.threshold ?? GROUNDING_TOKEN_THRESHOLD;

  const normalisedClaim = normaliseForGrounding(claim);
  const normalisedSource = normaliseForGrounding(sourceText);

  if (!normalisedClaim) {
    return { grounded: false, reason: 'the claim is empty' };
  }
  if (!normalisedSource) {
    return { grounded: false, reason: 'there is no source text to check against' };
  }

  if (normalisedSource.includes(normalisedClaim)) {
    return { grounded: true, how: 'VERBATIM' };
  }

  const claimTokens = groundingTokens(claim);
  if (claimTokens.length === 0) {
    return { grounded: false, reason: 'the claim has no content words' };
  }

  // A number absent from the source anywhere was introduced or altered, and
  // that is the single most dangerous thing a model can return here: "15
  // trillion" where the source says 1.5 reads perfectly and is false.
  const wholeSourceTokens = new Set(groundingTokens(sourceText));
  const missingNumbers = claimTokens.filter(
    (t) => /\d/.test(t) && !wholeSourceTokens.has(t),
  );
  if (missingNumbers.length > 0) {
    return {
      grounded: false,
      reason: `not in the source: ${missingNumbers.join(', ')}`,
    };
  }

  // A reworded claim must correspond to ONE source sentence, not to the text
  // as a whole. Checking against the whole blob would accept two sentences
  // welded together — every word present, 100% overlap, and a claim the
  // source never made. Worse, welding a fact to a prediction and typing the
  // result FACT is precisely the flattening §7.3 exists to prevent.
  let best = 0;

  for (const sentence of splitSentences(sourceText)) {
    const sentenceTokens = new Set(groundingTokens(sentence));
    if (sentenceTokens.size === 0) continue;

    const matched = claimTokens.filter((t) => sentenceTokens.has(t)).length;
    const share = matched / claimTokens.length;
    if (share > best) best = share;
  }

  if (best >= threshold) {
    return { grounded: true, how: 'NEAR' };
  }

  return {
    grounded: false,
    reason:
      `no single sentence in the source contains it — the closest matches ` +
      `${Math.round(best * 100)}% of the wording`,
  };
}
