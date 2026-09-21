import { describe, expect, it } from 'vitest';

import {
  CONTENT_ACTIONS,
  CONTENT_STATES,
  type ContentState,
  TERMINAL_STATES,
  TRANSITIONS,
  applyAction,
  assertTransition,
  availableActions,
  canTransition,
  isContentState,
  isTerminal,
  targetStateFor,
  transition,
} from './content-state';
import { IllegalTransitionError, InvariantViolationError } from './errors';

/**
 * A context that satisfies every guard, so that exhaustive structural tests
 * exercise the transition table rather than the guards. Guards get their own
 * dedicated tests below.
 */
const PERMISSIVE = {
  hasPublicationEvidence: true,
  allClaimsVerified: true,
} as const;

describe('state inventory', () => {
  it('has no duplicate states', () => {
    expect(new Set(CONTENT_STATES).size).toBe(CONTENT_STATES.length);
  });

  it('defines transitions for every state', () => {
    for (const state of CONTENT_STATES) {
      expect(TRANSITIONS[state], `missing entry for ${state}`).toBeDefined();
    }
  });

  it('never lists a target that is not a known state', () => {
    for (const state of CONTENT_STATES) {
      for (const target of TRANSITIONS[state]) {
        expect(isContentState(target), `${state} -> ${target}`).toBe(true);
      }
    }
  });

  it('never lists the same target twice', () => {
    for (const state of CONTENT_STATES) {
      const targets = TRANSITIONS[state];
      expect(new Set(targets).size, `duplicates in ${state}`).toBe(
        targets.length,
      );
    }
  });
});

describe('exhaustive transition matrix', () => {
  // Every ordered pair of states is asserted, so a future edit to the table
  // cannot quietly open a path that nothing tests.
  const pairs: Array<[ContentState, ContentState]> = CONTENT_STATES.flatMap(
    (from) => CONTENT_STATES.map((to) => [from, to] as [ContentState, ContentState]),
  );

  it('covers every ordered pair of states', () => {
    expect(pairs.length).toBe(CONTENT_STATES.length ** 2);
  });

  it.each(pairs)('%s -> %s behaves as the table declares', (from, to) => {
    const legal = TRANSITIONS[from].includes(to);
    expect(canTransition(from, to)).toBe(legal);

    if (legal) {
      expect(() => assertTransition(from, to, PERMISSIVE)).not.toThrow();
    } else {
      expect(() => assertTransition(from, to, PERMISSIVE)).toThrow(
        IllegalTransitionError,
      );
    }
  });
});

describe('PRD §22 — the human approval gate', () => {
  it('permits SCHEDULED only from APPROVED', () => {
    const sources = CONTENT_STATES.filter((s) =>
      TRANSITIONS[s].includes('SCHEDULED'),
    );
    expect(sources).toEqual(['APPROVED']);
  });

  it.each(
    CONTENT_STATES.filter((s) => s !== 'APPROVED'),
  )('refuses to schedule directly from %s', (from) => {
    expect(() => assertTransition(from, 'SCHEDULED', PERMISSIVE)).toThrow(
      IllegalTransitionError,
    );
  });

  it('has no path from READY_FOR_REVIEW to SCHEDULED that skips APPROVED', () => {
    expect(TRANSITIONS.READY_FOR_REVIEW).not.toContain('SCHEDULED');
    expect(TRANSITIONS.READY_FOR_REVIEW).toContain('APPROVED');
  });

  it('keeps approval when unscheduling, rather than dropping to review', () => {
    // §23 lists Unschedule as an action; it must not discard the human's
    // approval, or every reschedule would demand re-approval.
    expect(TRANSITIONS.SCHEDULED).toContain('APPROVED');
    const event = applyAction('SCHEDULED', 'UNSCHEDULE');
    expect(event.to).toBe('APPROVED');
  });
});

describe('PRD §40 — nothing is published without evidence', () => {
  it('permits PUBLISHED only from PUBLISHING', () => {
    const sources = CONTENT_STATES.filter((s) =>
      TRANSITIONS[s].includes('PUBLISHED'),
    );
    expect(sources).toEqual(['PUBLISHING']);
  });

  it('rejects PUBLISHING -> PUBLISHED without publication evidence', () => {
    expect(() =>
      assertTransition('PUBLISHING', 'PUBLISHED', {
        hasPublicationEvidence: false,
      }),
    ).toThrow(InvariantViolationError);
  });

  it('rejects PUBLISHING -> PUBLISHED when evidence is simply absent', () => {
    expect(() => assertTransition('PUBLISHING', 'PUBLISHED', {})).toThrow(
      InvariantViolationError,
    );
  });

  it('allows PUBLISHING -> PUBLISHED once evidence exists', () => {
    expect(() =>
      assertTransition('PUBLISHING', 'PUBLISHED', {
        hasPublicationEvidence: true,
      }),
    ).not.toThrow();
  });

  it('routes a failed publish to a human, never to PUBLISHED', () => {
    expect(TRANSITIONS.PUBLISHING).toContain('FAILED');
    expect(TRANSITIONS.FAILED).not.toContain('PUBLISHED');
    expect(TRANSITIONS.FAILED).toContain('NEEDS_REVISION');
  });
});

