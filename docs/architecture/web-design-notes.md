# `apps/web` — design notes

Rationale and recorded decisions for the end-user web app. Working conventions
are [`apps/web/CLAUDE.md`](../../apps/web/CLAUDE.md); measured chain behavior is
[`docs/specs/chain-facts.md`](../specs/chain-facts.md). This document holds the
*why* — read it before changing a session boundary, the tx lifecycle, the
broadcast allowlist, or a live/indexed composition.

## The two planes

The app composes a **live** plane (LCD read from this server — canonical, "true
right now") and an **indexed** plane (`services/api` — the durable mirror, as of
a height). `services/api` is DB-only by design (ADR-001 Decision 1), so anything
that must be current is read here.

Every composed figure carries a §12.1 honesty label, and every figure is "n/a"
when null, **never 0**. A mirrored figure is never shown as current.

**Live decides membership; indexed only enriches.** `validator_registry` is
written by the validator-sampler, which is anchored to epoch cranks, and epochs
are calendar-monthly — so the indexed set can lag by up to a month. When the
indexed plane decided ownership, a just-enrolled validator was absent from the
operator's own page and a just-unregistered one still showed its action buttons,
contradicting the action the operator had just taken on that very page. The
indexed plane decides membership **only** when the live read failed: a stale
list beats an empty page. A validator with no indexed row yet reports null
totals, never `0` — "not sampled yet" is not "nothing paid".

**A live read failure is never evidence of a prune** (chain-facts §x/group 3).
`prunedAtHeight` from the mirror is the only source of "pruned", and a pruned
proposal is never live-read.

## Session and identity

Login is nonce → ADR-36 → HttpOnly opaque-id cookie over a server row.
`app/lib/adr36.ts` is the **one** sign-doc construction site for client and
server, so the two cannot drift.

Personal loaders reach the acting address **only** through
`getSessionContext` / `requireSession` — never a query param. Roles are live
chain reads per refresh, never persisted, because a persisted role outlives the
membership that justified it.

**Public reads must stay public.** Proposals and votes are public chain facts
with no address keying, so the governance routes do *not* join the personal-route
list; they use `getSessionContext` (null for anonymous) purely to highlight the
connected member's own row, never `requireSession`. Gated by the governance
block in `test/session-scope.test.ts`.

The layering is strict: models (`app/lib/models/*.server.ts`) are the only Prisma
import sites; services (`app/lib/services/*.server.ts`) hold the logic with no
Prisma, no fetch, no clock. That split is what lets routes and tests run
storeless.

## Fee basis

See chain-facts §flatfees. The short version, because this shipped wrong once
and only a test prevents it recurring: the simulate result **is** the fee, used
verbatim. Price 1nhash, not a tunable. No adjustment buffer.
`gasLimit == amount`. Pinned by `test/tx-fee.test.ts`.

`FEE_PROVISION_NHASH` is only preflight's pre-simulation reserve and stays
small — an inflated reserve reports `insufficient-balance` for affordable
transactions.

## The two-level broadcast allowlist

`ALLOWED_MSG_TYPE_URLS` is **two-level**, and this is the convention most likely
to be broken by someone reading only the first level.

`MsgExecuteContract` is in the allowlist *only* because `guardOperatorExecute`
runs for that type URL alone. On its own, the entry would authorize any call to
any contract. The guard checks:

1. the configured contract,
2. a single top-level key from the closed operator variant set (no admin or
   keeper variant),
3. the per-variant body,
4. funds discipline,
5. **canonical byte equality** with `operatorInnerJson`.

Step 5 is what keeps this out of a parser arms race.

**Extending either level — a new type URL or a new variant — is a design-review
event, never an edit.**

Broadcast is the §12.3 guarded signed-tx relay: closed msg allowlist, sole
signer must derive the session address, size and rate caps. The browser never
talks to the LCD or the API directly.

## The preflight fact rule

Every fact in `OperatorPreflightFacts` is nullable (a failed live read), and a
variant **must short-circuit to `chain-unavailable` on every fact it consumes**:

- `validators` / `chainValidator` up front, for all variants;
- `spendableNhash` in the payment branch;
- `jailReports` + `halted` in the purge branch.

Skipping a check on a null instead returns an empty (green) reason list for an
action the contract then rejects — which is the "silently hiding it" the module
forbids. A variant is equally forbidden from blocking on a fact it does **not**
consume. Both directions are gated in `test/tx-preflight.test.ts`.

Payments carry **no** operator check — paying is permissionless
(chain-facts §contract 4). `register_participation`'s operator check needs no
chain read at all: the contract's `is_operator` compares decoded bech32 payloads
(chain-facts §contract 2), so `sameBech32Payload` restates it locally.

`MAX_PROGRAM_VALIDATORS` mirrors the contract's `MAX_VALIDATORS` and moves with
it in the same change.

## Operator view: unregistered but not manageable

An unregistered validator stays in the list so its history is reachable, is
badged `unregistered` in the switcher, and its action panel is replaced by an
enrol-only affordance. Every other program action would be rejected by the
contract for a validator no longer in the set, so offering it invites a
transaction guaranteed to fail.

The rule is `selectedActive`, decided in the **loader** rather than in JSX so it
is unit-testable. Default selection prefers an enrolled validator; an explicit
`?valoper=` still reaches an unregistered one. `ownedValopers` — which seeds the
purge claimant, itself required to be enrolled — carries active valopers only.

