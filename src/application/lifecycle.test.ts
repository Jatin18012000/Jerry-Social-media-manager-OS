import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import {
  approvalEvents,
  claims,
  contentItems,
  researchItems,
  sources,
} from '@/db/schema';
import { CONTENT_ACTIONS, TRANSITIONS } from '@/domain/content-state';
import {
  actionsFor,
  advancePipeline,
  attachClaims,
  historyOf,
  moveTo,
  nextPipelineStep,
  verifyClaim,
} from './content';
import {
  buildBrief,
  createContentItem,
  createOpportunity,
  scopedClaimsWithIds,
} from './opportunities';
import { submitForReview } from './qa';

/**
 * The operator lifecycle gap.
 *
 * A real item was written, briefed, and then stuck in IDEA: the early pipeline
 * transitions were legal in the domain but had no action and no control, so
 * nothing could move them. These tests hold the path open, and — more
 * importantly — hold every shortcut around it shut.
 */

let sqlite: Database.Database;
let db: DB;

function researchItem(title: string): number {
  const sourceId = db
    .insert(sources)
    .values({
      name: 'Blog',
      type: 'OFFICIAL_BLOG',
      fetcher: 'RSS',
      url: `https://example.com/${Math.random()}`,
      credibilityTier: 'PRIMARY',
    })
    .returning({ id: sources.id })
    .get().id;

  return db
    .insert(researchItems)
    .values({
      sourceId,
      title,
      url: `https://example.com/i-${Math.random()}`,
      dedupeKey: `k-${Math.random()}`,
    })
    .returning({ id: researchItems.id })
    .get().id;
}

/** A content item with no claims — the case that was stuck. */
function bareItem(): number {
  const opportunityId = createOpportunity(db, {
    title: 'A story',
    researchItemIds: [],
  });
  return createContentItem(db, {
    opportunityId,
    platform: 'INSTAGRAM',
    format: 'CAROUSEL',
    topic: 'A story',
  });
}

/** A content item carrying one claim, unverified. */
function itemWithClaim(): number {
  const researchItemId = researchItem('A source');
  db.insert(claims)
    .values({ researchItemId, text: 'A thing happened.', claimType: 'FACT' })
    .run();

  const opportunityId = createOpportunity(db, {
    title: 'A story',
    researchItemIds: [researchItemId],
  });
  const id = createContentItem(db, {
    opportunityId,
    platform: 'INSTAGRAM',
    format: 'CAROUSEL',
  });

  // §16 provenance: the guard reads the item's *linked* claims, so the link
  // has to exist for the claim to block anything.
  attachClaims(
    db,
    id,
    scopedClaimsWithIds(db, id).map((c) => c.id),
  );
  return id;
}

function fillContent(id: number): void {
  db.update(contentItems)
    .set({
      hook: 'A hook.',
      body: 'A body.',
      caption: 'A caption.',
      cta: 'Follow.',
      hashtags: 'ai',
      altText: 'Alt text.',
    })
    .where(eq(contentItems.id, id))
    .run();
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
});

describe('the bug — an item in IDEA had no way forward', () => {
  it('offers no forward §23 action from IDEA — only CANCEL', () => {
    // This is the bug precisely: the operator action set is about deciding
    // the fate of finished content, so the only thing it offered a fresh item
    // was a way to kill it. Nothing moved it forward.
    const id = bareItem();
    expect(actionsFor(db, id)).toEqual(['CANCEL']);
  });

  it('now reports a next pipeline step from IDEA', () => {
    const id = bareItem();
    expect(nextPipelineStep(db, id)).toEqual({
      from: 'IDEA',
      to: 'RESEARCHING',
    });
  });
});

describe('C — every exposed step is a legal domain transition', () => {
  it('each reported step exists in the domain transition table', () => {
    // The UI renders whatever this reports, so it must never report a move
    // the state machine would refuse.
    for (const from of ['IDEA', 'RESEARCHING', 'RESEARCH_VERIFIED'] as const) {
      const id = bareItem();
      if (from !== 'IDEA') {
        moveTo(db, id, 'RESEARCHING', { actor: 'jatin' });
      }
      if (from === 'RESEARCH_VERIFIED') {
        moveTo(db, id, 'RESEARCH_VERIFIED', { actor: 'jatin' });
      }

      const step = nextPipelineStep(db, id);
      expect(step).not.toBeNull();
      expect(TRANSITIONS[step!.from]).toContain(step!.to);
    }
  });

  it('reports nothing for states a dedicated action already owns', () => {
    // STRATEGY_READY belongs to composing a brief, GENERATING to pasting it
    // back, QA to the gate. A generic step here would be a second path.
    const id = bareItem();
    moveTo(db, id, 'RESEARCHING', { actor: 'jatin' });
    moveTo(db, id, 'RESEARCH_VERIFIED', { actor: 'jatin' });
    moveTo(db, id, 'STRATEGY_READY', { actor: 'jatin' });

    expect(nextPipelineStep(db, id)).toBeNull();
  });

  it('reports nothing from NEEDS_REVISION, which has two legal targets', () => {
    const id = bareItem();
    moveTo(db, id, 'RESEARCHING', { actor: 'jatin' });
    moveTo(db, id, 'RESEARCH_VERIFIED', { actor: 'jatin' });
    moveTo(db, id, 'STRATEGY_READY', { actor: 'jatin' });
    moveTo(db, id, 'GENERATING', { actor: 'jatin' });
    moveTo(db, id, 'QA', { actor: 'jatin' });
    moveTo(db, id, 'NEEDS_REVISION', { actor: 'jatin' });

    // Picking one would be guessing which kind of revision was meant.
    expect(nextPipelineStep(db, id)).toBeNull();
  });
});