describe('PRD §16 — provenance before strategy', () => {
  it('rejects STRATEGY_READY while claims are unverified', () => {
    expect(() =>
      assertTransition('RESEARCH_VERIFIED', 'STRATEGY_READY', {
        allClaimsVerified: false,
      }),
    ).toThrow(InvariantViolationError);
  });

  it('allows STRATEGY_READY once every claim is verified', () => {
    expect(() =>
      assertTransition('RESEARCH_VERIFIED', 'STRATEGY_READY', {
        allClaimsVerified: true,
      }),
    ).not.toThrow();
  });
});

describe('terminal states', () => {
  it.each(TERMINAL_STATES)('%s has no outbound transitions', (state) => {
    expect(TRANSITIONS[state]).toEqual([]);
    expect(isTerminal(state)).toBe(true);
  });

  it.each(TERMINAL_STATES)('%s refuses every outbound move', (from) => {
    for (const to of CONTENT_STATES) {
      expect(() => assertTransition(from, to, PERMISSIVE)).toThrow(
        IllegalTransitionError,
      );
    }
  });

  it('reports non-terminal states as non-terminal', () => {
    expect(isTerminal('APPROVED')).toBe(false);
    expect(isTerminal('IDEA')).toBe(false);
  });
});

describe('graph reachability', () => {
  const reachableFrom = (start: ContentState): Set<ContentState> => {
    const seen = new Set<ContentState>([start]);
    const queue: ContentState[] = [start];
    while (queue.length > 0) {
      const current = queue.shift() as ContentState;
      for (const next of TRANSITIONS[current]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };

  it('can reach every state from IDEA', () => {
    const reachable = reachableFrom('IDEA');
    const unreachable = CONTENT_STATES.filter((s) => !reachable.has(s));
    expect(unreachable).toEqual([]);
  });

  it('can reach LEARNED from IDEA — the §67 flywheel closes', () => {
    expect(reachableFrom('IDEA').has('LEARNED')).toBe(true);
  });

  it('walks the documented happy path end to end', () => {
    const path: ContentState[] = [
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
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i] as ContentState;
      const to = path[i + 1] as ContentState;
      expect(() => assertTransition(from, to, PERMISSIVE)).not.toThrow();
    }
  });

  it('allows ANALYZING to re-enter itself for repeated metric ingestion', () => {
    // §29 needs a time series; metrics move for days after publishing.
    expect(() =>
      assertTransition('ANALYZING', 'ANALYZING', PERMISSIVE),
    ).not.toThrow();
  });
});

describe('transition events', () => {
  it('describes the change without performing it', () => {
    const now = new Date('2026-09-21T10:00:00Z');
    const event = transition('READY_FOR_REVIEW', 'APPROVED', {
      actor: 'jatin',
      note: 'looks good',
      now,
    });
    expect(event).toEqual({
      from: 'READY_FOR_REVIEW',
      to: 'APPROVED',
      action: null,
      actor: 'jatin',
      at: now,
      note: 'looks good',
    });
  });

  it('defaults the actor to system and omits an absent note', () => {
    const event = transition('IDEA', 'RESEARCHING');
    expect(event.actor).toBe('system');
    expect(event.action).toBeNull();
    expect('note' in event).toBe(false);
  });

  it('throws rather than returning an event for an illegal move', () => {
    expect(() => transition('IDEA', 'PUBLISHED')).toThrow(
      IllegalTransitionError,
    );
  });
});

describe('actions (PRD §23)', () => {
  it('maps every action to a known state', () => {
    for (const action of CONTENT_ACTIONS) {
      expect(isContentState(targetStateFor(action))).toBe(true);
    }
  });

  it('records the action on the resulting event', () => {
    const event = applyAction('READY_FOR_REVIEW', 'APPROVE', {
      actor: 'jatin',
    });
    expect(event.action).toBe('APPROVE');
    expect(event.to).toBe('APPROVED');
  });

  it('refuses an action that is illegal from the current state', () => {
    expect(() => applyAction('IDEA', 'APPROVE')).toThrow(
      IllegalTransitionError,
    );
  });

  it('offers a human review and rejection at READY_FOR_REVIEW', () => {
    const actions = availableActions('READY_FOR_REVIEW', PERMISSIVE);
    expect(actions).toContain('APPROVE');
    expect(actions).toContain('REJECT');
    expect(actions).toContain('EDIT');
    expect(actions).not.toContain('SCHEDULE');
  });

  it('offers scheduling only once approved', () => {
    expect(availableActions('APPROVED', PERMISSIVE)).toContain('SCHEDULE');
    expect(availableActions('QA', PERMISSIVE)).not.toContain('SCHEDULE');
  });

  it('offers nothing at all in a terminal state', () => {
    for (const state of TERMINAL_STATES) {
      expect(availableActions(state, PERMISSIVE)).toEqual([]);
    }
  });
});
