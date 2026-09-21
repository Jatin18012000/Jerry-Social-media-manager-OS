/**
 * Content item lifecycle — PRD §22, §23, §38, §41, §43.
 *
 * This is the only place in the system that writes `content_items.state`.
 * Everything else asks for a transition and lets the domain decide.
 *
 * The transaction boundary is the point of this module. M0 established that
 * the state machine returns an event rather than writing one, so that state
 * and audit event land together or not at all. Here that promise is kept:
 * every state change and its `approval_event` are written inside one
 * `db.transaction`, which is what makes "no silent state changes" (§43) true
 * rather than merely intended.
 */

import { and, eq, inArray } from 'drizzle-orm';

import type { DB } from '@/db/client';
import {
  approvalEvents,
  claims,
  contentItemSources,
  contentItems,
  publicationRecords,
} from '@/db/schema';
import {
  type ContentAction,
  type ContentState,
  type TransitionContext,
  applyAction,
  availableActions,
  transition,
} from '@/domain/content-state';
import { blocksProgress } from '@/domain/evidence';

export class ContentNotFoundError extends Error {
  constructor(id: number) {
    super(`No content item ${id}`);
    this.name = 'ContentNotFoundError';
  }
}

/**
 * Gathers the facts the domain guards need.
 *
 * The domain does not look anything up — it is handed the answers. This
 * function is where "are all claims verified?" and "is there publication
 * evidence?" are actually determined.
 */
export function transitionContextFor(
  db: DB,
  contentItemId: number,
): TransitionContext {
  const linked = db
    .select({
      verificationStatus: claims.verificationStatus,
    })
    .from(contentItemSources)
    .innerJoin(claims, eq(contentItemSources.claimId, claims.id))
    .where(eq(contentItemSources.contentItemId, contentItemId))
    .all();

  // An item with no claims at all has nothing unverified blocking it. That is
  // deliberate: an opinion piece or a personal story rests on no external
  // claim, and requiring one would make those unpublishable.
  const allClaimsVerified = linked.every(
    (row) => !blocksProgress(row.verificationStatus),
  );

  const publication = db
    .select({ id: publicationRecords.id })
    .from(publicationRecords)
    .where(eq(publicationRecords.contentItemId, contentItemId))
    .get();

  return {
    allClaimsVerified,
    hasPublicationEvidence: publication !== undefined,
  };
}

function currentState(db: DB, contentItemId: number): ContentState {
  const row = db
    .select({ state: contentItems.state })
    .from(contentItems)
    .where(eq(contentItems.id, contentItemId))
    .get();

  if (!row) throw new ContentNotFoundError(contentItemId);
  return row.state;
}

export interface TransitionOptions {
  readonly actor?: string;
  readonly note?: string;
  readonly now?: Date;
  /** Column updates to apply in the same transaction as the state change. */
  readonly patch?: Partial<typeof contentItems.$inferInsert>;
}

/**
 * Moves a content item to a new state.
 *
 * Throws IllegalTransitionError or InvariantViolationError from the domain if
 * the move is not permitted. Nothing is written when it throws.
 */
export function moveTo(
  db: DB,
  contentItemId: number,
  to: ContentState,
  opts: TransitionOptions = {},
): ContentState {
  const from = currentState(db, contentItemId);
  const context = transitionContextFor(db, contentItemId);

  // Validated before the transaction opens, so an illegal move never starts
  // one and never partially applies a patch.
  const event = transition(from, to, {
    ...context,
    ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });

  db.transaction((tx) => {
    tx.update(contentItems)
      .set({
        ...(opts.patch ?? {}),
        state: event.to,
        updatedAt: event.at.getTime(),
      })
      .where(eq(contentItems.id, contentItemId))
      .run();

    tx.insert(approvalEvents)
      .values({
        contentItemId,
        actor: event.actor,
        action: event.action,
        fromState: event.from,
        toState: event.to,
        note: event.note ?? null,
        createdAt: event.at.getTime(),
      })
      .run();
  });

  return event.to;
}

