# CLAUDE.md — api

Read-only query API over the indexer's data store. Rationale, measured results,
and recorded decisions: [`docs/architecture/api-design-notes.md`](../../docs/architecture/api-design-notes.md).
Read it before changing a read path, a cursor, or an auth rule.

## Conventions

- **Read-only, always.** No write endpoint of any kind; no database writes of
  any kind; no migrations. Transaction submission happens client-side via
  wallets. Enforced structurally by the route registry, not by review.
- **Reads the `indexed` schema via the SELECT-only `api_reader` role**
  (ADR-001 Decision 1,
  [ADR](../../docs/architecture/2026-07-14-adr-001-app-component-architecture.md)),
  through the `@nvhash/db-indexed` client generated from the indexer's canonical
  schema.
- **DB-only by design** — this service has no chain client. It serves the
  durable mirror; anything that must be true *now* is a web-tier live read.
  Every figure is as of `observed_height`, never "now".
- **Honest-empty over absent.** Endpoints stay shape-complete and serve nulls
  and empty collections rather than 404 or omission. Null is never `0`.
  Statistical/confidence gates are applied server-side and their bounds ride in
  the payload as data, so the web tier never re-decides them.
- **Every query param is zod-bounded at the route boundary**; out-of-range input
  is rejected 400, never silently clamped.
- Every response carries the freshness envelope from `@nvhash/api-types`
  (spec §9.4). Public endpoints stay unauthenticated, read-only, rate-limited.
- Wire bounds are declared once in `@nvhash/api-types/bounds.ts` and imported by
  both tiers — never coupled across tiers in a comment.
- Shared derivations (`navHashPerShare`, `meetsThreshold`) live in
  `@nvhash/api-types`. Do not reimplement one locally.
- Version the public API surface; `apps/web/` is the primary consumer. Keep
  response shapes documented in `docs/specs/` once stable.
- Security ([`SECURITY.md`](../../SECURITY.md)): validate and bound all query
  parameters; rate-limit; serve nothing not derivable from public chain data;
  no user-identifiable information; secrets via environment only.

## Layout

- `src/routes.ts` — the route registry. Each route declares
  `auth: "public" | "address" | "internal:notifier" | "admin"`; the handler
  pipeline enforces it in the pinned order **429→404→405→401→400→403**.
  `admin` and `internal:notifier` match on scope KIND alone — they are
  program-wide and have no `?address=` target to compare against.
- `src/auth.ts` — in-process service-assertion verification (ADR-001
  Decision 2): constant-time compare, `exp − iat ≤ 60 s`, 10 s `iat` skew.
  Every failure is a bare 401 with no distinguishing detail.
- `src/reader.ts` — the injectable `IndexedReader` port.
  `src/reader-prisma.ts` is the Prisma implementation (dynamically imported by
  `main()` only when `DATABASE_URL` is set); absent, the honest empty reader
  serves nulls and `/status` reports `data_source: "unwired"`.
- `src/derive.ts` — pure row mapping. Amounts bigint → decimal string, heights
  through a loud safe-integer guard.
- `src/portfolio-metrics.ts` — the pure `derivePortfolioMetrics` fold.
- `src/config.ts` — validated and bounded at the boundary. Copy `.env.example`.

Envelope heights come from the latest `reconciler_runs` row; fallback is the max
non-`meta:` worker checkpoint with a null chain head.

### Route surfaces

| Prefix | Auth | Notes |
|---|---|---|
| `/api/v1/` public reads | public | `/metrics`, `/epochs`, `/validators`, `/market`, `/redemptions/stats` |
| `/api/v1/governance/` | public | Public is **structural** — proposals and votes have no address keying, so no `PERSONAL_PATHS` entry exists |
| `/api/v1/portfolio*`, `/transactions` | `address` | Scope must match the requested address exactly |
| `/api/v1/operator/` | `address` | Second boundary: address→valoper resolved server-side from `validator_registry.operator` |
| `/api/v1/internal/alert-facts/` | `internal:notifier` | Identity/ordinal fields only, **never amounts** |
| `/api/v1/admin/` | `admin` | §8.8 program-wide aggregates. **No fact shape carries an address** — where one is needed to compute a figure it is a GROUP BY key inside SQL and is never selected out |

**Every §8.8 read is capped, including the two that look like folds.**
`holderLifecycles` and `redemptionLatencySeconds` grow with depositor count and
redemption history — permissionlessly — so both take an explicit limit and both
flag a capped read (`holders_truncated`, `AdminUpkeepDistribution.truncated`).
Lifecycles read ASC so a trim drops the newest cohorts (the `adminEpochsAsc`
convention); latencies read newest-first, because that panel measures upkeep
*now*, and select only **paid-out** statuses — `payoutDurationSeconds` reads
`expeditedAt ?? maturedAt`, so a refunded request yields nothing and selecting
one would spend the cap on a row that is then discarded (the `payoutStats`
line, for the same reason). `redemptionLatencySeconds` returns `truncated`
**with** the sample rather than letting the caller infer it from
`seconds.length`: rows are dropped after the read, so that length is not
authoritative for "did the cap bind" and a caller comparing it under-reports. **The cap bounds the transfer and this process's memory, not the scan:**
measured on the dev DB, the lifecycle window function ran 349 ms at 400 k
transactions / 40 k holders and 1 407 ms at 1.2 M / 120 k — superlinear, on every
`/admin` load, uncached. The remedy for the scan is materializing holder
lifecycle in the indexer; it is a follow-on, not something these caps did.

