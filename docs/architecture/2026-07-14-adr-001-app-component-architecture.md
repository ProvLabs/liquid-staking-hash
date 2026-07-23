# ADR-001: App component architecture

**Status:** Proposed — accepted when the PR carrying it merges after review
**Date:** 2026-07-14
**Deciders:** Ira (review/merge)
**Delivers:** implementation plan PR 0.1 ([`../plans/2026-07-13-app-implementation-plan.md`](../plans/2026-07-13-app-implementation-plan.md) §1, §2 M0)
**Amends in the same change:** [`app-spec.md`](../specs/app-spec.md) §6, §9.1 (pointer), §9.4, §14.8; `services/indexer/CLAUDE.md`, `services/api/CLAUDE.md`, `apps/web/CLAUDE.md`

## Context

`app-spec.md` §6 was written against the `nuva-app` single-deployable shape:
SSR app, JSON API routes, and indexer workers in one codebase. This repository
intentionally splits those concerns into three components — `services/indexer`,
`services/api`, `apps/web` — and the implementation plan §1 makes the split the
governing decision. The plan defers four bindings to this ADR:

1. **Database topology** — one PostgreSQL instance, two ownership domains; two
   schemas in one database, or two databases?
2. **Personal-read authorization path** — mechanism (a) (web tier serves the
   address-scoped endpoints; the API never exposes them) or mechanism (b) (the
   API serves them behind a verified-address service credential)?
3. **Notifier home** — where alert evaluation runs and what it may read.
4. **Design-system packaging** (spec §14.8) — shared token package or app-local
   tokens validated by the shared method; and, by extension, the workspace
   layout the shared TypeScript packages of PRs 0.2/0.3/1.2 need.

`SECURITY.md` binds every option: a security control must be an **enforced
mechanism with a CI-gating test**, never a topology or caller assumption.

## Decision 1 — Database topology: one database, two schemas, role-enforced ownership

One PostgreSQL instance, one database, two schemas:

| Schema | Owner (migrations + writes) | Contents |
| --- | --- | --- |
| `indexed` | `services/indexer` | `transactions`, `redemption_requests`, `epoch_snapshots`, `validator_registry`, `validator_epochs`, `incidents`, `market_samples`, `bridge_supply_samples`, `gov_proposals`, `gov_votes`, `indexer_checkpoints`, reconciler run records (spec §9.5.6) |
| `app` | `apps/web` | `users`, `sessions`, `alert_rules`, `notifications`, Web Push subscriptions, aggregate funnel counters, `incident_acks` |

Ownership is enforced by database roles, not convention:

- **`indexer_writer`** — owner of `indexed`; the only role with DDL/DML there.
  Prisma migrations for `indexed` live in `services/indexer` and run as this role.
- **`api_reader`** — `USAGE` + `SELECT` on `indexed` only; no write grants
  anywhere. `services/api` never runs migrations.
- **`app_writer`** — owner of `app`; **no grants of any kind on `indexed`**.
  Prisma migrations for `app` live in `apps/web` and run as this role.

