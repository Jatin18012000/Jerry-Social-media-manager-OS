'use client';

import { useActionState } from 'react';

import type { ActionResult } from '@/application/action-result';
import { saveBrand } from '@/application/brand-actions';
import type { BrandConfig } from '@/domain/brand';

function Field({
  name,
  label,
  hint,
  defaultValue,
  rows,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultValue?: string;
  rows?: number;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={name}>
        {label}
      </label>
      {hint && <p className="muted small">{hint}</p>}
      {rows ? (
        <textarea
          id={name}
          name={name}
          rows={rows}
          defaultValue={defaultValue}
          style={{ minHeight: `${rows * 1.6}rem` }}
        />
      ) : (
        <input type="text" id={name} name={name} defaultValue={defaultValue} />
      )}
    </div>
  );
}

export function BrandForm({ brand }: { brand: BrandConfig }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    saveBrand,
    null,
  );

  // The current config is prefilled as a starting point — including the
  // placeholder, which is a shape to replace rather than an answer.
  const initial = brand;

  return (
    <form action={action}>
      <Field name="brandName" label="Brand name" defaultValue={initial.brandName} />
      <Field
        name="positioning"
        label="Positioning"
        hint="What this account is for, in one or two sentences."
        defaultValue={initial.positioning}
        rows={3}
      />
      <Field
        name="audiencePrimary"
        label="Primary audience"
        defaultValue={initial.audiencePrimary}
        rows={2}
      />
      <Field
        name="audienceSecondary"
        label="Secondary audience"
        defaultValue={initial.audienceSecondary}
        rows={2}
      />
      <Field
        name="languagePolicy"
        label="Language policy"
        hint="When to use English, Hindi or Hinglish (§9)."
        defaultValue={initial.languagePolicy}
        rows={3}
      />
      <Field
        name="traits"
        label="Voice traits — one per line"
        hint="Short adjectives. How the writing should feel."
        defaultValue={initial.voice.traits.join('\n')}
        rows={4}
      />
      <Field
        name="does"
        label="Do — one per line"
        hint="Concrete instructions to follow."
        defaultValue={initial.voice.does.join('\n')}
        rows={4}
      />
      <Field
        name="avoids"
        label="Avoid — one per line"
        hint="Concrete things not to do. Usually more useful than the Do list."
        defaultValue={initial.voice.avoids.join('\n')}
        rows={4}
      />
      <Field
        name="exampleLines"
        label="Voice reference lines — one per line"
        hint="Real lines that sound right. Used to show the register, never reused verbatim."
        defaultValue={initial.voice.exampleLines.join('\n')}
        rows={4}
      />
      <Field
        name="note"
        label="What changed (optional)"
        hint="Recorded against this version."
      />

      <div className="form-row">
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save new version'}
        </button>
        {state && (
          <p className={state.ok ? 'ok small' : 'error small'}>
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
