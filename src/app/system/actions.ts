'use server';

/**
 * Server actions for the System screen.
 */

import { revalidatePath } from 'next/cache';

import { vaultFromEnv } from '@/adapters/obsidian/vault-writer';
import { getDb } from '@/db/runtime';
import type { ActionResult } from '@/application/action-result';
import { exportToVault } from '@/application/obsidian-export';

/**
 * Projects the database into the configured Obsidian vault (guide §10).
 *
 * Manual rather than automatic on every write. The vault is a projection, so
 * a stale one costs nothing, while a background writer touching files under
 * someone's home directory on every ingest is a surprise waiting to happen.
 */
export async function exportObsidian(): Promise<ActionResult> {
  const writer = vaultFromEnv();

  if (!writer) {
    return {
      ok: false,
      message:
        'No vault configured. Set OBSIDIAN_VAULT_PATH in .env.local to an ' +
        'absolute path and restart. Leaving it unset is a supported setup — ' +
        'Obsidian is a projection, never a system of record.',
    };
  }

  try {
    const report = await exportToVault(getDb(), writer);

    revalidatePath('/system');

    const orphans =
      report.orphans.length === 0
        ? ''
        : ` ${report.orphans.length} note(s) in the vault no longer have a ` +
          `row behind them — listed below. Nothing was deleted.`;

    const total = report.created + report.updated;
    if (total === 0 && report.failed.length === 0) {
      return { ok: true, message: `Nothing to export yet.${orphans}` };
    }

    const counts =
      `${report.created} new, ${report.updated} updated ` +
      `(${report.byFolder.research} research, ` +
      `${report.byFolder.opportunities} opportunities, ` +
      `${report.byFolder.published} published)`;

    // A partial export reports as a partial export. Claiming success over a
    // file that did not write is exactly the kind of quiet half-truth this
    // system is built to refuse.
    if (report.failed.length > 0) {
      return {
        ok: false,
        message:
          `${counts}. ${report.failed.length} note(s) failed: ` +
          `${report.failed[0]!.path} — ${report.failed[0]!.reason}`,
      };
    }

    return { ok: true, message: `${counts} in ${report.vaultRoot}.${orphans}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Export failed: ${message}` };
  }
}
