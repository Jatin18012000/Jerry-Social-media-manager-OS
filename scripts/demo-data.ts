/**
 * Inserts one worked example through the whole M1–M2 loop, for development.
 *
 * Research item -> claims -> opportunity -> two platform variants -> claim
 * verification -> brief -> pasted generation. Useful for seeing the screens
 * with real data without waiting on a live feed poll.
 *
 * Writes to the configured database. Not used by tests, and never run
 * automatically.
 *
 * Run with: npm run db:demo
 */

import { eq } from 'drizzle-orm';

import { createDb } from '@/db/client';
import { claims, researchItems, sources } from '@/db/schema';
import { act, historyOf, moveTo, verifyClaim } from '@/application/content';
import { submitForReview } from '@/application/qa';
import { confirmManualPublish, runDueJobs, scheduleItem } from '@/application/schedule';
import { createPublisherRegistry } from '@/adapters/publishers';
import { previewReading, saveReading } from '@/application/analytics';
import type { Platform } from '@/domain/content';
import {
  buildBrief,
  createContentItem,
  createOpportunity,
  saveGeneration,
  scopedClaimsWithIds,
} from '@/application/opportunities';

const db = createDb(process.env.DATABASE_URL ?? './data/os.db');

const source = db
  .select()
  .from(sources)
  .where(eq(sources.name, 'OpenAI Blog'))
  .get();

if (!source) {
  throw new Error('Run `npm run db:seed` first — no sources are configured.');
}

const stamp = Date.now();

const researchItemId = db
  .insert(researchItems)
  .values({
    sourceId: source.id,
    title: 'OpenAI ships a new reasoning model',
    url: `https://openai.com/news/demo-${stamp}`,
    summary:
      'OpenAI released a new reasoning model for developers today. ' +
      'The company will expand availability next year.',
    dedupeKey: `demo-${stamp}`,
    relevanceScore: 0.8,
  })
  .returning({ id: researchItems.id })
  .get().id;

db.insert(claims)
  .values([
    {
      researchItemId,
      text: 'OpenAI released a new reasoning model for developers today.',
      claimType: 'FACT',
    },
    {
      researchItemId,
      text: 'The company will expand availability next year.',
      claimType: 'PREDICTION',
    },
  ])
  .run();

const opportunityId = createOpportunity(db, {
  title: 'OpenAI reasoning model launch',
  thesis: 'A real capability jump, not a rebrand.',
  researchItemIds: [researchItemId],
});

// §21: one story, two platform-native variants resting on the same claims.
const instagram = createContentItem(db, {
  opportunityId,
  platform: 'INSTAGRAM',
  format: 'REEL',
});
const linkedin = createContentItem(db, {
  opportunityId,
  platform: 'LINKEDIN',
  format: 'TEXT',
});

for (const claim of scopedClaimsWithIds(db, instagram)) {
  verifyClaim(db, claim.id, {
    status: 'VERIFIED',
    evidenceUrl: 'https://openai.com/news/official',
    evidenceTier: 'PRIMARY',
    verifiedBy: 'demo',
  });
}

moveTo(db, instagram, 'RESEARCHING');
moveTo(db, instagram, 'RESEARCH_VERIFIED');
moveTo(db, instagram, 'STRATEGY_READY');

const { briefId } = buildBrief(db, instagram, { actor: 'demo' });

const result = saveGeneration(db, {
  contentItemId: instagram,
  briefId,
  rawResponse:
    '```json\n' +
    JSON.stringify(
      {
        hook: 'OpenAI shipped something quietly significant.',
        body: 'Beat one.\nBeat two.',
        caption: 'Here is what actually changed.',
        cta: 'Follow for more',
        hashtags: ['AI', 'OpenAI'],
        altText: 'Announcement screenshot.',
      },
      null,
      2,
    ) +
    '\n```',
  provider: 'claude.ai',
  actor: 'demo',
});

// Through the QA gate, approval and scheduling, so the review and schedule
// screens have something real on them.
const qa = submitForReview(db, instagram, { actor: 'demo' });

const INSIGHTS_PANEL = `
Accounts reached
4,210
Likes
312
Comments
24
Saves
88
Shares
15
Follows
37
`;

async function finish(): Promise<void> {
  if (!qa.ok) return;

  act(db, instagram, 'APPROVE', { actor: 'demo' });

  // Schedule in the past-but-inside-grace so the runner picks it up now and
  // the whole publish -> measure path is exercised.
  const slot = new Date(Date.now() + 3 * 60_000);
  scheduleItem(db, { contentItemId: instagram, runAt: slot, actor: 'demo' });

  const registry = createPublisherRegistry('MANUAL');
  await runDueJobs(db, (p: Platform) => registry.for(p), {
    now: new Date(slot.getTime() + 60_000),
  });

  confirmManualPublish(db, {
    contentItemId: instagram,
    externalUrl: 'https://instagram.com/p/demo',
    confirmedBy: 'demo',
  });

  // §26/§40: read, then confirm. Only what was read gets stored.
  const preview = previewReading(db, instagram, INSIGHTS_PANEL);
  saveReading(db, {
    contentItemId: instagram,
    metrics: preview.parsed.metrics,
    source: 'OCR',
    rawText: INSIGHTS_PANEL,
    confidence: preview.parsed.confidence,
    confirmedBy: 'demo',
  });

  console.log(
    `  metrics read: ${Object.keys(preview.parsed.metrics).join(', ')} ` +
      `(confidence ${preview.parsed.confidence})`,
  );
}

void finish().then(() => {
  console.log(`opportunity ${opportunityId}`);
console.log(`  qa passed: ${qa.ok} (${qa.report.warnings.length} warning(s))`);
console.log(`  instagram variant ${instagram} — /content/${instagram}`);
console.log(`  linkedin variant  ${linkedin} — /content/${linkedin}`);
console.log(`  parsed: ${result.parsedOk}`);
  console.log(`  history: ${historyOf(db, instagram).map((e) => e.toState).join(' -> ')}`);
});
