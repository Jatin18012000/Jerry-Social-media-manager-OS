/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * Used to start the scheduler's background runner. Guarded to the nodejs
 * runtime because it opens a SQLite handle and sets a timer, neither of which
 * exists on the edge runtime.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startRunner } = await import('./application/runner');
  startRunner();
}
