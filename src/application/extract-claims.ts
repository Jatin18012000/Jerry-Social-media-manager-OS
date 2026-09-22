/**
 * Claim extraction — PRD §7, §15, §16, and the automation guide's §8.
 *
 * Proposes the claims a research item makes, so a human can verify them.
 *
 * Two implementations, same guarantees:
 *
 *   The local model reads the text and says what it asserts, with a §7.3 type
 *   per claim. Better than keyword matching at telling an inference from a
 *   fact, and much better at ignoring boilerplate.
 *
 *   The heuristic splits sentences and types them by marker words. It runs
 *   whenever the model is unavailable, unreachable, or returns something that
 *   does not survive checking — which is often enough that it stays a
 *   first-class path rather than a fallback in name only.
 *
 * The safeguard that makes the model path acceptable at all: **every proposed
 * claim is checked against the source text and dropped if it is not there.**
 *
 * That check matters more here than anywhere else in the system. A claim is
 * stored against its research item, inherits that source's name and §7.2
 * evidence tier, and is then handed to a writer inside a brief. A model that
 * paraphrases a number, merges two sentences into a stronger statement, or
 * simply invents a plausible detail would produce a false claim wearing a
 * primary source's authority. That is §57's Risk 2 exactly, and it is the
 * failure this module is built to prevent rather than to risk.
 *
 * Nothing here can verify anything. Every claim is written UNVERIFIED (§7.1),
 * and the database independently refuses a VERIFIED claim with no evidence.
 */

import { eq } from 'drizzle-orm';

import type { DB } from '@/db/client';
import { agentRuns, claims, researchItems } from '@/db/schema';
import {
  type ClaimCandidate,
  checkGrounding,
  extractClaimCandidates,
} from '@/domain/claim-extraction';
import { CLAIM_TYPES, type ClaimType } from '@/domain/evidence';
import type { StructuredProvider } from '@/ports';

export interface ProposedClaim extends ClaimCandidate {
  readonly source: 'LOCAL_MODEL' | 'HEURISTIC';
  /** How the claim was matched to the source text, when a model proposed it. */
  readonly grounding?: 'VERBATIM' | 'NEAR';
}

export interface ExtractionOutcome {
  readonly claims: readonly ProposedClaim[];
  readonly source: 'LOCAL_MODEL' | 'HEURISTIC';
  /** Model-proposed claims dropped for not appearing in the source. */
  readonly ungrounded: readonly { text: string; reason: string }[];
}

interface ModelClaim {
  readonly text: string;
  readonly claimType: ClaimType;
}

const MAX_CLAIMS = 12;
const MAX_INPUT_CHARS = 6_000;

const INSTRUCTION = [
  'You identify the claims a news item makes, so a human can check them.',
  '',
  'Return JSON: { "claims": [ { "text": "...", "type": "..." } ] }',
  '',
  'type must be exactly one of:',
  '  FACT       a concrete, checkable event or state',
  '  INFERENCE  a conclusion drawn from something else',
  '  ASSUMPTION something taken as given but not established',
  '  ESTIMATE   a hedged or approximate quantity',
  '  OPINION    a judgement',
  '  PREDICTION a statement about the future',
  '',
  'Rules you must follow:',
  '  Quote each claim VERBATIM from the text. Do not reword, summarise,',
  '    combine sentences, or round numbers.',
  '  Do not add any claim that is not stated in the text.',
  '  Skip boilerplate, navigation, bylines and calls to subscribe.',
  '  If a sentence both asserts and predicts, type it PREDICTION.',
  '  If the text makes no checkable claims, return an empty array.',
].join('\n');

/**
 * Validates the model's response shape.
 *
 * Strict on type, because a claim typed FACT when it is a prediction is
 * exactly the flattening §7.3 forbids. Groundedness is checked separately,
 * against the source text this parser does not have.
 */
export function parseModelClaims(raw: unknown): ModelClaim[] | null {
  if (!raw || typeof raw !== 'object') return null;

  const list = (raw as { claims?: unknown }).claims;
  if (!Array.isArray(list)) return null;

  const out: ModelClaim[] = [];

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') return null;
    const record = entry as Record<string, unknown>;

    const text = record['text'];
    if (typeof text !== 'string' || text.trim().length < 10) return null;

    const typeRaw = record['type'] ?? record['claimType'];
    if (typeof typeRaw !== 'string') return null;

    const claimType = typeRaw.trim().toUpperCase() as ClaimType;
    // §7.1 — the model does not get to invent a seventh category.
    if (!CLAIM_TYPES.includes(claimType)) return null;

    out.push({ text: text.trim(), claimType });
  }

  return out;
}

