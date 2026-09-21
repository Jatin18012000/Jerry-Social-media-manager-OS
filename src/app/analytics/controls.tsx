'use client';

import { useActionState, useState } from 'react';

import type { ActionResult } from '@/application/action-result';
import {
  type PreviewResult,
  readMetrics,
  saveMetrics,
} from '@/application/analytics-actions';

const FIELDS = [
  ['impressions', 'Impressions'],
  ['reach', 'Reach'],
  ['views', 'Views'],
  ['likes', 'Likes'],
  ['comments', 'Comments'],
  ['saves', 'Saves'],
  ['shares', 'Shares'],
  ['profileVisits', 'Profile visits'],
  ['follows', 'Follows'],
  ['clicks', 'Clicks'],
] as const;

/**
 * Read, then confirm — decision D4.
 *
 * The parser proposes; the human decides. Fields are left blank rather than
 * zeroed when nothing was read, because a blank means "not reported" and a
 * zero would be a fabricated metric (§40).
 */
export function CaptureForm({
  contentItemId,
  platform,
  format,
  caption,
  externalUrl,
}: {
  contentItemId: number;
  platform: string;
  format: string;
  caption: string | null;
  externalUrl: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [preview, readAction, reading] = useActionState<
    PreviewResult | null,
    FormData
  >(readMetrics, null);
  const [saved, saveAction, saving] = useActionState<
    ActionResult | null,
    FormData
  >(saveMetrics, null);

  if (saved?.ok) {
    return (
      <div className="row">
        <span className="muted">
          {platform} · {format}
        </span>
        <span className="ok small">{saved.message}</span>
      </div>
    );
  }

  return (
    <article className="item">
      <div className="item-head">
        <span>
          <strong>
            {platform} · {format}
          </strong>
        </span>
        {externalUrl ? (
          <a className="small" href={externalUrl} target="_blank" rel="noreferrer noopener">
            View post
          </a>
        ) : (
          <a className="small" href={`/content/${contentItemId}`}>
            Open
          </a>
        )}
      </div>

      {caption && <p className="summary">{caption.slice(0, 120)}</p>}

      {!open ? (
        <button
          type="button"
          className="link-button"
          onClick={() => setOpen(true)}
        >
          Capture metrics
        </button>
      ) : (
        <>
          <form action={readAction}>
            <input type="hidden" name="contentItemId" value={contentItemId} />
            <label className="field-label" htmlFor={`raw-${contentItemId}`}>
              Paste the Insights text
            </label>
            <textarea
              id={`raw-${contentItemId}`}
              name="rawText"
              placeholder={'Accounts reached\n4,210\nLikes\n312\n…'}
            />
            <div className="form-row">
              <button type="submit" disabled={reading}>
                {reading ? 'Reading…' : 'Read it'}
              </button>
              {preview && (
                <span className={preview.ok ? 'ok small' : 'warn small'}>
                  {preview.message}
                </span>
              )}
            </div>
          </form>

          <form action={saveAction}>
            <input type="hidden" name="contentItemId" value={contentItemId} />
            <input
              type="hidden"
              name="rawText"
              value={preview?.rawText ?? ''}
            />
            <input
              type="hidden"
              name="confidence"
              value={preview?.confidence ?? ''}
            />

            <p className="muted small">
              Leave a field blank if the platform did not report it — blank
              means &ldquo;not reported&rdquo;, and is stored differently from
              zero.
            </p>

            <div className="metric-grid">
              {FIELDS.map(([key, label]) => (
                <label key={key} className="metric-field">
                  <span className="field-label">{label}</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    name={key}
                    defaultValue={preview?.metrics?.[key] ?? ''}
                    placeholder="—"
                  />
                </label>
              ))}
            </div>

            <div className="form-row">
              <button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save metrics'}
              </button>
              {saved && !saved.ok && (
                <span className="error small">{saved.message}</span>
              )}
            </div>
          </form>
        </>
      )}
    </article>
  );
}
