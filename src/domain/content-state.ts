/**
 * Content state machine — PRD §38.
 *
 * This module is the single authority on what may happen to a content item.
 *
 * Two rules from the PRD are enforced *here*, in the domain, rather than in the
 * UI or the application layer. That placement is deliberate: enforced only in
 * the UI, a routing mistake or a future API endpoint could bypass them.
 *
 *   §22  No automatic publishing. Nothing reaches SCHEDULED without first
 *        having been APPROVED by a human.
 *   §40  Platform API fails -> do not mark content as published. Nothing
 *        reaches PUBLISHED without evidence of an actual publication.
 *
 * There are no imports from the adapter layer here, and there never may be
 * (§65). This file depends on nothing but its own errors module.
 */

import { IllegalTransitionError, InvariantViolationError } from './errors';

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** The happy path through the pipeline, in order. PRD §38. */
export const PIPELINE_STATES = [
  'IDEA',
  'RESEARCHING',
  'RESEARCH_VERIFIED',
  'STRATEGY_READY',
  'GENERATING',
  'QA',
  'READY_FOR_REVIEW',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'ANALYZING',
  'LEARNED',
] as const;

/** Failure and exit states. PRD §38. */
export const FAILURE_STATES = [
  'FAILED',
  'NEEDS_REVISION',
  'REJECTED',
  'CANCELLED',
] as const;

export const CONTENT_STATES = [...PIPELINE_STATES, ...FAILURE_STATES] as const;

export type ContentState = (typeof CONTENT_STATES)[number];

/** States from which nothing further may happen. */
export const TERMINAL_STATES = ['REJECTED', 'CANCELLED', 'LEARNED'] as const;

export type TerminalState = (typeof TERMINAL_STATES)[number];

export function isTerminal(state: ContentState): state is TerminalState {
  return (TERMINAL_STATES as readonly ContentState[]).includes(state);
}

