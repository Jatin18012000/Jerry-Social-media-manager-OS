# 11. Authentication, because the app binds to the LAN

Status: Accepted — 2026-09-21

## Context

Decision D2 runs the system on the MacBook, served over the local network so
an iPad or iPhone can reach the approval queue (§46).

"Local network" is not a security boundary. Every device on that wifi can
reach the app — a guest's phone, a smart TV, anything else that has ever been
given the password. §22 makes human approval the one mandatory gate in V1, and
that gate means nothing if anyone on the network can click Approve.

Earlier milestones documented this requirement without implementing it. The
README described session auth that did not exist.

## Decision

**A single passphrase and a signed session cookie.** One user, so there is no
identity to model and nothing worth putting in a token payload beyond an
expiry.

**Fail closed.** Middleware runs on every route. A missing or too-short
`SESSION_SECRET` redirects to a page explaining the misconfiguration rather
than serving the app. A misconfiguration must never be indistinguishable from
"no auth needed" — that is how systems end up open by accident.

**Signed, not encrypted.** The token is an expiry plus an HMAC-SHA256
signature. The signature is verified *before* the expiry is read, because an
unsigned payload could otherwise claim any expiry it liked. A test forges
exactly that and asserts it is rejected.

**Timing-safe passphrase comparison.** A naive `===` returns as soon as it
finds a mismatched character, which tells an attacker how much of a guess was
right. The comparison always walks the full length and folds in the length
difference.

**Web Crypto, not `node:crypto`.** The same code runs in middleware (edge
runtime) and in the sign-in action (node runtime). A second implementation for
the second runtime would be a second thing to get wrong.

**The cookie is not `Secure`.** The app is served over plain HTTP on a home
LAN, where `Secure` would stop the cookie being set at all. It is `httpOnly`
and `sameSite=lax`, and never leaves the local network. This is a consequence
of D2 and should be revisited the day the app is served over TLS.

## Consequences

`SESSION_SECRET` and `APP_PASSPHRASE` are now required to run the app at all.
That is deliberate friction: the alternative is an approval queue open to the
network.

Adding middleware made Next compile `instrumentation.ts` for the edge runtime
as well, which broke the build on `better-sqlite3`. The hook now wraps its
import in a `NEXT_RUNTIME === 'nodejs'` check rather than returning early —
only that shape lets the compiler drop the Node-only branch.

Verified in a running server: unconfigured redirects to an explanatory page;
no cookie redirects to login while preserving the intended destination; a
forged expiry and a junk cookie are both rejected; a valid token is accepted.
