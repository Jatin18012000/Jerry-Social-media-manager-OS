import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/client';
import * as schema from '@/db/schema';
import {
  brandConfig,
  claims,
  contentItems,
  generations,
  researchItems,
  sources,
} from '@/db/schema';
import { PLACEHOLDER_BRAND } from '@/domain/brand';
import {
  actionsFor,
  attachClaims,
  historyOf,
  itemsRestingOnUnverifiedClaims,
  moveTo,
  verifyClaim,
} from './content';
import {
  activeBrand,
  buildBrief,
  createContentItem,
  createOpportunity,
  openOpportunities,
  saveGeneration,
  scopedClaims,
} from './opportunities';

let sqlite: Database.Database;
let db: DB;

function seedResearch(): { researchItemId: number; claimId: number } {
  const sourceId = db
    .insert(sources)
    .values({
      name: 'Company X Blog',
      type: 'OFFICIAL_BLOG',
      fetcher: 'RSS',
      url: 'https://companyx.example',
      credibilityTier: 'PRIMARY',
    })
    .returning({ id: sources.id })
    .get().id;

  const researchItemId = db
    .insert(researchItems)
    .values({
      sourceId,
      title: 'Company X ships Model Y',
      url: 'https://companyx.example/model-y',
      dedupeKey: 'companyx-model-y',
    })
    .returning({ id: researchItems.id })
    .get().id;

  const claimId = db
    .insert(claims)
    .values({
      researchItemId,
      text: 'Company X released Model Y.',
      claimType: 'FACT',
      verificationStatus: 'UNVERIFIED',
    })
    .returning({ id: claims.id })
    .get().id;

  return { researchItemId, claimId };
}

/** Walks an item from IDEA to STRATEGY_READY, verifying its claims first. */
function makeReady(contentItemId: number, claimId: number): void {
  verifyClaim(db, claimId, {
    status: 'VERIFIED',
    evidenceUrl: 'https://companyx.example/model-y',
    evidenceTier: 'PRIMARY',
    verifiedBy: 'jatin',
  });
  moveTo(db, contentItemId, 'RESEARCHING');
  moveTo(db, contentItemId, 'RESEARCH_VERIFIED');
  moveTo(db, contentItemId, 'STRATEGY_READY');
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }) as unknown as DB;
  migrate(db as never, { migrationsFolder: './drizzle' });
});

describe('activeBrand', () => {
  it('falls back to the placeholder when nothing is configured', () => {
    expect(activeBrand(db).isPlaceholder).toBe(true);
  });

  it('uses an active config when one exists', () => {
    db.insert(brandConfig)
      .values({
        version: 1,
        active: true,
        payloadJson: JSON.stringify({
          ...PLACEHOLDER_BRAND,
          brandName: 'Real Brand',
          isPlaceholder: false,
        }),
      })
      .run();

    const brand = activeBrand(db);
    expect(brand.brandName).toBe('Real Brand');
    expect(brand.isPlaceholder).toBe(false);
  });

  it('falls back loudly when the stored config is malformed', () => {
    db.insert(brandConfig)
      .values({ version: 1, active: true, payloadJson: '{"brandName": ""}' })
      .run();

    expect(activeBrand(db).isPlaceholder).toBe(true);
    const events = db.select().from(schema.systemEvents).all();
    expect(events.some((e) => e.kind === 'brand_config.invalid')).toBe(true);
  });
});

describe('createOpportunity', () => {
  it('links research and marks it promoted', () => {
    const { researchItemId } = seedResearch();
    const id = createOpportunity(db, {
      title: 'Model Y launch',
      researchItemIds: [researchItemId],
    });

    expect(id).toBeGreaterThan(0);
    expect(
      db.select().from(researchItems).where(eq(researchItems.id, researchItemId)).get()
        ?.status,
    ).toBe('PROMOTED');
  });

  it('marks an opportunity expired once its window has passed', () => {
    const { researchItemId } = seedResearch();
    createOpportunity(db, {
      title: 'Time-sensitive',
      researchItemIds: [researchItemId],
      windowExpiresAt: new Date('2026-09-21T00:00:00Z'),
    });

    const open = openOpportunities(db, new Date('2026-09-25T00:00:00Z'));
    expect(open[0]?.expired).toBe(true);
  });
});

