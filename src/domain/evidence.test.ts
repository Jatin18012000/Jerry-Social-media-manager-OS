import { describe, expect, it } from 'vitest';

import {
  CLAIM_TYPES,
  EVIDENCE_TIERS,
  VERIFICATION_STATUSES,
  blocksProgress,
  evidenceRank,
  isStrongerEvidence,
  mayBeStatedAsFact,
} from './evidence';

describe('evidence hierarchy (PRD §7.2)', () => {
  it('ranks primary sources above everything else', () => {
    for (const tier of EVIDENCE_TIERS) {
      if (tier !== 'PRIMARY') {
        expect(isStrongerEvidence('PRIMARY', tier)).toBe(true);
      }
    }
  });

  it('ranks OTHER below everything else', () => {
    for (const tier of EVIDENCE_TIERS) {
      if (tier !== 'OTHER') {
        expect(isStrongerEvidence(tier, 'OTHER')).toBe(true);
      }
    }
  });

  it('orders the hierarchy exactly as the PRD states it', () => {
    expect([...EVIDENCE_TIERS]).toEqual([
      'PRIMARY',
      'OFFICIAL_DOCS',
      'ORIGINAL_RESEARCH',
      'CREDIBLE_SECONDARY',
      'OTHER',
    ]);
  });

  it('is a strict ordering — no tier outranks itself', () => {
    for (const tier of EVIDENCE_TIERS) {
      expect(isStrongerEvidence(tier, tier)).toBe(false);
    }
  });

  it('assigns each tier a distinct rank', () => {
    const ranks = EVIDENCE_TIERS.map(evidenceRank);
    expect(new Set(ranks).size).toBe(EVIDENCE_TIERS.length);
  });
});

describe('stating things as fact (PRD §7.3, §7.4)', () => {
  it('allows only a verified FACT to be stated as fact', () => {
    expect(mayBeStatedAsFact('FACT', 'VERIFIED')).toBe(true);
  });

  it('refuses every non-FACT claim type even when verified', () => {
    for (const type of CLAIM_TYPES) {
      if (type !== 'FACT') {
        expect(mayBeStatedAsFact(type, 'VERIFIED'), type).toBe(false);
      }
    }
  });

  it('refuses a FACT that is not verified', () => {
    for (const status of VERIFICATION_STATUSES) {
      if (status !== 'VERIFIED') {
        expect(mayBeStatedAsFact('FACT', status), status).toBe(false);
      }
    }
  });
});

describe('progress blocking', () => {
  it('blocks only on unexamined claims', () => {
    expect(blocksProgress('UNVERIFIED')).toBe(true);
  });

  it('does not block on examined outcomes', () => {
    // Disputed and unverifiable are known results a writer can frame
    // honestly (§7.3); an unexamined claim is not.
    expect(blocksProgress('VERIFIED')).toBe(false);
    expect(blocksProgress('DISPUTED')).toBe(false);
    expect(blocksProgress('UNVERIFIABLE')).toBe(false);
  });
});
