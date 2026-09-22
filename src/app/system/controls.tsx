'use client';

import { useState, useTransition } from 'react';

import type { ActionResult } from '@/application/action-result';
import { exportObsidian } from './actions';

export function ObsidianExportButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setResult(await exportObsidian());
          })
        }
      >
        {pending ? 'Exporting…' : 'Export to Obsidian'}
      </button>
      {result && (
        <p className={result.ok ? 'ok small' : 'error small'}>
          {result.message}
        </p>
      )}
    </div>
  );
}
