/**
 * Evidence and claim typing — PRD §7 (Cross-Agent Truth & Verification Policy).
 *
 * §7.2 defines an evidence hierarchy. §7.3 requires that verified fact,
 * inference, assumption, estimate, opinion and prediction are never presented
 * as equivalent. A `source_url` string cannot express either, so both are
 * modelled explicitly and travel with every claim.
 */

/**
 * PRD §7.3. The six epistemic categories, which must never be flattened
 * into one another when content is generated or displayed.
 */
export const CLAIM_TYPES = [
  'FACT',
  'INFERENCE',
  'ASSUMPTION',
  'ESTIMATE',
  'OPINION',
  'PREDICTION',
] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];

/**
 * PRD §7.2, in descending order of authority:
 *   Primary source -> Official documentation -> Original research/paper ->
 *   Highly credible secondary reporting -> Other sources.
 */
export const EVIDENCE_TIERS = [
  'PRIMARY',
  'OFFICIAL_DOCS',
  'ORIGINAL_RESEARCH',
  'CREDIBLE_SECONDARY',
  'OTHER',
] as const;

export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

/** Lower rank means more authoritative. */
export function evidenceRank(tier: EvidenceTier): number {
  return EVIDENCE_TIERS.indexOf(tier);
}

/**
 * §7.2: "Low-quality sources must not be treated as authoritative merely
 * because they appear first in search results."
 */
export function isStrongerEvidence(a: EvidenceTier, b: EvidenceTier): boolean {
  return evidenceRank(a) < evidenceRank(b);
}

export const VERIFICATION_STATUSES = [
  'UNVERIFIED',
  'VERIFIED',
  'DISPUTED',
  'UNVERIFIABLE',
] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * Only a claim typed FACT and status VERIFIED may be stated as fact in
 * published content. Everything else must be framed as what it is (§7.3),
 * and §7.4 prefers "I could not verify this" over false confidence.
 */
export function mayBeStatedAsFact(
  type: ClaimType,
  status: VerificationStatus,
): boolean {
  return type === 'FACT' && status === 'VERIFIED';
}

/**
 * A claim blocks its content item from progressing while it is still
 * UNVERIFIED. DISPUTED and UNVERIFIABLE do not block — they are known
 * outcomes that the writer can frame honestly — but an unexamined claim does.
 */
export function blocksProgress(status: VerificationStatus): boolean {
  return status === 'UNVERIFIED';
}
