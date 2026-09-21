import { PIPELINE_STATES, TRANSITIONS } from '@/domain/content-state';

/**
 * M0 placeholder. The real dashboard (§45) arrives in M5; this exists so the
 * scaffold is a running application rather than an untested skeleton (§62
 * step 5: "Verify — run the actual application").
 */
export default function Home() {
  return (
    <main>
      <h1>Social Media OS</h1>
      <p className="muted">
        Milestone M0 — scaffold, schema and state machine. No pipeline
        behaviour is wired up yet.
      </p>

      <section className="panel">
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>
          Content pipeline (PRD §38)
        </h2>
        {PIPELINE_STATES.map((state) => (
          <div className="row" key={state}>
            <code>{state}</code>
            <span className="muted">
              <code>{TRANSITIONS[state].join(' · ') || 'terminal'}</code>
            </span>
          </div>
        ))}
      </section>

      <p className="muted" style={{ marginTop: '1.5rem', fontSize: '0.9rem' }}>
        Next: M1 — research ingestion (RSS, arXiv, Hacker News, manual URL
        drop) with dedupe, claim extraction and provenance.
      </p>
    </main>
  );
}