describe('A — the legal path still works, end to end', () => {
  it('walks IDEA to READY_FOR_REVIEW using only exposed steps', () => {
    const id = bareItem();
    fillContent(id);

    advancePipeline(db, id, 'RESEARCHING', { actor: 'jatin' });
    advancePipeline(db, id, 'RESEARCH_VERIFIED', { actor: 'jatin' });
    advancePipeline(db, id, 'STRATEGY_READY', { actor: 'jatin' });

    // From here the existing purpose-built actions take over.
    moveTo(db, id, 'GENERATING', { actor: 'jatin' });
    moveTo(db, id, 'QA', { actor: 'jatin' });
    const result = submitForReview(db, id, { actor: 'jatin' });

    expect(result.ok).toBe(true);
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('READY_FOR_REVIEW');
  });
});

describe('B, D, E, F — the shortcuts stay shut', () => {
  it('refuses IDEA straight to READY_FOR_REVIEW', () => {
    const id = bareItem();
    expect(() => advancePipeline(db, id, 'READY_FOR_REVIEW', {})).toThrow();
    expect(() => moveTo(db, id, 'READY_FOR_REVIEW', {})).toThrow();
  });

  it('refuses IDEA straight to APPROVED', () => {
    const id = bareItem();
    expect(() => advancePipeline(db, id, 'APPROVED', {})).toThrow();
    expect(() => moveTo(db, id, 'APPROVED', {})).toThrow();
  });

  it('refuses IDEA straight to SCHEDULED', () => {
    const id = bareItem();
    expect(() => advancePipeline(db, id, 'SCHEDULED', {})).toThrow();
    expect(() => moveTo(db, id, 'SCHEDULED', {})).toThrow();
  });

  it('D — refuses QA straight past review', () => {
    const id = bareItem();
    fillContent(id);
    for (const to of ['RESEARCHING', 'RESEARCH_VERIFIED', 'STRATEGY_READY', 'GENERATING', 'QA'] as const) {
      moveTo(db, id, to, { actor: 'jatin' });
    }

    expect(() => moveTo(db, id, 'APPROVED', {})).toThrow();
    expect(() => advancePipeline(db, id, 'APPROVED', {})).toThrow();
  });

  it('E — refuses READY_FOR_REVIEW to APPROVED through the pipeline action', () => {
    // Legal in the domain, but it belongs to the human review screen. The
    // pipeline action must not become a second way to approve (§22).
    const id = bareItem();
    fillContent(id);
    for (const to of ['RESEARCHING', 'RESEARCH_VERIFIED', 'STRATEGY_READY', 'GENERATING', 'QA'] as const) {
      moveTo(db, id, to, { actor: 'jatin' });
    }
    submitForReview(db, id, { actor: 'jatin' });

    expect(nextPipelineStep(db, id)).toBeNull();
    expect(() => advancePipeline(db, id, 'APPROVED', {})).toThrow(
      /dedicated action/,
    );
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('READY_FOR_REVIEW');
  });

  it('F — SCHEDULED is reachable only from APPROVED', () => {
    for (const from of Object.keys(TRANSITIONS) as (keyof typeof TRANSITIONS)[]) {
      if (from === 'APPROVED') continue;
      expect(TRANSITIONS[from]).not.toContain('SCHEDULED');
    }
  });

  it('refuses a target that is not this state’s registered step', () => {
    const id = bareItem();
    // RESEARCH_VERIFIED is two steps away, not one.
    expect(() => advancePipeline(db, id, 'RESEARCH_VERIFIED', {})).toThrow(
      /next pipeline step from IDEA is RESEARCHING/,
    );
  });

  it('adds no new operator action to the §23 set', () => {
    // The fix is a missing control, not a missing rule. Growing this set
    // would change what the 340 transition tests are asserting about.
    expect([...CONTENT_ACTIONS]).toEqual([
      'APPROVE',
      'EDIT',
      'REGENERATE',
      'REJECT',
      'SCHEDULE',
      'UNSCHEDULE',
      'CANCEL',
    ]);
  });
});

