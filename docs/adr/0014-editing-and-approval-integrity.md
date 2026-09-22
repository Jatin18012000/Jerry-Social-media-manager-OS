# 14. Editing content, and what that does to approval

Status: Accepted — 2026-09-22

## Context

§23 lists Edit as one of the actions a content item must support. It was not
implemented.

Worse, three places in the system *told the user to use it*. The generation
parser's failure message says "fill in the remaining fields by hand". The
saved generation note says "fields need completing by hand". Neither was
possible: the content screen displayed the fields and offered no way to change
them.

This is the same class of defect as the README claiming authentication that
did not exist — the product describing behaviour it did not have.

It also left a real hole. The QA gate blocks on a missing caption, and after a
failed parse there was no way to supply one except regenerating, which under
decision D3 means asking a human to redo work they had already done.

## Decision

**Editing is allowed, and editing an approved item revokes the approval.**

This is the rule the whole feature turns on. §22 makes human approval the one
mandatory gate in V1. If content could be changed after approval, the approval
would be of nothing in particular — a person could approve one thing and a
different thing could go out over their name.

So an edit in `APPROVED` or `SCHEDULED`:

- applies the change,
- moves the item to `NEEDS_REVISION`,
- **cancels any pending schedule job**, so nothing goes out carrying text
  nobody approved,
- records why in the audit trail.

A test schedules an approved item, edits it, runs the scheduler at the slot,
and asserts nothing published.

**The warning is shown before the edit, not after.** Discovering afterwards
that you have unapproved and unscheduled a post is a bad surprise.

**Published content cannot be edited at all.** Not `PUBLISHING`, not
`PUBLISHED`, not `ANALYZING`. The stored record would then disagree with what
an audience actually saw, and every metric attached to it would be about
different content — which corrupts the learning engine's input in a way
nothing downstream could detect. The refusal says to create a new item
instead.

**A partial edit writes only the fields given.** After a failed parse the
point is to fill in what the parser could not read without losing what it
could. An empty string clears a field; an absent field is left alone.

## Consequences

Editing after approval costs a re-approval, which is friction on a legitimate
action — fixing a typo on an approved post means going round the loop again.
That is the correct trade: the alternative is an approval gate that guarantees
nothing.

The UI has to know which states are editable, which revoke approval, and which
refuse, duplicating knowledge the application layer already has. The
application refuses regardless, so the UI copy is a courtesy rather than the
enforcement.
