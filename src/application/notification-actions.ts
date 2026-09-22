'use server';

/** Server actions for the notification inbox — PRD §47. */

import { revalidatePath } from 'next/cache';

import { getDb } from '@/db/runtime';
import { markAllRead, markRead } from '@/adapters/notifiers/in-app-notifier';
import type { ActionResult } from './action-result';

export type { ActionResult } from './action-result';

function refresh(): void {
  revalidatePath('/notifications');
  revalidatePath('/');
}

export async function dismissNotification(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const id = Number(formData.get('id'));
  if (!Number.isInteger(id)) {
    return { ok: false, message: 'Unknown notification.' };
  }

  try {
    markRead(getDb(), id);
    refresh();
    return { ok: true, message: 'Dismissed.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}

export async function dismissAll(): Promise<ActionResult> {
  try {
    const count = markAllRead(getDb());
    refresh();
    return { ok: true, message: `Dismissed ${count}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}