describe('G, H — the claim guard is unchanged', () => {
  it('G — zero-claim content passes the guard', () => {
    // An opinion piece rests on no external claim. Requiring one would make
    // it unpublishable, which is why [].every() returning true is deliberate.
    const id = bareItem();
    advancePipeline(db, id, 'RESEARCHING', { actor: 'jatin' });
    advancePipeline(db, id, 'RESEARCH_VERIFIED', { actor: 'jatin' });

    expect(() =>
      advancePipeline(db, id, 'STRATEGY_READY', { actor: 'jatin' }),
    ).not.toThrow();
  });

  it('H — unverified claims still block STRATEGY_READY', () => {
    const id = itemWithClaim();
    advancePipeline(db, id, 'RESEARCHING', { actor: 'jatin' });
    advancePipeline(db, id, 'RESEARCH_VERIFIED', { actor: 'jatin' });

    expect(() =>
      advancePipeline(db, id, 'STRATEGY_READY', { actor: 'jatin' }),
    ).toThrow(/unverified/);

    // And nothing was written.
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('RESEARCH_VERIFIED');
  });

  it('H — the same item passes once its claim is verified', () => {
    const id = itemWithClaim();
    advancePipeline(db, id, 'RESEARCHING', { actor: 'jatin' });
    advancePipeline(db, id, 'RESEARCH_VERIFIED', { actor: 'jatin' });

    for (const claim of scopedClaimsWithIds(db, id)) {
      verifyClaim(db, claim.id, {
        status: 'VERIFIED',
        evidenceUrl: 'https://example.com/e',
        evidenceTier: 'PRIMARY',
        verifiedBy: 'jatin',
      });
    }

    expect(() =>
      advancePipeline(db, id, 'STRATEGY_READY', { actor: 'jatin' }),
    ).not.toThrow();
  });

  it('still reports the blocked step, so the operator is told why', () => {
    // Showing nothing would look identical to the bug being fixed here.
    const id = itemWithClaim();
    advancePipeline(db, id, 'RESEARCHING', { actor: 'jatin' });
    advancePipeline(db, id, 'RESEARCH_VERIFIED', { actor: 'jatin' });

    expect(nextPipelineStep(db, id)?.to).toBe('STRATEGY_READY');
  });
});

describe('I — every transition is audited', () => {
  it('records each pipeline step with its actor', () => {
    const id = bareItem();
    advancePipeline(db, id, 'RESEARCHING', { actor: 'jatin' });
    advancePipeline(db, id, 'RESEARCH_VERIFIED', { actor: 'jatin' });
    advancePipeline(db, id, 'STRATEGY_READY', { actor: 'jatin' });

    const events = historyOf(db, id);
    const moves = events.map((e) => `${e.fromState}->${e.toState}`);

    expect(moves).toContain('IDEA->RESEARCHING');
    expect(moves).toContain('RESEARCHING->RESEARCH_VERIFIED');
    expect(moves).toContain('RESEARCH_VERIFIED->STRATEGY_READY');
    expect(events.every((e) => e.actor === 'jatin')).toBe(true);
  });

  it('writes no audit event when a transition is refused', () => {
    const id = itemWithClaim();
    advancePipeline(db, id, 'RESEARCHING', { actor: 'jatin' });
    advancePipeline(db, id, 'RESEARCH_VERIFIED', { actor: 'jatin' });
    const before = db.select().from(approvalEvents).all().length;

    try {
      advancePipeline(db, id, 'STRATEGY_READY', { actor: 'jatin' });
    } catch {
      // expected
    }

    expect(db.select().from(approvalEvents).all()).toHaveLength(before);
  });
});

describe('how the item got into the observed state', () => {
  it('composing a brief from an illegal state writes the brief but does not advance', () => {
    // The other half of the report: an item with a brief, full content, and
    // still in IDEA. buildBrief only walks to GENERATING from STRATEGY_READY
    // or NEEDS_REVISION; from anywhere else it silently composes and leaves
    // the state alone, which looks from the outside like nothing happened.
    const id = bareItem();
    fillContent(id);

    const { briefId } = buildBrief(db, id, { actor: 'jatin' });

    expect(briefId).toBeGreaterThan(0);
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('IDEA');
  });

  it('the same call advances once the item is legally ready', () => {
    const id = bareItem();
    fillContent(id);
    advancePipeline(db, id, 'RESEARCHING', { actor: 'jatin' });
    advancePipeline(db, id, 'RESEARCH_VERIFIED', { actor: 'jatin' });
    advancePipeline(db, id, 'STRATEGY_READY', { actor: 'jatin' });

    buildBrief(db, id, { actor: 'jatin' });

    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('GENERATING');
  });
});