**A transfer cap is not a denominator.** `holderPositions(bandDepth)` returns the
top-`CONCENTRATION_BAND_DEPTH` positions **plus** the holder count and total
position, aggregated over the whole set in the **same statement**. Deriving
either aggregate from the returned rows caps the count and shrinks the
denominator, so every concentration band becomes a share of the banded slice —
overstated, plausible-looking, and wrong only once the program outgrows the band
depth. The reader fake mirrors the split for the same reason. Do not reuse a cap
declared for one quantity (`MAX_ADMIN_EPOCH_POINTS`) to bound another.

**`/admin/program-health` serves two depositor figures and they are not
interchangeable.** `depositor_count` is all-time (the header panel);
`first_deposits_in_window` counts addresses whose FIRST `swap_in` fell inside
`FUNNEL_WINDOW_DAYS` and is the evaluator funnel's terminal stage, matching the
window of the counters `apps/web` pairs it with. "First" is min'd over all
history and then filtered — filtering first would count a returning depositor as
new.

CSV exports (`?format=csv`) serve the **complete** indexed history ascending;
`limit`/`offset` bound only the JSON view. Exports stream by SQL row comparison
(`$queryRaw` — Prisma cannot express it), never `OFFSET` chunking. See the
design notes before changing a cursor.

## Commands

Part of the root pnpm workspace (ADR-001 Decision 4); all JS tasks run in the
containerized toolchain (ADR-002): `./dev pnpm --filter @nvhash/api <script>`.
Dev database via `./dev pg up` (host port 5433).

- `typecheck` — `tsc --noEmit`. Needs `@nvhash/db-indexed` generated first;
  `pnpm -r run typecheck` handles this topologically. No database.
- `test` — Vitest, excludes `test/integration/**`. No DB and no listening
  dependency: the harness starts the server on an ephemeral port.
- `test:db` — the DB-backed reader gate (`vitest.integration.config.ts`): real
  queries as `api_reader` against rows seeded as `indexer_writer`. Needs a
  migrated Postgres with `roles.sql` applied plus `API_READER_DATABASE_URL` /
  `INDEXER_WRITER_DATABASE_URL`. Runs in the app-ci `db-grants` job.
- `start` — run the read-only server (`node src/index.ts`) on `PORT`. Liveness
  is `GET /api/v1/health`. Live invocation is wired by
  `infra/devnet/stack.sh up` (`app` profile).

## CI gates

`pnpm -r run typecheck` and `pnpm -r run test` in `app-ci` pick these up. All
fail CI on violation.

- **Envelope contract** (`test/envelope-contract.test.ts`) — registry-driven:
  iterates the actual route table, so every route now and future is held to the
  envelope shape, the read-only method gate, and its zod bounds. Holds both
  honest-empty and populated states. A new route is covered automatically.
- **Read-only guarantee** (same suite) — the registry holds only GET routes and
  every write verb returns 405 on every route.
- **Query-param bounding** (`test/query.test.ts` + the contract harness).
- **Rate limiting** (`test/rate-limit.test.ts`, `test/client-key.test.ts`) —
  429 + `Retry-After` over the ceiling; the client key is not spoofable via
  `X-Forwarded-For` unless proxy trust is on.
- **Cross-address rejection** (`test/cross-address.test.ts`) — ADR-001
  Decision 2. `PERSONAL_PATHS` and `INTERNAL_PATHS` are **registry-derived**, so
  a new scoped route joins the matrix automatically. A route with extra required
  params must declare them (`VALOPER_PATHS` / `personalQuery` /
  `PUBLIC_REQUIRED_QUERY`) and the suite asserts that coverage — otherwise a 400
  masquerades as a deliberate 403.
- **Operator ownership** (`test/operator-endpoints.test.ts`) — the
  address→valoper mapping is enforced server-side and leak-free: an unowned
  valoper and a well-formed nonexistent one produce byte-identical answers. Also
  pins the §14.11 CSV column set, completeness past pagination, and the
  formula-injection guard.
- **Derived-metrics R3** (spec §2.8.2) —
  `test/portfolio-metrics-property.test.ts` (fast-check over generated
  event/epoch histories) and `test/portfolio-metrics-traces.test.ts` (replays
  the committed sim traces): conservation within the per-floor-site dust bound,
  non-negative bases, `history_state: "complete"`, refund gain-invariance,
  escrow reconciliation against the manifest stats.
- **Governance endpoints** (`test/governance-endpoints.test.ts`) plus the
  governance cases in `test/derive.test.ts` and `test/integration/reader.test.ts`.
