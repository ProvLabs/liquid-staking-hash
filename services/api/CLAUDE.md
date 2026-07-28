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
  indexer's canonical schema (PR 3.1). All reads go through the injectable
  `IndexedReader` port (`src/reader.ts`): the Prisma implementation
  (`src/reader-prisma.ts`, dynamically imported by `main()` only when
  `DATABASE_URL` is set) or the honest empty reader (dataless: null heights,
  empty collections). Row mapping is the pure `src/derive.ts` layer — amounts
  bigint → decimal string, heights through a loud safe-integer guard, NAV via
  the shared `navHashPerShare` in `@nvhash/api-types`. Envelope heights come
  from the latest `reconciler_runs` row (fallback: max non-`meta:` worker
  checkpoint with a null chain head).
- `/redemptions/stats` (PR 5.4, app-spec §9.5.3/§14.12) is the **public,
  aggregate** typical time-to-payout — median/p90 of `(expedited_at ??
  matured_at) − enqueued_at` over the recent terminal-request window
  (`derivePayoutStats`; no owner keying, so no PII, unlike `/portfolio`).
  Since `redemption_requests` has no epoch-index column, the "recent-epoch
  cohort" is a rolling window (`PAYOUT_STATS_WINDOW_DAYS`). The ≥ 10-terminal
  and ≥ 1-completed-epoch gates null the stats server-side (the web tier then
  shows the 60-day guarantee alone); the 21–60-day band bounds ride in the
  payload as data. Honest-empty (`sample_count: 0`, null stats, `cold_start:
  true`) until data + an epoch exist — the `/market` precedent.
