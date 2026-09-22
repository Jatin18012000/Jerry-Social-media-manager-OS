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

## Addendum — reporting orphans (2026-09-22)

Because the export never deletes, a note whose row has since been removed
stays in the vault pointing at nothing, silently. Clearing a development
database made that concrete: nine notes survived every row they described.

The export now reports those notes and the System page lists them by path. It
still deletes nothing. The reasoning that made this one-way in the first place
applies with more force to deletion than to writing — a projection that
reached back into a vault to remove files could destroy a note someone had
moved or rewritten, and the failure would be silent and unrecoverable.
Reporting gives the visibility without taking the decision.

Two judgements this required:

**Only `{id}-{slug}.md` is ours.** A file someone added themselves, or one of
ours they renamed, is not an orphan — it is a note whose provenance we cannot
determine. Calling it an orphan would invite deleting someone's own thinking.

**Orphans are judged against the whole database, not the last export.** The
export is capped at `DEFAULT_LIMIT`, so comparing the vault against one
batch would declare every note beyond the cap an orphan. That would be worse
than no report at all: it would confidently recommend deleting notes whose
rows are perfectly intact. A test pins this by exporting five notes, then
re-exporting with a limit of two and asserting no orphans.

This reads the vault, which is worth being precise about against §10. Only
filenames are read, no note content, and nothing here writes to the database.
The guard against Obsidian becoming a system of record is the absence of an
importer, and a report that moves nothing into the database is not one.

## Addendum — the approved future import path (2026-09-22, P0)

Product decision: Obsidian **remains one-way** for now. No importer is built,
and the database stays the sole system of record.

The intended future architecture is recorded here so that if an importer is
ever built, it is built this way rather than the obvious way:

```
Obsidian note → SourceFetcher → dedupe → provenance → claims
              → verification → research item
```

A note would enter through the **same ingestion path as any other source**,
with §15 dedupe, §16 claim-granular provenance and §7.2 verification. It would
become a research item and nothing more.

**An Obsidian importer may never write content state.** Not a draft, not an
approval, not a schedule, not a publication record. §22's guarantee is that
nothing publishes without human approval, and a file on disk that could move
an item toward publication would make that guarantee a property of the
filesystem. A note is a *source*, on the same footing as an RSS feed — which
is also untrusted text from outside the system.

Not implemented, and not to be implemented without a product decision.
