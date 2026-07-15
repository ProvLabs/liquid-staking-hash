# CLAUDE.md — api

Query API over the indexer's data store.

## Conventions

- Read-only over indexed data; transaction submission happens client-side via
  wallets, not through this API.
- **Reads the `indexed` schema via the SELECT-only `api_reader` role**
  (ADR-001 Decision 1,
  [`docs/architecture/2026-07-14-adr-001-app-component-architecture.md`](../../docs/architecture/2026-07-14-adr-001-app-component-architecture.md)):
  this service runs no migrations and performs no database writes of any
  kind. It consumes the `@nvhash/db-indexed` client generated from the
  indexer's schema.
- **Address-scoped and admin endpoints are authorized in-process** (ADR-001
  Decision 2): a short-lived HMAC service assertion from the web tier's
  session layer must carry an `address:<bech32>` scope matching the requested
  address exactly (mismatch → 403; absent/expired/invalid → 401). Never rely
  on network topology or "the web app is the only caller" — the
  cross-address-rejection contract tests gate this service's CI from PR 3.3.
- Every response carries the freshness envelope from `@nvhash/api-types`
  (spec §9.4); public endpoints stay unauthenticated, read-only, rate-limited.
- Version the public API surface; `apps/web/` is the primary consumer.
- Keep response shapes documented in `docs/specs/` once stable.
- Security ([`SECURITY.md`](../../SECURITY.md)): validate and bound all query
  parameters (zod at every route boundary); rate-limit; serve nothing not
  derivable from public chain data; no user-identifiable information
  collected or stored; secrets via environment only.

## Commands

Part of the root pnpm workspace (ADR-001 Decision 4); all JS tasks run in the
containerized toolchain (ADR-002): `./dev pnpm --filter @nvhash/api <script>`.
Dev database via `./dev pg up` (host port 5433).

Package scripts (`./dev pnpm --filter @nvhash/api run <script>`):

- `typecheck` — `tsc --noEmit`. No database needed (the scaffold performs no
  DB reads; the `api_reader` client lands with the M3 data endpoints).
- `test` — Vitest. Unit tests + the envelope contract harness below; no DB, no
  listening dependency (the harness starts the server on an ephemeral port).

The scaffold has **no runnable `start`** yet, by the same convention as the
indexer scaffold: live invocation under `./dev` is wired with the PR 1.5
full-stack compose. CI here needs neither a socket nor a database.

Config (`src/config.ts`) is validated and bounded at the boundary; copy
`.env.example` to `.env` for local values. The scaffold reads only serving
knobs (`PORT`, `RATE_LIMIT_*`, `TRUST_PROXY`); `DATABASE_URL` (the `api_reader`
role) and `API_SERVICE_ASSERTION_KEY` are documented there as placeholders but
consumed only by later PRs (3.1 / 3.3).

### CI gates (standing from PR 1.2)

`pnpm -r run typecheck` and `pnpm -r run test` in the `app-ci` workflow pick
these up automatically. `test` includes the API-contract and
security-executable gates (SECURITY.md, plan §4), which fail CI on violation:

- **Envelope contract** (`test/envelope-contract.test.ts`): registry-driven —
  it iterates the actual route table, so every route (now and future) is held
  to the freshness-envelope shape on enveloped routes, the read-only method
  gate, and its zod query bounds. A new route is covered automatically; it
  cannot slip past the harness.
- **Read-only guarantee** (same suite): the route registry holds only GET
  routes and every write verb (`POST`/`PUT`/`PATCH`/`DELETE`) on every route
  returns 405. This is how "no write endpoint of any kind" (plan §1) is
  enforced structurally, not by review.
- **Query-param bounding** (`test/query.test.ts` + the contract harness): every
  query param is parsed through a bounded zod schema; out-of-range input is
  rejected (400), never clamped silently.
- **Rate limiting** (`test/rate-limit.test.ts` + the contract harness): the
  fixed-window limiter refuses over the ceiling (429 + `Retry-After`); the
  client key is not spoofable via `X-Forwarded-For` unless proxy trust is on
  (`test/client-key.test.ts`).

The **cross-address-rejection** gate for address-scoped endpoints (ADR-001
Decision 2) is a standing `services/api` gate **from PR 3.3**, when those
endpoints and the service-assertion verification land — not part of this
scaffold.
