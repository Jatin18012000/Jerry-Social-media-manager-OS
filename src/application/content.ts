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
  scheduleJobs,
} from '@/db/schema';
import {
  type ContentAction,
  type ContentState,
  type TransitionContext,
  applyAction,
  availableActions,
  transition,
} from '@/domain/content-state';
import { IllegalTransitionError } from '@/domain/errors';
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

// ---------------------------------------------------------------------------
// Pipeline advancement
// ---------------------------------------------------------------------------

/**
 * Forward steps through the early pipeline that have no dedicated operator
 * action of their own.
 *
 * §23's action set — APPROVE, EDIT, REGENERATE, REJECT, SCHEDULE, UNSCHEDULE,
 * CANCEL — is about deciding the fate of finished content, so `availableActions`
 * returns nothing at all for an item in IDEA. These three transitions are
 * legal in the domain and were only ever driven by scripts and tests, which is
 * why a real item could be written, briefed, and then stuck with no way
 * forward.
 *
 * Only the steps that nothing else already owns are listed here. The rest of
 * the pipeline keeps its existing, purpose-built path, and must not be
 * reachable through this generic one:
 *
 *   STRATEGY_READY -> GENERATING  belongs to composing a brief
 *   GENERATING     -> QA          belongs to pasting the generation back
 *   QA             -> READY_FOR_REVIEW belongs to the QA gate
 *   READY_FOR_REVIEW -> APPROVED  belongs to the human review screen (§22)
 *
 * NEEDS_REVISION is deliberately absent: it has two legal forward targets
 * (GENERATING and STRATEGY_READY) and picking one for the operator would be
 * guessing which kind of revision they meant.
 */
const PIPELINE_ADVANCE: Readonly<Partial<Record<ContentState, ContentState>>> =
  Object.freeze({
    IDEA: 'RESEARCHING',
    RESEARCHING: 'RESEARCH_VERIFIED',
    RESEARCH_VERIFIED: 'STRATEGY_READY',
  });

export interface PipelineStep {
  readonly from: ContentState;
  readonly to: ContentState;
}

/**
 * The next pipeline step for an item, or null when its state is served by a
 * purpose-built action elsewhere.
 *
 * Says nothing about whether the move will *succeed* — the guards decide that,
 * and `advancePipeline` surfaces their refusal. An item in RESEARCH_VERIFIED
 * with unverified claims still reports STRATEGY_READY as its next step, so the
 * operator is told why it is blocked rather than shown nothing.
 */
export function nextPipelineStep(
  db: DB,
  contentItemId: number,
): PipelineStep | null {
  const from = currentState(db, contentItemId);
  const to = PIPELINE_ADVANCE[from];
  return to === undefined ? null : { from, to };
}

/**
 * Advances an item one step along the pipeline.
 *
 * A thin wrapper over `moveTo`, which is what actually validates the move,
 * applies the guards and writes the audit event. The wrapper exists for one
 * reason: it refuses any target that is not *this* state's registered step, so
 * a crafted request cannot use it to reach APPROVED, SCHEDULED or anything
 * else that belongs to a guarded path of its own.
 */
export function advancePipeline(
  db: DB,
  contentItemId: number,
  to: ContentState,
  opts: TransitionOptions = {},
): ContentState {
  const step = nextPipelineStep(db, contentItemId);

  if (step === null) {
    throw new IllegalTransitionError(
      currentState(db, contentItemId),
      to,
      'this state is advanced by a dedicated action, not by the pipeline step',
    );
  }

  if (step.to !== to) {
    throw new IllegalTransitionError(
      step.from,
      to,
      `the next pipeline step from ${step.from} is ${step.to}`,
    );
  }

  return moveTo(db, contentItemId, to, opts);
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

// ---------------------------------------------------------------------------
// Editing content — §23 "Edit"
// ---------------------------------------------------------------------------

export class EditRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditRefusedError';
  }
}

export interface ContentFields {
  readonly hook?: string | null;
  readonly body?: string | null;
  readonly caption?: string | null;
  readonly cta?: string | null;
  readonly hashtags?: string | null;
  readonly altText?: string | null;
}

/** States where editing changes nothing about approval, because none exists. */
const FREELY_EDITABLE: readonly ContentState[] = [
  'IDEA',
  'RESEARCHING',
  'RESEARCH_VERIFIED',
  'STRATEGY_READY',
  'GENERATING',
  'QA',
  'NEEDS_REVISION',
  'READY_FOR_REVIEW',
];

/**
 * States where an edit revokes approval rather than being refused.
 *
 * This is the rule that keeps §22 meaningful. If content could be edited
 * after approval, the approval would be of nothing in particular — a person
 * could approve one thing and a different thing could go out. So editing an
 * approved item is allowed, and it un-approves it.
 */
const REVOKES_APPROVAL: readonly ContentState[] = ['APPROVED', 'SCHEDULED'];

export interface EditResult {
  readonly state: ContentState;
  readonly approvalRevoked: boolean;
}

/**
 * Updates the content fields of an item — §23's Edit action.
 *
 * Only the fields present in `fields` are written, so a partial edit does not
 * blank the rest. This matters after a failed generation parse, where the
 * point is to fill in what the parser could not read without losing what it
 * could.
 */
export function editContent(
  db: DB,
  contentItemId: number,
  fields: ContentFields,
  opts: { actor?: string; note?: string; now?: Date } = {},
): EditResult {
  const now = opts.now ?? new Date();
  const from = currentState(db, contentItemId);

  if (
    !FREELY_EDITABLE.includes(from) &&
    !REVOKES_APPROVAL.includes(from)
  ) {
    // Published content cannot be retroactively changed: the record would
    // then disagree with what an audience actually saw, and every analytic
    // attached to it would be about different content.
    throw new EditRefusedError(
      `Content in ${from} cannot be edited. What was published is what was ` +
        `published; create a new item instead.`,
    );
  }

  const patch: Partial<typeof contentItems.$inferInsert> = {};
  for (const key of [
    'hook',
    'body',
    'caption',
    'cta',
    'hashtags',
    'altText',
  ] as const) {
    if (fields[key] !== undefined) {
      const value = fields[key];
      patch[key] = typeof value === 'string' && value.trim() === '' ? null : value;
    }
  }

  if (Object.keys(patch).length === 0) {
    return { state: from, approvalRevoked: false };
  }

  if (REVOKES_APPROVAL.includes(from)) {
    // Cancel any pending job first — a scheduled post must not go out
    // carrying text nobody approved.
    db.update(scheduleJobs)
      .set({ status: 'CANCELLED', updatedAt: now.getTime() })
      .where(
        and(
          eq(scheduleJobs.contentItemId, contentItemId),
          inArray(scheduleJobs.status, ['PENDING', 'MISSED']),
        ),
      )
      .run();

    moveTo(db, contentItemId, 'NEEDS_REVISION', {
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
      note: opts.note ?? 'edited after approval — approval revoked',
      patch: { ...patch, scheduledAt: null },
      now,
    });

    return { state: 'NEEDS_REVISION', approvalRevoked: true };
  }

  db.transaction((tx) => {
    tx.update(contentItems)
      .set({ ...patch, updatedAt: now.getTime() })
      .where(eq(contentItems.id, contentItemId))
      .run();

    tx.insert(approvalEvents)
      .values({
        contentItemId,
        actor: opts.actor ?? 'jatin',
        action: 'EDIT',
        fromState: from,
        toState: from,
        note: opts.note ?? `edited: ${Object.keys(patch).join(', ')}`,
        createdAt: now.getTime(),
      })
      .run();
  });

  return { state: from, approvalRevoked: false };
}