- `/market` (PR 3.2) is shape-complete but honest-empty until the market
  sampler (plan PR 2.4, parked on spec §14.3) produces data: venue +
  `sampled_at` ride in the payload, the premium is computed against the NAV
  current at the sample's time (§9.5(4)), the supply split is bridged-side
  only (local = the web tier's live read), and stored `depthBands` JSON is
  boundary-validated on read (loud failure on shape drift).
- **Address-scoped endpoints are authorized in-process** (ADR-001 Decision 2,
  wire format in its 2026-07-22 amendment): a short-lived HMAC service
  assertion from the web tier's session layer must carry an
  `address:<bech32>` scope matching the requested address exactly (mismatch
  → 403; absent/expired/invalid → 401; fail-closed 401 when
  `API_SERVICE_ASSERTION_KEY` is unset). Verification lives in `src/auth.ts`
  (constant-time compare, `exp − iat ≤ 60 s`, 10 s `iat` skew bound); each
  route declares `auth: "public" | "address" | "internal:notifier"` in the
  registry and the handler pipeline enforces it in the pinned order
  429→404→405→401→400→403. Never rely on network topology or "the web app
  is the only caller" — the **cross-address-rejection contract suite
  (`test/cross-address.test.ts`) is a standing CI gate** since PR 3.3.
  `/transactions?format=csv` serves the §14.11 export (pinned columns,
  formula-injection guard) with freshness in X-Chain-Height /
  X-Indexed-Height / X-Generated-At headers (recorded §9.4 deviation); since
  PR 6.1 the CSV serves the COMPLETE indexed history ascending by
  `(height, msg_index)` (via `IndexedReader.transactionsAscFor`, chunked
  1000/query): `limit`/`offset` bound only the JSON view, never the export.
- **`/portfolio/metrics` (PR 6.1, M6.1)** is the third `auth: "address"`
  route (joined to the cross-address `PERSONAL_PATHS` gate): it runs the pure
  `derivePortfolioMetrics` fold (`src/portfolio-metrics.ts`) over the address's
  full history (`transactionsAscFor`) plus the epoch step series
  (`IndexedReader.listEpochsAsc`: `epoch_snapshots` ascending as
  `EpochStepFact`), serving the frozen `PortfolioMetrics` shape. Derivation
  stays in the pure fold; the reader adds only the two SELECTs.
- **Internal alert-facts surface (PR 6.2, M6.2)** — the notifier's
  cross-address evaluation reads under the `auth: "internal:notifier"` scope
  (ADR-001 Decision 3; the scope was scaffolded-but-dead until now). Three
  `GET` enveloped routes under `/api/v1/internal/alert-facts/`:
  `redemptions` (`since_height`+`after_id`+`limit` — a compound keyset cursor
  `(lastHeight, requestId) > (since_height, after_id)` in
  `(lastHeight, requestId)` asc order, so a same-height burst larger than one
  page pages through completely),
  `incidents` (`since_id`+`limit`, `id > since_id` asc, **no payload
  passthrough** — identity only), `arrears` (no query, latest sampled epoch,
  active-registry join). Limits are bounded 1–500 (`MAX_ALERT_FACT_LIMIT`); the
  cursor is efficiency, the notifier's unique constraint is correctness. Reader
  methods `redemptionsChangedSince`/`incidentsSince`/`latestArrears`; row shapes
  `AlertRedemptionFact`/`AlertIncidentFact`/`AlertArrearsFact` frozen in
  `@nvhash/api-types` — identity/ordinal fields only, **never amounts** on the
  redemption/incident facts (the stored notification carries none). The
  registry-derived **`INTERNAL_PATHS` matrix** in `test/cross-address.test.ts`
  (no-cred → 401, `address:` scope → 403, `internal:notifier` → 200) joins the
  standing gate list — a new internal route is covered automatically. The
  `internal:notifier` assertion golden vector is cross-pinned in
  `test/assertion-vectors.test.ts` ↔ `apps/web/test/assertion.test.ts`.
- **Operator surface (PR 6.4, M6.4)** — three `auth: "address"` routes under
  `/api/v1/operator/` (`summary`, `epochs`, `payments`) behind `/validators/mine`
  (app-spec §8.6/§9.4). They carry a SECOND boundary beyond the scope check:
  the address→valoper mapping, resolved server-side from
  `validator_registry.operator` via `IndexedReader.operatorValopers` — the
  single source — with every other operator read called only on a valoper that
  came from it (the pure `resolveOwnedValoper` in `derive.ts`). **An unowned
  valoper is answered honest-empty, never 403**: a 403 would confirm it exists
  and belongs to someone else. `test/operator-endpoints.test.ts` is that gate
  and asserts an unowned valoper and a nonexistent one are indistinguishable.
  `?valoper=` is bounded by `bech32ValoperSchema` (the `valoper` HRP required).
  `payer` rides the JSON row (permissionless payment — the operator's audit
  case) but NOT the CSV, whose six columns §14.11 pins — with the **[R4]
  deviation** that the amount column is `nhash_amount`, not §14.11's proposed
  `hash_amount`: the served value is nhash BASE UNITS, so a whole-HASH column
  name would read 10⁹× high and contradict `/validators/mine`, which formats
  the same fact to whole HASH. Base-unit content under a base-unit column name
  is the convention for both exports (the holder CSV serves `nhash`/`shares`
  for the same reason). A CSV column that renames a unit renames it in the
  spec's §14.11 delivery note in the same change; `payment.epoch_index`
  is derived at read time (`paymentEpochIndex` over `epochBoundariesAsc`, null
  while the crediting epoch is open) because the indexer cannot know it at
  ingest. The `format=csv` export is the COMPLETE history ascending (the 6.1
  precedent). New reader methods sum in SQL (`operatorPaymentTotalsFor`) and
  STREAM by keyset (`operatorPaymentsAscStream`); the full `validator_epochs`
  row is a new `OperatorEpochFacts` type, deliberately NOT a widening of the
  public projection's `ValidatorEpochFacts`.
  **`operator_payments` is the one indexed table fed by a PERMISSIONLESS write
  path** — anyone may `PayTip` for any validator — so its row count is bounded
  by nobody, and anything reading it must be sized for that, not for the
  validator cap. Two consequences, both measured on the dev DB at 300 000
  payments on one valoper (2026-07-28 review, superseding the 2026-07-27
  plan-check):
  - **Both §14.11 CSV exports stream and walk by SQL row comparison.** Three
    forms were measured at 300 000 rows; only the third is flat:
    `OFFSET` chunking = 14.8 s total and +323 MB RSS (each chunk re-scans every
    prior row); Prisma's two-arm `OR` cursor = 6.2 s, because Postgres cannot
    push it into an index condition and demotes it to a post-scan `Filter`
    (`Rows Removed by Filter: 250 118` — still quadratic, and it *looks* fast
    if you only sample the last chunk); the SQL row comparison
    `("height","msgIndex") > (?,?)` against the composite index = **1.6 s**,
    `Index Cond: … ROW(height, "msgIndex") > ROW(…)`, 46 buffers / 0.37 ms per
    chunk at ANY depth, heap flat at 24 MB, first byte immediate. Prisma's
    query builder cannot express row comparison, which is why
    `operatorPaymentsAscStream` / `transactionsAscStream` are `$queryRaw`.
    Gated by the chunk-boundary/same-height-burst case in
    `test/integration/reader.test.ts` — completeness is the property, so a
    cursor that skips a row is a wrong statement of fact.
  - `latestOperatorEpochs` and the public `listValidators` use **`DISTINCT ON`**,
    not Prisma's `distinct`, which is NOT pushed down (the emitted SQL carried
    no `DISTINCT ON` and no `LIMIT` — verified from the Postgres statement log)
    and fetched `validators × epochs_ever` rows to return one per valoper.
  - Query plans: index-backed **except** `validator_registry` (bounded by the
    validator cap) and `epoch_snapshots` (one row per calendar month) — both
    structurally tiny, so no index was added — **and `operatorPaymentTotalsFor`,
    which the planner flips to a full parallel seq scan (8 663 buffers, 58 ms)
    once one valoper holds a large share of `operator_payments`.** It is
    index-backed at even distribution (3 buffers) and runs on every
    `/validators/mine` load. A covering `(valoper, paymentType, amount)` index
    was built and measured: **no effect** — with one valoper holding most of the
    table the seq scan is genuinely the cheaper plan, so an index cannot fix
    this. Bounding it needs precomputed totals (a schema change, i.e. a
    design-review event); until then it is a known, accepted cost.
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

