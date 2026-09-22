# 16. Obsidian as a one-way projection

Status: Accepted — 2026-09-22

## Context

The Claude Code Implementation & Automation Guide (§10) allows Obsidian as a
human-readable knowledge and memory layer, with one condition: it must not
become the only system of record. CLAUDE.md states the same rule from the
other direction — the database is authoritative for content state, approvals,
schedules and analytics, and no other system may become so.

Obsidian is genuinely useful here. The database answers queries; it does not
answer "what do I actually know about this story, and what did I think about
it last week?" That is the question a vault is good at, and it is the question
§67 cares about — a system that learns, not one that just produces.

The risk is not that the notes are wrong. It is that they become a second
account of what the system knows. Two writable stores of the same facts drift,
and once they have drifted, which one is true becomes a matter of whichever
was touched last.

## Decision

**The vault is a one-way projection, and there is no importer.**

The export reads the database and writes Markdown. Nothing reads Markdown back.
That is not a promise in a document; it is the absence of code. A note can be
edited, corrupted or deleted and the system is unaffected, because nothing
downstream depends on it. Delete the whole folder, run the export again, and
nothing is lost.

Three consequences follow, and each was a deliberate choice:

**Notes are disposable but annotations are not.** The generated body sits
between `<!-- smos:generated:start -->` and `<!-- smos:generated:end -->`.
Everything outside that region — including a `## My notes` heading the export
adds on first write — is preserved on every re-export. A projection that ate
your thinking on each run would be a projection nobody would think in. A file
with no markers at all (hand-written, or from an older export) keeps all of
its content and gets the generated block prepended; the export truncates
nothing it did not itself write.

**Export is manual, not automatic.** Triggered from the System page. A
background writer touching files under someone's home directory on every
ingest is a surprise, and a stale projection costs nothing — which is exactly
the property that makes it safe to leave stale.

**A partial export reports as partial.** One unwritable file does not abandon
the other 199, and the report names what failed. Reporting success over a file
that did not write is the same class of quiet half-truth as a fabricated
metric.

## Path safety

This is the only code in the system that writes outside the project directory,
to a path the user supplies, with filenames derived from **research titles
that come from RSS feeds** — arbitrary text from the open internet. A title of
`../../.ssh/authorized_keys` is not a hypothetical attack; it is a string, and
strings arrive.

Two independent layers, because one would be a single point of failure:

1. `slugify` builds names by **allow-listing** `\p{L}` and `\p{N}` — letters
   and digits — rather than blocklisting the characters known to be dangerous.
   A blocklist is a guess about what is dangerous; an allow-list cannot be
   surprised. Path separators, dots, null bytes and control characters cannot
   survive it. Names are capped, cannot start with a dot, and reserved device
   names (`con`, `nul`) are suffixed.
2. `resolveInside` resolves every path against the vault root and refuses
   anything that lands outside it, or on the root itself. If this layer ever
   fires, layer 1 has a bug and the write must not happen.

Filenames are `${id}-${slug}.md`. The id makes collisions impossible, so two
identical headlines cannot overwrite each other, and the slug keeps the name
readable.

No default vault path, and no guessing. Unset is the normal configuration and
writes nothing.

## The rules that follow the data into the vault

A knowledge layer that presents facts differently from the UI is a second,
wrong account of what the system knows. So:

- **§7.3** — every claim shows its type and verification status. An inference
  is never rendered like a fact, and a note carrying unverified claims says so
  above them.
- **§40** — an unreported metric is an em-dash, never `0`, and the note says
  what the dash means. An item with no snapshot says "No metrics captured yet"
  rather than showing a table of zeroes.
- **§7.1** — the vault states nothing the database does not hold. Research
  notes render `pillar: null` because ingest does not persist the classified
  pillar; naming a plausible one would be inventing it.

## Consequences

- Obsidian cannot become a system of record, by construction rather than by
  discipline.
- The vault is a working set (`DEFAULT_LIMIT`), not a full mirror. It is for
  thinking about recent work, not archival.
- A variant that has not published yet is linked but has no note, so the
  wikilink is unresolved until it does. Obsidian shows unresolved links
  distinctly, and the link becomes live on the next export after publishing.
- If a vault is ever wanted as an *input* — notes as a research source — it
  must arrive as a `SourceFetcher` through the normal ingestion path, with
  dedupe, claims and provenance. It must not arrive as an importer that writes
  content state.