Two independent Prisma schemas/clients — no shared models across the domain
boundary. The generated read-only client for `indexed` is published as a
workspace package (working name `@nvhash/db-indexed`, produced from the
indexer's schema files) so `services/api` consumes exactly the schema the
indexer migrates.

Two consequences worth stating:

- **`indexed` is rebuildable, `app` is not.** Dropping `indexed` and replaying
  from height 0 must converge (the PR 2.1 replay proof); `app` is the only
  backup-critical domain.
- **Incident acknowledgment crosses domains and is therefore split.** Incidents
  are computed facts (indexer-owned, spec §9.6); the optional admin
  acknowledgment is an app action, so it lives in an `app`-schema `incident_acks`
  table referencing the incident id — the web tier never writes `incidents`.

**Gating test:** a grant-boundary integration test lands with the PR 1.5
full-stack wiring (dockerized Postgres) and gates `services/*` CI thereafter:
`api_reader` INSERT/UPDATE on any `indexed` table fails; `app_writer` SELECT on
any `indexed` table fails; `indexer_writer` has no grants on `app`.

### Options considered

| Dimension | A: two schemas, one DB (chosen) | B: two databases | C: one schema, convention only |
| --- | --- | --- | --- |
| Ownership enforcement | Grants, testable | Grants + physical separation, testable | None (rejected outright) |
| Operational cost | One instance, one URL per role | Two of everything in every env, incl. one-command devnet (PR 1.5) | Lowest |
| Rebuild story | `DROP SCHEMA indexed CASCADE` + replay | Same, coarser | Entangled |
| Isolation gain of B over A | — | Marginal: same instance class of failure; grants already enforce the write boundary | — |

B's extra isolation does not remove any attack the grant boundary leaves open
(both databases would still share an instance and its superuser), while it
doubles migration, backup, and wiring surface in every environment. A single
schema (C) makes ownership a convention, which `SECURITY.md` disallows for a
control we rely on.

## Decision 2 — Personal reads: mechanism (b), scoped service credentials verified in-process

`services/api` serves the address-scoped endpoints (`/portfolio`,
`/transactions`) and requires a **verified-address service credential** minted
by the web tier. Mechanism (a) is rejected because it is internally
inconsistent with the ownership table: if the API never exposes personal
endpoints, the web tier must read `indexed` tables itself, which Decision 1
forbids — and the plan already places the cross-address CI gate in
`services/api` (PR 3.3).

Mechanism:

- The web session layer authenticates the user (nonce-signature session, spec
  §12.3) and, per request to the API, mints a **short-lived signed assertion**
  (HMAC over `{ scope, iat, exp }`, `exp − iat ≤ 60 s`) with key
  `API_SERVICE_ASSERTION_KEY` from environment — per-environment secret, never
  in any client bundle.
- Scopes map to routes and are enforced **inside the API process**, regardless
  of network layout:
  - `address:<bech32>` — personal endpoints only; the API rejects any request
    whose target address differs from the scope (403), and any
    missing/expired/invalid assertion (401).
  - `internal:notifier` — the notifier's read-only evaluation endpoints
    (Decision 3); never grants access to personal endpoints and is never
    exposed to browsers.
- Public program endpoints (`/metrics`, `/epochs`, `/validators`, `/market`,
  `/incidents`) remain unauthenticated, read-only, rate-limited.

**Gating test:** the cross-address-rejection contract tests gate `services/api`
CI from PR 3.3 on (plan §4): assertion for address A requesting address B →
403; absent/expired/bad-signature → 401; `internal:notifier` scope on a
personal endpoint → 403; public endpoints accept no-credential requests.

> **Amendment 2026-07-22 (PR 3.3, delivered):** the assertion **wire format**
> is recorded so the web session layer (PR 5.1) and the API implement one
> contract:
>
> ```
> Authorization: Bearer <base64url(payload JSON)>.<base64url(hmac)>
> payload = { "scope": "address:<bech32>" | "internal:notifier",
>             "iat": <unix seconds>, "exp": <unix seconds> }
> hmac    = HMAC-SHA256(API_SERVICE_ASSERTION_KEY, base64url(payload JSON))
> ```
>
> Verification (`services/api/src/auth.ts`) is in-process: constant-time
> signature compare, `exp` unexpired, `exp − iat ≤ 60 s` as decided above,
> plus a 10 s forward-skew bound on `iat` (a token minted in the future is
> refused). All verification failures answer one undifferentiated 401. The
> key is bounded at config (≥32 chars); with no key configured the API
> **fails closed** (every non-public route → 401). Routes declare their
> requirement (`public` | `address` | `internal:notifier`) in the route
> registry, and the handler pipeline enforces credential validity BEFORE
> query validation and the scope↔target match after it (401 → 400 → 403) —
> the gating-test matrix above now runs as
> `services/api/test/cross-address.test.ts`, standing in CI.

> **Amendment 2026-07-23 (PR 5.1, minting side delivered):** the web session
> layer now mints this exact contract
> (`apps/web/app/lib/services/assertion.server.ts`): scope is always the
> SESSION address (the session layer is the sole caller — a cross-address
> assertion cannot be minted from user input), lifetime pinned at 60 s, key
> zod-bounded ≥ 32 chars at config and absent from the client bundle
> (`check:bundle`). The two implementations are held together by **shared
> golden vectors cross-pinned in both suites**
> (`apps/web/test/assertion.test.ts` and
> `services/api/test/assertion-vectors.test.ts` carry identical literals) —
> either side drifting fails its own CI until both move together.

## Decision 3 — Notifier: a worker process in `apps/web`, reading through the API

The notifier (alert-rule evaluation on indexer ticks) is app-state machinery:
its inputs are `alert_rules` and its outputs are `notifications` and push
deliveries — all `app`-schema. It runs as a **separate entrypoint/container in
the `apps/web` codebase**, sharing the web tier's models layer, so app-state
ownership stays in one codebase.

Its indexed-fact needs (matured/expedited redemptions, arrears, incidents per
tick) are cross-address by nature, so it does **not** use `address:` scopes.
It reads through `services/api` — public endpoints where they suffice, plus a
small read-only internal surface (e.g. `/api/internal/v1/alert-facts`)
authorized by the `internal:notifier` scope of Decision 2. This keeps the
Decision 1 invariant crisp: exactly two roles can read `indexed` —
`indexer_writer` and `api_reader` — and the grant-boundary test stays honest
(the web/notifier credential has no `indexed` grants to carve exceptions for).

Rejected: notifier in `services/indexer` (drags `app`-schema writes into the
indexer's domain, breaking Decision 1); notifier with its own read-only DB role
on `indexed` (silently falsifies "the web app never touches indexed tables" at
the grant level and weakens the grant-boundary test).

## Decision 4 — Packaging: pnpm workspace; shared code as packages; design tokens web-local, validated by the shared method (resolves spec §14.8)

- **Workspace:** a single pnpm workspace at the repository root covering
  `apps/web`, `services/*`, and a new top-level `packages/`. `apps/console`
  stays a standalone npm project until its own migration opts it in — joining
  is a console-area decision, not forced here. Workspace files land with the
  first PR that needs them (0.2/0.3), not with this docs-only PR.
- **Shared packages** created by M0/M1 (working names, `@nvhash/*` scope):
  - `@nvhash/fixtures` — the PR 0.2 devnet-captured corpus, consumed by indexer
    decode tests and the web MSW harness.
  - `@nvhash/chain-client` — the PR 0.3 typed LCD client (contract + vault +
    staking + group queries, `BigInt` amount discipline).
  - `@nvhash/api-types` — the freshness envelope
    (`{ data, meta: { chain_height, indexed_height, generated_at, source } }`)
    and endpoint response types, shared by `services/api` and `apps/web` (PR 1.2).
  - `@nvhash/db-indexed` — the read-only Prisma client over the `indexed`
    schema (Decision 1).
- **Design tokens are web-local** (`apps/web`), not a shared package for v1.
  The two surfaces deliberately wear different registers — the console stripped
  the brand register; the web app wears the NUVA family (spec §11) — and the
  console is mid-migration and standalone. What must stay coherent across the
  family is the **validation method**, not the token values: both surfaces run
  the same dataviz palette validation (`validate_palette.js`, the console's
  existing practice) in CI on every token change, both themes. Revisit shared
  packaging post-v1 if drift is observed.

**Gating test:** the palette validator runs in `apps/web` CI from PR 1.3/1.4 on
both theme token sets (plan §4, visual/design layer).

## Consequences

Easier:

- Blast-radius statements are exact: a compromised API credential can read
  public-derivable data but write nothing; a compromised web tier can corrupt
  app state but not history; only the indexer can write history, and history
  is rebuildable from chain.
- The three lanes of the plan (§3) each own their migrations and CI gates
  without coordination; the web lane builds fully offline against
  `@nvhash/fixtures` + MSW.
- The freshness envelope is one shared type — the API cannot drift from what
  the web app renders.

Harder / accepted costs:

- Two Prisma schemas and clients; cross-domain questions (e.g. admin views
  joining incidents to acknowledgments) are composed in application code or
  API endpoints, never SQL joins across the boundary.
- The assertion key is a per-environment secret to provision and rotate
  (`.env.example` placeholder only, per `SECURITY.md`).
- The notifier takes an HTTP hop for evaluation reads; at ~1-minute tick
  cadence this is negligible, and it buys the crisp two-reader invariant.

To revisit:

- Console joining the pnpm workspace (console migration).
- Shared token package if post-v1 drift makes web-local tokens costly.
- The internal API surface's shape once PR 6.2 defines the notifier's real
  query needs.

## Action items

1. [x] This PR: ADR + amend `app-spec.md` §6/§9.4 (+ §9.1 pointer, §14.8
   record) + update the three area `CLAUDE.md`s.
2. [ ] PR 0.2/0.3: create the root pnpm workspace and `packages/` with
   `@nvhash/fixtures` and `@nvhash/chain-client`.
3. [ ] PR 1.1/1.2/1.3: scaffolds implement the role split (`indexer_writer`,
   `api_reader`, `app_writer`) and `@nvhash/api-types`/`@nvhash/db-indexed`.
4. [x] PR 1.5: grant-boundary integration test
   (`services/indexer/test/integration/grant-boundary.test.ts`), standing in
   `services/*` CI via the app-ci `db-grants` job; role/schema split in
   `infra/dev/postgres/roles.sql`.
5. [ ] PR 3.3: cross-address-rejection contract tests; standing in
   `services/api` CI.
6. [ ] PR 6.2: notifier internal read surface under `internal:notifier` scope.