describe('createContentItem', () => {
  it('inherits the opportunity’s claims as provenance', () => {
    const { researchItemId, claimId } = seedResearch();
    const opportunityId = createOpportunity(db, {
      title: 'Model Y launch',
      researchItemIds: [researchItemId],
    });

    const contentItemId = createContentItem(db, {
      opportunityId,
      platform: 'INSTAGRAM',
      format: 'REEL',
    });

    // §21: variants differ in framing, never in the facts beneath them.
    const scoped = scopedClaims(db, contentItemId);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.text).toContain('Model Y');
    expect(claimId).toBeGreaterThan(0);
  });

  it('gives two platform variants the same claims', () => {
    const { researchItemId } = seedResearch();
    const opportunityId = createOpportunity(db, {
      title: 'Model Y launch',
      researchItemIds: [researchItemId],
    });

    const ig = createContentItem(db, {
      opportunityId,
      platform: 'INSTAGRAM',
      format: 'REEL',
    });
    const li = createContentItem(db, {
      opportunityId,
      platform: 'LINKEDIN',
      format: 'TEXT',
    });

    expect(scopedClaims(db, ig).map((c) => c.text)).toEqual(
      scopedClaims(db, li).map((c) => c.text),
    );
  });

  it('refuses a format the platform does not support', () => {
    const { researchItemId } = seedResearch();
    const opportunityId = createOpportunity(db, {
      title: 'X',
      researchItemIds: [researchItemId],
    });

    // §11: a LinkedIn Reel is not a thing.
    expect(() =>
      createContentItem(db, {
        opportunityId,
        platform: 'LINKEDIN',
        format: 'REEL',
      }),
    ).toThrow(/does not support format/);
  });

  it('starts in IDEA', () => {
    const { researchItemId } = seedResearch();
    const opportunityId = createOpportunity(db, {
      title: 'X',
      researchItemIds: [researchItemId],
    });
    const id = createContentItem(db, {
      opportunityId,
      platform: 'INSTAGRAM',
      format: 'STATIC',
    });
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('IDEA');
  });
});

describe('PRD §16 — unverified claims block progress', () => {
  it('refuses STRATEGY_READY while a linked claim is unverified', () => {
    const { researchItemId } = seedResearch();
    const opportunityId = createOpportunity(db, {
      title: 'X',
      researchItemIds: [researchItemId],
    });
    const id = createContentItem(db, {
      opportunityId,
      platform: 'INSTAGRAM',
      format: 'REEL',
    });

    moveTo(db, id, 'RESEARCHING');
    moveTo(db, id, 'RESEARCH_VERIFIED');
    expect(() => moveTo(db, id, 'STRATEGY_READY')).toThrow(
      /unverified/i,
    );
  });

  it('allows it once the claim is verified', () => {
    const { researchItemId, claimId } = seedResearch();
    const opportunityId = createOpportunity(db, {
      title: 'X',
      researchItemIds: [researchItemId],
    });
    const id = createContentItem(db, {
      opportunityId,
      platform: 'INSTAGRAM',
      format: 'REEL',
    });

    expect(() => makeReady(id, claimId)).not.toThrow();
  });

  it('writes nothing when a transition is refused', () => {
    const { researchItemId } = seedResearch();
    const opportunityId = createOpportunity(db, {
      title: 'X',
      researchItemIds: [researchItemId],
    });
    const id = createContentItem(db, {
      opportunityId,
      platform: 'INSTAGRAM',
      format: 'REEL',
    });
    moveTo(db, id, 'RESEARCHING');

    const before = historyOf(db, id).length;
    expect(() => moveTo(db, id, 'SCHEDULED')).toThrow();
    // No half-applied state, no orphan audit event.
    expect(historyOf(db, id).length).toBe(before);
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('RESEARCHING');
  });

  it('surfaces items resting on unverified claims', () => {
    const { researchItemId } = seedResearch();
    const opportunityId = createOpportunity(db, {
      title: 'X',
      researchItemIds: [researchItemId],
    });
    const id = createContentItem(db, {
      opportunityId,
      platform: 'INSTAGRAM',
      format: 'REEL',
    });

    expect(itemsRestingOnUnverifiedClaims(db).map((r) => r.id)).toEqual([id]);
  });
});

describe('verifyClaim', () => {
  it('refuses to mark VERIFIED without evidence', () => {
    const { claimId } = seedResearch();
    // §7.2 — enforced here and again by a database CHECK.
    expect(() =>
      verifyClaim(db, claimId, { status: 'VERIFIED', verifiedBy: 'jatin' }),
    ).toThrow(/requires an evidence URL and tier/);
  });

  it('accepts DISPUTED without evidence', () => {
    const { claimId } = seedResearch();
    expect(() =>
      verifyClaim(db, claimId, { status: 'DISPUTED', verifiedBy: 'jatin' }),
    ).not.toThrow();
  });
});

