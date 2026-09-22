'use client';

import { useActionState, useState } from 'react';

import type { ActionResult } from '@/application/action-result';
import { activateBrand, saveBrand } from '@/application/brand-actions';
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

/**
 * The brand form.
 *
 * `initial` is null whenever the placeholder is in use, and the fields start
 * empty. Prefilling them with placeholder text would put engineering-authored
 * words in front of the person whose job it is to write the real ones, and
 * accepting a prefill is exactly how a voice nobody authored comes into use
 * (§4, §5). A real brand is prefilled, because then it is Jatin's own text
 * being edited.
 */
export function BrandForm({ initial }: { initial: BrandConfig | null }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    saveBrand,
    null,
  );

  return (
    <form action={action}>
      <Field name="brandName" label="Brand name" defaultValue={initial?.brandName ?? ''} />
      <Field
        name="positioning"
        label="Positioning"
        hint="What this account is for, in one or two sentences."
        defaultValue={initial?.positioning ?? ''}
        rows={3}
      />
      <Field
        name="audiencePrimary"
        label="Primary audience"
        defaultValue={initial?.audiencePrimary ?? ''}
        rows={2}
      />
      <Field
        name="audienceSecondary"
        label="Secondary audience"
        defaultValue={initial?.audienceSecondary ?? ''}
        rows={2}
      />
      <Field
        name="languagePolicy"
        label="Language policy"
        hint="When to use English, Hindi or Hinglish (§9)."
        defaultValue={initial?.languagePolicy ?? ''}
        rows={3}
      />
      <Field
        name="traits"
        label="Voice traits — one per line"
        hint="Short adjectives. How the writing should feel."
        defaultValue={initial?.voice.traits.join('\n') ?? ''}
        rows={4}
      />
      <Field
        name="does"
        label="Do — one per line"
        hint="Concrete instructions to follow."
        defaultValue={initial?.voice.does.join('\n') ?? ''}
        rows={4}
      />
      <Field
        name="avoids"
        label="Avoid — one per line"
        hint="Concrete things not to do. Usually more useful than the Do list."
        defaultValue={initial?.voice.avoids.join('\n') ?? ''}
        rows={4}
      />
      <Field
        name="exampleLines"
        label="Voice reference lines — one per line"
        hint="Real lines that sound right. Used to show the register, never reused verbatim."
        defaultValue={initial?.voice.exampleLines.join('\n') ?? ''}
        rows={4}
      />
      <Field
        name="note"
        label="What changed (optional)"
        hint="Recorded against this version."
      />

      <div className="form-row">
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save as draft'}
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

/**
 * Puts a saved draft into use.
 *
 * Deliberately a second, separate act requiring a typed name. §4 makes the
 * brand voice a human decision, and an unattributed one is a side effect
 * rather than a decision.
 */
export function ActivateForm({ version }: { version: number }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    activateBrand,
    null,
  );

  if (!open) {
    return (
      <button type="button" className="link-button" onClick={() => setOpen(true)}>
        Activate v{version}
      </button>
    );
  }

  return (
    <form action={action} className="form-row">
      <input type="hidden" name="version" value={version} />
      <input
        name="actor"
        placeholder="Your name"
        aria-label="Your name"
        required
      />
      <button type="submit" disabled={pending}>
        {pending ? 'Activating…' : `Activate v${version}`}
      </button>
      <button type="button" className="link-button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {state && (
        <p className={state.ok ? 'ok small' : 'error small'}>{state.message}</p>
      )}
    </form>
  );
}