export function isContentState(value: string): value is ContentState {
  return (CONTENT_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * The complete set of legal transitions. Anything not listed here is illegal.
 *
 * Note that SCHEDULED appears as a target of APPROVED and of nothing else.
 * That single fact is the §22 human gate.
 */
export const TRANSITIONS: Readonly<
  Record<ContentState, readonly ContentState[]>
> = Object.freeze({
  IDEA: ['RESEARCHING', 'CANCELLED'],
  RESEARCHING: ['RESEARCH_VERIFIED', 'FAILED', 'CANCELLED'],
  RESEARCH_VERIFIED: ['STRATEGY_READY', 'REJECTED', 'CANCELLED'],
  STRATEGY_READY: ['GENERATING', 'REJECTED', 'CANCELLED'],
  GENERATING: ['QA', 'FAILED', 'CANCELLED'],
  QA: ['READY_FOR_REVIEW', 'NEEDS_REVISION', 'FAILED'],

  // The human gate. A person acts here; the system does not act for them.
  READY_FOR_REVIEW: ['APPROVED', 'NEEDS_REVISION', 'REJECTED'],

  // APPROVED -> SCHEDULED is the only way into SCHEDULED, anywhere.
  APPROVED: ['SCHEDULED', 'NEEDS_REVISION', 'CANCELLED'],

  // SCHEDULED -> APPROVED is "unschedule" (§23), which must not lose approval.
  SCHEDULED: ['PUBLISHING', 'APPROVED', 'NEEDS_REVISION', 'CANCELLED'],

  PUBLISHING: ['PUBLISHED', 'FAILED', 'NEEDS_REVISION'],
  PUBLISHED: ['ANALYZING'],

  // ANALYZING -> ANALYZING: metrics are re-ingested over days (§29 needs the
  // time series, not a single final number), so re-entry is legal.
  ANALYZING: ['ANALYZING', 'LEARNED'],
  LEARNED: [],

  // A failed item is never silently retried. It goes to a human (§40).
  FAILED: ['NEEDS_REVISION', 'CANCELLED'],

  // Revision re-enters the pipeline, and must pass QA and review again.
  NEEDS_REVISION: ['GENERATING', 'STRATEGY_READY', 'REJECTED', 'CANCELLED'],

  REJECTED: [],
  CANCELLED: [],
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Facts the domain needs in order to decide whether a structurally legal
 * transition is actually permitted. The application layer supplies these; the
 * domain does not go and look them up.
 */
export interface TransitionContext {
  /**
   * True when a publication_record exists for this item carrying either an
   * external platform ID (API publish) or an explicit human confirmation
   * (manual publish). Required to enter PUBLISHED. PRD §39, §40.
   */
  readonly hasPublicationEvidence?: boolean;

  /**
   * True when the item has at least one linked claim and none of its linked
   * claims are UNVERIFIED. Required to leave RESEARCH_VERIFIED. PRD §7, §16.
   */
  readonly allClaimsVerified?: boolean;

  /** Who or what is performing the transition. Recorded in the audit log. */
  readonly actor?: string;
}

interface Guard {
  readonly invariant: string;
  readonly check: (ctx: TransitionContext) => boolean;
  readonly message: string;
}

/**
 * Guards on specific target states. A transition must be in TRANSITIONS *and*
 * satisfy every guard registered for its target.
 */
const GUARDS: Readonly<Partial<Record<ContentState, readonly Guard[]>>> =
  Object.freeze({
    PUBLISHED: [
      {
        invariant: 'PRD-40-no-publish-without-evidence',
        check: (ctx) => ctx.hasPublicationEvidence === true,
        message:
          'cannot mark content PUBLISHED without a publication record ' +
          'carrying an external ID or an explicit manual confirmation',
      },
    ],
    STRATEGY_READY: [
      {
        invariant: 'PRD-16-provenance-before-strategy',
        check: (ctx) => ctx.allClaimsVerified === true,
        message:
          'cannot move to STRATEGY_READY while linked claims are unverified',
      },
    ],
  });

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** Whether the transition table permits this move, ignoring guards. */
export function canTransition(from: ContentState, to: ContentState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Throws unless the transition is both structurally legal and permitted by
 * every guard on the target state.
 */
export function assertTransition(
  from: ContentState,
  to: ContentState,
  ctx: TransitionContext = {},
): void {
  if (!canTransition(from, to)) {
    const reason = isTerminal(from)
      ? `${from} is a terminal state`
      : `legal targets are: ${TRANSITIONS[from].join(', ') || '(none)'}`;
    throw new IllegalTransitionError(from, to, reason);
  }

  for (const guard of GUARDS[to] ?? []) {
    if (!guard.check(ctx)) {
      throw new InvariantViolationError(guard.invariant, guard.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Actions (PRD §23)
// ---------------------------------------------------------------------------

export const CONTENT_ACTIONS = [
  'APPROVE',
  'EDIT',
  'REGENERATE',
  'REJECT',
  'SCHEDULE',
  'UNSCHEDULE',
  'CANCEL',
] as const;

export type ContentAction = (typeof CONTENT_ACTIONS)[number];

/**
 * Maps the operator-facing actions of §23 onto state transitions.
 *
 * DUPLICATE is deliberately absent: it creates a *new* content item rather
 * than transitioning the existing one, so it is an application-layer concern,
 * not a state transition.
 */
const ACTION_TARGETS: Readonly<Record<ContentAction, ContentState>> =
  Object.freeze({
    APPROVE: 'APPROVED',
    EDIT: 'NEEDS_REVISION',
    REGENERATE: 'GENERATING',
    REJECT: 'REJECTED',
    SCHEDULE: 'SCHEDULED',
    UNSCHEDULE: 'APPROVED',
    CANCEL: 'CANCELLED',
  });

export function targetStateFor(action: ContentAction): ContentState {
  return ACTION_TARGETS[action];
}

/** The actions an operator may legally take from a given state right now. */
export function availableActions(
  from: ContentState,
  ctx: TransitionContext = {},
): ContentAction[] {
  return CONTENT_ACTIONS.filter((action) => {
    try {
      assertTransition(from, ACTION_TARGETS[action], ctx);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The record of a state change. Every transition produces one; the application
 * layer is responsible for persisting it. PRD §43 (observability), §41 (audit).
 */
export interface TransitionEvent {
  readonly from: ContentState;
  readonly to: ContentState;
  readonly action: ContentAction | null;
  readonly actor: string;
  readonly at: Date;
  readonly note?: string;
}

/**
 * Validates and describes a transition. Returns the event to persist.
 *
 * This function does not write anything — the domain has no database. It
 * returns the event so that the caller can persist state and event in one
 * transaction, which is what makes "no silent state changes" achievable.
 */
export function transition(
  from: ContentState,
  to: ContentState,
  opts: TransitionContext & {
    action?: ContentAction;
    note?: string;
    now?: Date;
  } = {},
): TransitionEvent {
  assertTransition(from, to, opts);
  return {
    from,
    to,
    action: opts.action ?? null,
    actor: opts.actor ?? 'system',
    at: opts.now ?? new Date(),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  };
}

/** Applies a §23 action, returning the event to persist. */
export function applyAction(
  from: ContentState,
  action: ContentAction,
  opts: TransitionContext & { note?: string; now?: Date } = {},
): TransitionEvent {
  return transition(from, ACTION_TARGETS[action], { ...opts, action });
}
