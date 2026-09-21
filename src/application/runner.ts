/**
 * The background job runner — PRD §24, decision D2.
 *
 * Runs inside the Next.js server process. There is no separate worker: §54
 * warns against unnecessary services, and a single-user system on one MacBook
 * does not need one.
 *
 * Started once from instrumentation.ts. The interval is short relative to the
 * grace window, so a job is normally picked up within a minute of its slot —
 * and one that is not, because the machine was asleep, is marked MISSED rather
 * than fired late (D2).
 */

import { getDb } from '@/db/runtime';
import { createPublisherRegistry } from '@/adapters/publishers';
import { systemEvents } from '@/db/schema';
import { runDueJobs } from './schedule';

const POLL_INTERVAL_MS = 30_000;

const KEY = Symbol.for('socialmediaos.runner');

type GlobalWithRunner = typeof globalThis & {
  [KEY]?: { timer: NodeJS.Timeout; running: boolean };
};

async function tick(): Promise<void> {
  const store = globalThis as GlobalWithRunner;
  const state = store[KEY];

  // Never overlap runs: a slow publish must not have a second tick start
  // alongside it. Job claiming would catch it, but not overlapping is cheaper.
  if (!state || state.running) return;
  state.running = true;

  try {
    const db = getDb();
    const publishers = createPublisherRegistry(
      process.env.PUBLISHER_MODE === 'LIVE' ? 'LIVE' : 'MANUAL',
    );
    const report = await runDueJobs(db, (platform) => publishers.for(platform));

    if (report.published > 0 || report.missed > 0 || report.failed > 0) {
      db.insert(systemEvents)
        .values({
          kind: 'runner.tick',
          severity: report.failed > 0 ? 'WARN' : 'INFO',
          payload: JSON.stringify(report),
        })
        .run();
    }
  } catch (error) {
    // A runner that dies on one bad tick stops publishing entirely, which is
    // worse than any single failure it was reacting to.
    console.error('[runner] tick failed', error);
  } finally {
    state.running = false;
  }
}

export function startRunner(): void {
  const store = globalThis as GlobalWithRunner;

  // Next.js re-executes modules on hot reload; without this the intervals
  // stack up and every job gets several concurrent runners.
  if (store[KEY]) return;

  const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  // Do not hold the process open purely for the scheduler.
  timer.unref?.();

  store[KEY] = { timer, running: false };

  console.log(
    `[runner] started, polling every ${POLL_INTERVAL_MS / 1000}s ` +
      `(mode: ${process.env.PUBLISHER_MODE ?? 'MANUAL'})`,
  );
}

export function stopRunner(): void {
  const store = globalThis as GlobalWithRunner;
  if (!store[KEY]) return;
  clearInterval(store[KEY].timer);
  delete store[KEY];
}