- `typecheck` — `tsc --noEmit`. Needs the `@nvhash/db-indexed` client
  generated first; `pnpm -r run typecheck` handles this via topological order
  (the package's own typecheck generates), or run
  `./dev pnpm --filter @nvhash/db-indexed run generate` once. No database.
- `test` — Vitest (default config, excludes `test/integration/**`). Unit
  tests + the envelope contract harness below over the in-memory reader; no
  DB, no listening dependency (the harness starts the server on an ephemeral
  port).
- `test:db` — the DB-backed reader gate (`vitest.integration.config.ts`):
  real `@nvhash/db-indexed` queries as `api_reader` against rows seeded as
  `indexer_writer`. Needs a migrated Postgres with `roles.sql` applied and
  `API_READER_DATABASE_URL` / `INDEXER_WRITER_DATABASE_URL` set; runs in the
  app-ci `db-grants` job.

- `start` — run the read-only server (`node src/index.ts`) on `PORT`. Live
  invocation is wired by the PR 1.5 full-stack compose (`infra/devnet/stack.sh
  up`, the `app` profile); liveness is `GET /api/v1/health`. CI here still needs
  neither a socket nor a database — the unit + contract suites cover the server
  as a pure function.

Config (`src/config.ts`) is validated and bounded at the boundary; copy
`.env.example` to `.env` for local values. Serving knobs (`PORT`,
`RATE_LIMIT_*`, `TRUST_PROXY`) plus, since PR 3.1, an OPTIONAL `DATABASE_URL`
(the `api_reader` role, postgres scheme enforced): absent, the process runs
dataless on the honest empty reader and `/status` reports
`data_source: "unwired"`. `API_SERVICE_ASSERTION_KEY` remains a documented
placeholder consumed by PR 3.3.

### CI gates (standing from PR 1.2)

`pnpm -r run typecheck` and `pnpm -r run test` in the `app-ci` workflow pick
these up automatically. `test` includes the API-contract and
security-executable gates (SECURITY.md, plan §4), which fail CI on violation:

- **Envelope contract** (`test/envelope-contract.test.ts`): registry-driven —
  it iterates the actual route table, so every route (now and future) is held
  to the freshness-envelope shape on enveloped routes, the read-only method
  gate, and its zod query bounds. A new route is covered automatically; it
  cannot slip past the harness. Since PR 3.1 the suite holds BOTH states of
  the frozen shapes: honest-empty (default reader: all-null `/metrics`, empty
  collections, null heights, `/status` unwired) and populated (injected
  in-memory fake built through the real `derive.ts` mappers: real heights
  from the reconciler run, the corpus NAV golden on `/epochs`, joined
  `/validators` rows + set health). `test/derive.test.ts` unit-gates the
  pure mappers; `test:db` proves the same derivations over real Postgres as
  `api_reader`.
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
- **Derived-metrics R3** (M6.1, spec §2.8.2): two standing suites gate the
  `derivePortfolioMetrics` fold. `test/portfolio-metrics-property.test.ts`
  (fast-check) generates event/epoch histories; `test/portfolio-metrics-traces.test.ts`
  replays the committed sim traces (`@nvhash/fixtures/sim-traces`, 5 seeds +
  manifest) as a single pooled address, asserting conservation within the
  per-floor-site dust bound (full history + seeded prefixes), non-negative
  bases, `history_state: "complete"`, refund gain-invariance, and escrow
  reconciliation against the manifest stats. DevDeps for these: `fast-check`
  and `@nvhash/fixtures` (`workspace:*`): first-party corpus, no new runtime
  dependency (SECURITY.md supply chain).

The **cross-address-rejection** gate for address-scoped endpoints (ADR-001
Decision 2) is a standing `services/api` gate **from PR 3.3**, when those
endpoints and the service-assertion verification land — not part of this
scaffold. Since PR 6.4 its `PERSONAL_PATHS` list is **registry-derived** like
`INTERNAL_PATHS`, so a new `auth: "address"` route joins the matrix
automatically; a route needing extra required params declares them in the
suite's `VALOPER_PATHS`/`personalQuery` helper, and the suite asserts that
coverage so a new required param cannot 400 its way past a 403 assertion.

- **Operator ownership** (standing from PR 6.4,
  `test/operator-endpoints.test.ts`): the address→valoper mapping is enforced
  server-side and leak-free — an unowned valoper and a well-formed nonexistent
  one produce byte-identical answers — and the §14.11 operator CSV's column
  set, completeness past pagination, and injection guard are pinned.