The commission banner has three states — in-arrears / current / **prepaid** —
because program commission is cumulative while TIP resets each epoch, and the
prepaid credit comes from the live plane alone (chain-facts §contract 1).

Net-benefit's earnings term is a labeled **estimate** (§7 Q2); when it cannot be
computed the net is withheld too. Peer-rank context is deliberately absent
(§7 Q5 unapproved).

## Governance decoding is a closed union

`MsgSend` plus `MsgExecuteContract` against the configured contract, whose
variant vocabulary is **imported** from `app/tx/build.ts`
(`OPERATOR_VARIANTS` / `ADMIN_VARIANTS` / `KEEPER_VARIANTS`). The last two are
named there for this reader and for the rejection matrix; naming them admits
nothing — the allowlist is unchanged.

Anything else is a tagged `unknown` carrying the exact JSON, which rides on
every message either way. Decoding an unknown message as "nothing" would hide
what is being voted on.

**The offline corpus is ungoverned** — its contract predates its group, and M7
F2 has no admin-rotation path. So offline e2e exercises the mirror plus the
honest live-unresolved state, and the governed plane is covered by MSW overrides
plus `e2e-live`.

## Notifier

A separate worker entrypoint in this codebase (ADR-001 Decision 3), living
**outside `app/`** so the React Router build never bundles it.

It uses **relative** imports, not the `~` alias, because Node's strip-only
TypeScript runs it directly. For the same reason, files it loads at runtime must
avoid **parameter properties** (use explicit field assignment), `enum`, and
`namespace`.

Exactly-once delivery is `commitTick`: insert `skipDuplicates` + cursor advance
in one transaction. The redemptions stream cursors on the compound
`<height>:<request_id>` keyset so a same-height burst larger than one fact page
pages through completely. The nav-step stream clamps its public `/epochs` page
to `EPOCHS_PAGE_LIMIT` (200) since `factLimit` may lawfully be up to 500.

## Web Push — the one accepted SECURITY.md exception

Opt-in, opaque, revocable tokens. The exception is recorded in
[`SECURITY.md`](../../SECURITY.md); its *condition* is made mechanical by
`test/push-token-deletion.test.ts`.

The service worker `public/push-sw.js` is a static file served straight from
`public/` with **no bundler involvement**, so it is auditable as one small file.
It holds no keys, performs **no fetches** (no `fetch` handler), caches nothing,
and renders from the closed `{ kind, url }` payload using a built-in per-kind
copy map. That payload is derived from the kind alone, so no amount, address, or
id can leak. The stored subscription triple is opaque and **never logged**.

Push is never load-bearing: a failed send logs (endpoint scrubbed) and drops —
at-most-once, no retry queue. A `404`/`410` prunes the row.

**"No token outlives its session"** is enforced by four paths, not one:

- opt-out and logout delete directly;
- the session expiry sweep deletes;
- dead-endpoint pruning removes unreachable rows;
- the notifier tick's **invariant sweep** (`PushStore.sweepOrphans`, one
  anti-join `DELETE` mirroring the session liveness rule) catches expired
  sessions whose browser never returns, and any crash remnant. It runs whether
  or not VAPID is configured.

The deletion chain in `destroySession` is a two-step delete, not one
transaction — the session and push stores use separate Prisma clients. Push rows
are deleted **first**, so a failure strands a session remnant, never a token.

Subscription upserts run **Serializable** with a bounded P2034 retry, so
concurrent POSTs cannot defeat replace-by-session or the per-address cap.

## Resource routes live outside `:lang?`

CSV exports and the alerts/push resource routes are registered outside the
locale segment (the `tx/*` precedent), because they are not localized surfaces
and a locale prefix would make their URLs ambiguous. Exports are a plain
`<a href>` to a session-gated route that proxies the API's stream back with only
its `content-type` / `content-disposition` / `x-*` freshness headers — the
browser never sees the assertion or talks to the API.

## Design tokens

Web-local for v1 (§14.8). Every token change re-runs the shared validation
method on both themes in CI. The program accent is the NUVA mint-green primary
CTA / focus ring; the semantic UI status set
(`--status-good` / `-warning` / `-serious` / `-critical`) is a **fixed family,
never themed**, always paired with an icon and label — colour alone is not a
status signal.

The §11 type stack (Funnel Sans / Space Grotesk / Geist Mono) is not yet
self-hosted; its webfonts are a separate change, since no binaries are
committed.

## Live e2e re-run trap

The compose `web` service builds at container **start**, so a long-running stack
serves a stale bundle. A live run against it can pass for the wrong reason:
guard assertions once "passed" against a build where `MsgExecuteContract` was
not in the allowlist at all — a first-level rejection indistinguishable from the
deep guard's.

Restart the service before trusting a green live run:

```bash
docker compose --profile app --profile db restart web
```

`E2E_LIVE_OPERATOR_KEY` is the **validator's own** operator key. The funded
throwaway signer cannot cover the enroll/unregister leg: `is_operator` compares
bech32 payloads (chain-facts §contract 2), so enrolment is authorization-gated,
not funding-gated. Absent, that leg skips loudly and the permissionless payment
legs still run — which is the honest test of preflight applying no operator
check to payments.
