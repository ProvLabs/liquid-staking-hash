# CLAUDE.md — indexer

Chain-event indexer feeding the query store used by `services/api/`.

## Conventions

- Indexing must be idempotent and resumable: reprocessing a block range must
  not corrupt or duplicate derived data.
- Treat chain data as the source of truth; derived tables are rebuildable.
- **Owns the `indexed` schema** (ADR-001 Decision 1,
  [`docs/architecture/2026-07-14-adr-001-app-component-architecture.md`](../../docs/architecture/2026-07-14-adr-001-app-component-architecture.md)):
  the Prisma schema and migrations for all indexed tables live here and run as
  the `indexer_writer` role — the only role with write access to that schema.
  This service never touches the `app` schema. Migrations must run cleanly on
  an empty database.
- The reconciler and incident derivation live in this service (spec §9.6);
  the notifier does not (it is an `apps/web` worker).
- The generated read-only Prisma client for the `indexed` schema is published
  as the `@nvhash/db-indexed` workspace package for `services/api`.
- Security ([`SECURITY.md`](../../SECURITY.md)): persist only public chain
  data plus minimal operational data — no user-identifiable information, no
  IP-to-address linkage (including logs); treat indexed events as untrusted
  input; never hold keys or sign. Schema lint (no PII columns) and the
  log-scrubbing check gate CI (plan §4).

## Runtime & workers (M2.0)

The shared runtime the M2 ingestion workers slot into lives under `src/`
(plan [`docs/plans/2026-07-20-app-m2.0-indexer-shared-infra.md`](../../docs/plans/2026-07-20-app-m2.0-indexer-shared-infra.md)).
Every worker uses these — none re-implements a cursor, a decode, or a transport:

- **`runtime/checkpoint.ts`** — `runWindow(prisma, stream, window, fn)` runs a
  worker's data upserts AND the `indexer_checkpoints` cursor advance in ONE
  `prisma.$transaction`; the cursor advances only after the window commits
  (spec §9.2). Workers never write their checkpoint directly. `trailingTarget`
  applies the confirmation depth (default 0 — Provenance instant finality).
- **`runtime/worker.ts`** — the loop shell (`runWorker`) and the
  `registerWorker` seam. A worker is **two-phase** so chain I/O never happens
  inside a DB transaction: `collect(window)` reads+decodes from chain (no DB),
  `write(tx, window, batch)` applies to the `indexed` schema (no network). The
  runner polls the head, pages the un-processed range into bounded windows, and
  commits each via `runWindow`. `src/index.ts` builds the head source
  (`RpcClient.latestHeight`) and starts the workers (PR 2.1).
- **`runtime/streams.ts`** — the `STREAMS` names and `assertChainIsolation`, the
  per-`(chain_id, contract)` boot check (spec §9.3) run from `src/index.ts`: the
  process fails closed if the DB holds a foreign history. The identity marker is
  a reserved `meta:provenance` row in `indexer_checkpoints` (no schema change);
  `meta:`-prefixed rows are markers, not worker cursors — lag accounting (PR 2.5)
  excludes them.
- **`decode/attributes.ts`** — the single place the pinned "extra JSON-string
  quoting layer" fact lives (`packages/fixtures/manifest.json`): `dequote`,
  `attr`/`optionalAttr`, `coinAttr`. Amount discipline mirrors
  `packages/chain-client/src/amounts.ts`; kept local so the indexer runtime has
  a zero cross-package dependency surface (SECURITY.md supply chain).
- **`transport/rpc.ts`** — the transports chain-client (REST-only) lacks:
  `RpcClient` (`block_results` for EndBlocker payout/refund/NAV, `tx_search`,
  `block_search`, `latestHeight`) and `PinnedLcdClient.smartAtHeight` (height-
  pinned smart query via `x-cosmos-block-height`, for single-snapshot backfill).
  First-party, fetch-based, zero runtime deps. `RPC_URL` is wired in config +
  compose from PR 2.1 (whether height-pinning promotes into
  `@nvhash/chain-client` is a PR 2.2 decision).

### Workers