describe('the brief loop (decision D3)', () => {
  function readyItem() {
    const { researchItemId, claimId } = seedResearch();
    const opportunityId = createOpportunity(db, {
      title: 'Company X ships Model Y',
      thesis: 'A meaningful capability jump.',
      researchItemIds: [researchItemId],
    });
    const contentItemId = createContentItem(db, {
      opportunityId,
      platform: 'INSTAGRAM',
      format: 'REEL',
    });
    makeReady(contentItemId, claimId);
    return contentItemId;
  }

  it('builds a brief carrying the verified claim and its source', () => {
    const id = readyItem();
    const { promptText } = buildBrief(db, id, { actor: 'jatin' });

    expect(promptText).toContain('Company X released Model Y.');
    expect(promptText).toContain('Company X Blog');
    expect(promptText).toContain('tier: PRIMARY');
    expect(promptText).toContain('may be stated as fact');
  });

  it('moves the item to GENERATING', () => {
    const id = readyItem();
    buildBrief(db, id);
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.state,
    ).toBe('GENERATING');
  });

  it('warns in the brief while the brand is a placeholder', () => {
    const id = readyItem();
    expect(buildBrief(db, id).promptText).toContain(
      'BRAND VOICE NOT YET DEFINED',
    );
  });

  it('applies a parsed response and moves to QA', () => {
    const id = readyItem();
    const { briefId } = buildBrief(db, id);

    const result = saveGeneration(db, {
      contentItemId: id,
      briefId,
      rawResponse:
        '```json\n{"hook":"The hook.","body":"The body.",' +
        '"caption":"The caption.","hashtags":["ai"],"altText":"Alt."}\n```',
      provider: 'claude.ai',
      actor: 'jatin',
    });

    expect(result.parsedOk).toBe(true);

    const item = db
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, id))
      .get();
    expect(item?.state).toBe('QA');
    expect(item?.hook).toBe('The hook.');
    expect(item?.caption).toBe('The caption.');
    expect(item?.hashtags).toBe('ai');
  });

  it('persists the raw paste even when parsing fails', () => {
    // The governing constraint of D3: the human's effort must survive a
    // parser failure.
    const id = readyItem();
    const { briefId } = buildBrief(db, id);
    const raw = 'Some unstructured prose that cost real effort.';

    const result = saveGeneration(db, {
      contentItemId: id,
      briefId,
      rawResponse: raw,
    });

    expect(result.parsedOk).toBe(false);

    const generation = db
      .select()
      .from(generations)
      .where(eq(generations.id, result.generationId))
      .get();
    expect(generation?.rawResponse).toBe(raw);
    expect(generation?.parsedOk).toBe(false);
    expect(generation?.parseError).toBeTruthy();

    // The paste still becomes the body rather than vanishing.
    expect(
      db.select().from(contentItems).where(eq(contentItems.id, id)).get()?.body,
    ).toBe(raw);
  });

  it('reports which fields still need filling in by hand', () => {
    const id = readyItem();
    const { briefId } = buildBrief(db, id);
    const result = saveGeneration(db, {
      contentItemId: id,
      briefId,
      rawResponse: '## Hook\nOnly a hook.',
    });
    expect(result.missing).toContain('caption');
  });

  it('records the whole journey in the audit trail', () => {
    const id = readyItem();
    const { briefId } = buildBrief(db, id);
    saveGeneration(db, {
      contentItemId: id,
      briefId,
      rawResponse: '{"hook":"H","body":"B","caption":"C"}',
      actor: 'jatin',
    });

    const states = historyOf(db, id).map((e) => e.toState);
    expect(states).toEqual([
      'RESEARCHING',
      'RESEARCH_VERIFIED',
      'STRATEGY_READY',
      'GENERATING',
      'QA',
    ]);
  });

  it('offers review actions once at QA', () => {
    const id = readyItem();
    const { briefId } = buildBrief(db, id);
    saveGeneration(db, {
      contentItemId: id,
      briefId,
      rawResponse: '{"hook":"H","body":"B","caption":"C"}',
    });

    const actions = actionsFor(db, id);
    // §22: scheduling is not available before approval, anywhere.
    expect(actions).not.toContain('SCHEDULE');
    expect(actions).not.toContain('APPROVE');
  });
});

describe('attachClaims', () => {
  it('is idempotent', () => {
    const { researchItemId, claimId } = seedResearch();
    const opportunityId = createOpportunity(db, {
      title: 'X',
      researchItemIds: [researchItemId],
    });
    const id = createContentItem(db, {
      opportunityId,
      platform: 'INSTAGRAM',
      format: 'REEL',
    });

    attachClaims(db, id, [claimId]);
    attachClaims(db, id, [claimId]);
    expect(scopedClaims(db, id)).toHaveLength(1);
  });
});
