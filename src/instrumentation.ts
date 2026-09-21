/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * Starts the scheduler's background runner.
 *
 * The runtime check wraps the import rather than returning early. Once
 * middleware exists, Next compiles this file for the edge runtime as well,
 * and only this shape lets it drop the Node-only branch — an early return
 * leaves the import statically reachable and the edge build fails trying to
 * resolve better-sqlite3.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startRunner } = await import('./application/runner');
    startRunner();
  }
}