- **`workers/chain-events/`** (stream `chain-events`, PR 2.1) — vault/contract
  event ingestion → `transactions`, `redemption_requests`. Dual source:
  tx-search (swap in/out request, expedite) + `block_results` per height
  (EndBlocker payout/refund + NAV marker). `decode.ts` maps raw events to typed
  `DomainEvent`s (scoped to the program's vault/receipt denom); `reduce.ts` is a
  pure fold over an abstract `Store` (Postgres via `store.ts`, in-memory in the
  replay property test) applying the redemption status lattice and the running
  marker NAV. Idempotency: `Transaction` upserts by `(txhash, msgIndex)` with a
  deterministic synthetic txhash (`blk:{height}:{requestId}:{payout|refund}`)
  for txless EndBlocker rows; `RedemptionRequest` by `requestId`. The running
  NAV persists across windows in a reserved `meta:chain-events:nav` checkpoint
  row (no schema change). Tests: `test/workers/chain-events-decode` (fixture
  corpus) and `test/workers/chain-events-replay` (fast-check: replay from 0 ==
  resume from any height; idempotent re-apply).

- **`workers/epoch-history/`** (stream `epoch-history`, PR 2.2) → `epoch_snapshots`.
  The contract keeps only the latest snapshot on chain (spec §13/§9.10), so
  history is read by **height-pinned smart query** (`PinnedLcdClient.smartAtHeight`,
  `x-cosmos-block-height`) at each `run_epoch` crank height — `boundaries.ts`
  locates cranks via tx-search, `snapshot.ts` fetches epoch_snapshot + apr AS OF
  that height, `decode.ts` maps them (local mirror of chain-client parsers, since
  raw-Node can't import that package — see `decode/scalars.ts`). Idempotent:
  upsert by `epochIndex`; genesis backfill and resume converge because past-height
  state is deterministic. Tests: `test/workers/epoch-history-decode` (fixtures +
  crank detection) and `-replay` (fast-check convergence). Height-pinned query is
  App-local for now (promotion into `@nvhash/chain-client` is a still-open call —
  moot at runtime anyway: the indexer can't import that package's `.ts`).

- **`workers/validator-sampler/`** (stream `validator-sampler`, PR 2.3) →
  `validator_registry` + `validator_epochs`. Anchored to epoch cranks like
  epoch-history: at each crank height it reads, height-pinned, the contract
  `validators()`/`jail_reports()` plus x/staking moniker + program delegation
  (generic `PinnedLcdClient.getAtHeight`), keying the epoch rows by the epoch
  that closed there. `failingReasons` is derived from the status flags;
  `uptimeBps` null (no capture yet) stores as 0 (read with `eligible`, not as an
  asserted 0%). Registry enrollment is set-once (`enrolledAt` from the contract);
  a validator absent from the set at a crank is marked `unregisteredAt` — the one
  stateful bit, forward-deterministic so replay converges. Writes facts only;
  2.5 derives jail/arrears incidents from them. Tests:
  `test/workers/validator-sampler-decode` (corpus) and `-replay` (fast-check).

## Commands

Part of the root pnpm workspace (ADR-001 Decision 4); all JS tasks run in the
containerized toolchain (ADR-002): `./dev pnpm --filter @nvhash/indexer
<script>`. Dev database via `./dev pg up` (host port 5433); the dev chain is
reachable in-network as `http://dev-node:1317`.

Package scripts (`./dev pnpm --filter @nvhash/indexer run <script>`):

- `typecheck` — `prisma generate` then `tsc --noEmit`. Generate runs first so
  the client types exist; it reads only the schema, so no database is needed
  (this is why CI can typecheck without Postgres).
- `test` — Vitest (default config). Includes the two security-executable gates
  below; no DB (the DB-backed grant-boundary test is a separate config/script,
  so `pnpm -r run test` stays Postgres-free).
- `test:grants` — the grant-boundary integration test (needs Postgres, see
  "Full-stack wiring" below).
- `generate` — regenerate the Prisma client from `prisma/`.
- `start` — `prisma generate` then run the scaffold supervisor (`src/index.ts`):
  it connects to the `indexed` schema as `indexer_writer`, proves the connection
  stays live via a periodic ping written to a heartbeat file, and idles until a
  signal — the shape M2 workers slot into. Serves no HTTP (plan §1). Used by the
  full-stack `app` compose service (PR 1.5); needs `DATABASE_URL`.
- `migrate:dev` / `migrate:deploy` / `migrate:status` / `migrate:reset` —
  Prisma migration lifecycle. These DO need a database: bring one up with
  `./dev pg up` and set `DATABASE_URL`. Prisma auto-loads a gitignored
  `services/indexer/.env`; from inside the tools container the dev DB is
  `postgresql://nvhash:nvhash-dev@postgres:5432/nvhash?schema=indexed`
  (the `?schema=indexed` selects this service's schema; `migrate deploy`
  creates it on an empty database). Copy `.env.example` to start.

### Full-stack wiring (PR 1.5)

`infra/devnet/stack.sh up` brings up Postgres + this indexer + api + web against
the dev node in one command: it applies the two-domain role split
(`infra/dev/postgres/roles.sql` — `indexer_writer`/`api_reader`/`app_writer`,
ADR-001 Decision 1), migrates the `indexed` schema **as `indexer_writer`** so it
owns every table, then starts the `app` compose profile and waits for each
component healthy. `infra/devnet/stack.sh verify` runs the grant-boundary gate;
`… down` stops the app services. The indexer's own health is the DB-ping
heartbeat (`scripts/healthcheck.mjs`), not an endpoint.

### CI gates (standing from PR 1.1)

`pnpm -r run typecheck` and `pnpm -r run test` in the `app-ci` workflow pick
these up automatically. `test` includes the security-executable gates
(SECURITY.md, plan §4), which fail CI on violation:

- **Schema-field allowlist** (`test/schema-allowlist.test.ts`): every `indexed`
  column must be on the SECURITY.md allowed-fields list
  (`test/security/allowed-fields.ts`) — a column outside it, or matching a
  PII/IP/device substring, fails. Adding a column is a design-review event:
  edit the allowlist, don't just migrate. The same suite asserts amount
  discipline (every amount column is `Decimal(39,0)`, no `Float`).
- **Log scrubbing** (`test/log-scrubbing.test.ts`): the source tree must never
  reference an IP/device/identity token (`test/security/scan-logs.ts`); the
  logger's `SAFE_FIELDS` allowlist is asserted identity-free.

- **Grant boundary** (`test/integration/grant-boundary.test.ts`, standing from
  PR 1.5): against a live Postgres bootstrapped by `roles.sql` and this
  service's migration, it asserts the ADR-001 Decision 1 ownership split —
  `api_reader` may SELECT but not INSERT/UPDATE `indexed`; `app_writer` may not
  SELECT `indexed`; `indexer_writer` has no privileges on `app`. It runs in the
  dedicated app-ci `db-grants` job (Postgres service, no devnet node) on every
  PR, kept out of the DB-free `pnpm -r run test` via a separate vitest config.
  A regression in `roles.sql` fails it.

PR 1.1 proved migrations clean on an empty database as the dev superuser; PR 1.5
delivers the role split (`indexer_writer` owning `indexed`) and the
grant-boundary gate (ADR-001 action item 4).