/** Applies one of §23's operator actions. */
export function act(
  db: DB,
  contentItemId: number,
  action: ContentAction,
  opts: TransitionOptions = {},
): ContentState {
  const from = currentState(db, contentItemId);
  const context = transitionContextFor(db, contentItemId);

  const event = applyAction(from, action, {
    ...context,
    ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });

  return moveTo(db, contentItemId, event.to, { ...opts, note: event.note ?? '' });
}

/** Which §23 actions the operator may take right now. */
export function actionsFor(db: DB, contentItemId: number): ContentAction[] {
  return availableActions(
    currentState(db, contentItemId),
    transitionContextFor(db, contentItemId),
  );
}

/** Full audit trail for an item, oldest first. */
export function historyOf(db: DB, contentItemId: number) {
  return db
    .select()
    .from(approvalEvents)
    .where(eq(approvalEvents.contentItemId, contentItemId))
    .orderBy(approvalEvents.id)
    .all();
}

/** Items in any of the given states. */
export function itemsInStates(db: DB, states: readonly ContentState[]) {
  if (states.length === 0) return [];
  return db
    .select()
    .from(contentItems)
    .where(inArray(contentItems.state, [...states]))
    .all();
}

/**
 * §16's defence query, made available to the application.
 *
 * Returns items that rest on at least one unverified claim. This is the check
 * that stops §57 Risk 2 (research errors) reaching an audience.
 */
export function itemsRestingOnUnverifiedClaims(db: DB) {
  return db
    .selectDistinct({
      id: contentItems.id,
      state: contentItems.state,
      platform: contentItems.platform,
      topic: contentItems.topic,
    })
    .from(contentItems)
    .innerJoin(
      contentItemSources,
      eq(contentItemSources.contentItemId, contentItems.id),
    )
    .innerJoin(claims, eq(claims.id, contentItemSources.claimId))
    .where(eq(claims.verificationStatus, 'UNVERIFIED'))
    .all();
}

/**
 * Records a human's verification of a claim — PRD §7.2.
 *
 * Marking a claim VERIFIED requires an evidence URL and tier; the database
 * enforces this too, so there is no path to a verified claim with no evidence.
 */
export function verifyClaim(
  db: DB,
  claimId: number,
  input: {
    status: 'VERIFIED' | 'DISPUTED' | 'UNVERIFIABLE';
    evidenceUrl?: string;
    evidenceTier?: 'PRIMARY' | 'OFFICIAL_DOCS' | 'ORIGINAL_RESEARCH' | 'CREDIBLE_SECONDARY' | 'OTHER';
    verifiedBy: string;
    note?: string;
    now?: Date;
  },
): void {
  if (input.status === 'VERIFIED' && (!input.evidenceUrl || !input.evidenceTier)) {
    throw new Error(
      'Marking a claim VERIFIED requires an evidence URL and tier (§7.2).',
    );
  }

  const now = (input.now ?? new Date()).getTime();

  db.update(claims)
    .set({
      verificationStatus: input.status,
      evidenceUrl: input.evidenceUrl ?? null,
      evidenceTier: input.evidenceTier ?? null,
      verifiedAt: now,
      verifiedBy: input.verifiedBy,
      note: input.note ?? null,
      updatedAt: now,
    })
    .where(eq(claims.id, claimId))
    .run();
}

/** Links a content item to the claims it rests on — §16 provenance. */
export function attachClaims(
  db: DB,
  contentItemId: number,
  claimIds: readonly number[],
): void {
  if (claimIds.length === 0) return;

  db.transaction((tx) => {
    for (const claimId of claimIds) {
      const existing = tx
        .select({ id: contentItemSources.claimId })
        .from(contentItemSources)
        .where(
          and(
            eq(contentItemSources.contentItemId, contentItemId),
            eq(contentItemSources.claimId, claimId),
          ),
        )
        .get();

      if (!existing) {
        tx.insert(contentItemSources)
          .values({ contentItemId, claimId })
          .run();
      }
    }
  });
}
