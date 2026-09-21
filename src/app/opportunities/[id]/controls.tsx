'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { ActionResult } from '@/application/action-result';
import { addVariant } from '@/application/content-actions';
import { formatsFor, type Platform } from '@/domain/content';

/**
 * §11: the format list follows the chosen platform, so an impossible
 * combination cannot be submitted. The application layer refuses it too.
 */
export function AddVariantForm({ opportunityId }: { opportunityId: number }) {
  const [platform, setPlatform] = useState<Platform>('INSTAGRAM');
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    addVariant,
    null,
  );
  const router = useRouter();

  useEffect(() => {
    if (state?.ok && state.redirectTo) router.push(state.redirectTo);
  }, [state, router]);

  return (
    <form action={action} className="form-row">
      <input type="hidden" name="opportunityId" value={opportunityId} />

      <select
        name="platform"
        value={platform}
        onChange={(e) => setPlatform(e.target.value as Platform)}
        aria-label="Platform"
      >
        <option value="INSTAGRAM">Instagram</option>
        <option value="LINKEDIN">LinkedIn</option>
      </select>

      <select name="format" aria-label="Format">
        {formatsFor(platform).map((format) => (
          <option key={format} value={format}>
            {format}
          </option>
        ))}
      </select>

      <button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Add variant'}
      </button>

      {state && !state.ok && <p className="error small">{state.message}</p>}
    </form>
  );
}