/** The deterministic path. Cannot invent anything: it returns what it was given. */
export function extractWithHeuristics(text: string): ExtractionOutcome {
  return {
    claims: extractClaimCandidates(text).map((candidate) => ({
      ...candidate,
      source: 'HEURISTIC' as const,
    })),
    source: 'HEURISTIC',
    ungrounded: [],
  };
}

/**
 * Proposes claims for one piece of research text.
 *
 * Prefers the local model; falls back to heuristics when it is unavailable,
 * returns an unusable shape, or returns nothing that survives grounding.
 */
export async function proposeClaims(
  db: DB,
  text: string,
  provider: StructuredProvider | null,
  opts: { now?: Date } = {},
): Promise<ExtractionOutcome> {
  const now = opts.now ?? new Date();
  const trimmed = text.trim();

  if (!trimmed) {
    return { claims: [], source: 'HEURISTIC', ungrounded: [] };
  }

  if (provider && (await provider.available())) {
    const run = await provider.run({
      task: 'extract-claims',
      instruction: INSTRUCTION,
      input: { text: trimmed.slice(0, MAX_INPUT_CHARS) },
      parse: parseModelClaims,
    });

    const grounded: ProposedClaim[] = [];
    const ungrounded: { text: string; reason: string }[] = [];

    if (run.output) {
      const seen = new Set<string>();

      for (const claim of run.output) {
        const key = claim.text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        // The safeguard. A claim that is not in the source is dropped,
        // whatever the model asserted about it.
        const verdict = checkGrounding(claim.text, trimmed);

        if (!verdict.grounded) {
          ungrounded.push({ text: claim.text, reason: verdict.reason });
          continue;
        }

        grounded.push({
          text: claim.text,
          claimType: claim.claimType,
          // The model's confidence is not asked for and would not be
          // trusted; strength here only orders the reviewer's list.
          strength: verdict.how === 'VERBATIM' ? 0.9 : 0.7,
          signals: [
            `local-model:${verdict.how.toLowerCase()}`,
            ...(run.model ? [`model:${run.model}`] : []),
          ],
          source: 'LOCAL_MODEL',
          grounding: verdict.how,
        });

        if (grounded.length >= MAX_CLAIMS) break;
      }
    }

    db.insert(agentRuns)
      .values({
        agent: 'qwen',
        provider: run.provider,
        model: run.model,
        operation: 'extract-claims',
        durationMs: run.durationMs,
        status:
          run.status === 'OK' && grounded.length === 0 && ungrounded.length > 0
            ? 'UNGROUNDED'
            : run.status,
        error:
          ungrounded.length > 0
            ? `${ungrounded.length} claim(s) not found in source: ` +
              ungrounded
                .slice(0, 3)
                .map((u) => u.reason)
                .join('; ')
            : (run.error ?? null),
        createdAt: now.getTime(),
      })
      .run();

    // Nothing usable came back. Fall through rather than returning an empty
    // list, which would look like "this text makes no claims".
    if (grounded.length > 0) {
      return { claims: grounded, source: 'LOCAL_MODEL', ungrounded };
    }
  }

  const heuristic = extractWithHeuristics(trimmed);

  db.insert(agentRuns)
    .values({
      agent: 'heuristic',
      provider: 'local',
      model: null,
      operation: 'extract-claims',
      durationMs: 0,
      status: 'OK',
      createdAt: now.getTime(),
    })
    .run();

  return heuristic;
}

/**
 * Proposes claims for a research item and stores them.
 *
 * Every claim is written UNVERIFIED (§7.1). The note records which path
 * proposed it and how it was matched to the source, so a reviewer can see
 * where a claim came from rather than having to trust it.
 */
export async function proposeAndStoreClaims(
  db: DB,
  researchItemId: number,
  text: string,
  provider: StructuredProvider | null,
  opts: { now?: Date } = {},
): Promise<ExtractionOutcome> {
  const now = opts.now ?? new Date();

  const item = db
    .select({ id: researchItems.id })
    .from(researchItems)
    .where(eq(researchItems.id, researchItemId))
    .get();

  if (!item) throw new Error(`No research item ${researchItemId}`);

  const outcome = await proposeClaims(db, text, provider, { now });

  for (const claim of outcome.claims) {
    db.insert(claims)
      .values({
        researchItemId,
        text: claim.text,
        claimType: claim.claimType,
        // No path here can verify anything.
        verificationStatus: 'UNVERIFIED',
        note:
          claim.source === 'LOCAL_MODEL'
            ? `proposed by local model (${claim.grounding?.toLowerCase()} match to source)`
            : `proposed by heuristic extractor (${claim.signals.join(', ')})`,
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
      })
      .run();
  }

  return outcome;
}
