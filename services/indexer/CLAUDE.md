# CLAUDE.md — indexer

Chain-event indexer feeding the query store used by `services/api/`. Rationale
and recorded decisions:
[`docs/architecture/indexer-design-notes.md`](../../docs/architecture/indexer-design-notes.md).
Measured chain behavior: [`docs/specs/chain-facts.md`](../../docs/specs/chain-facts.md).
Read both before changing a worker, a cursor, or an idempotency guard.

## Conventions

- **Idempotent and resumable.** Reprocessing a block range must not corrupt or
  duplicate derived data. Replay from 0 must equal resume from any height.
- **Chain is the source of truth**; derived tables are rebuildable. A skipped
  row a later decoder can pick up on replay is always preferable to a stored
  guess — and to a wedged worker, which is never recoverable.
- **Idempotency lives in the SQL**, not in scheduling: conditional-update arms
  (`ON CONFLICT DO UPDATE … WHERE observedHeight < EXCLUDED.observedHeight`),
  set-once stamps, monotone status columns. Prisma cannot express a conditional
  update arm, so these are `$executeRaw`.
- **Pagination follows to exhaustion and throws at the page cap**, never
  truncates — a short sweep is indistinguishable from a prune.
- **Owns the `indexed` schema** (ADR-001 Decision 1,
  [ADR](../../docs/architecture/2026-07-14-adr-001-app-component-architecture.md)):
  its Prisma schema and migrations live here and run as the `indexer_writer`
  role, the only role with write access. This service never touches the `app`
  schema. Migrations must run cleanly on an empty database.
- **The schema is ONE baseline migration, not a history.** Nothing runs this
  schema outside dev and CI, so there is no deployed database whose state a
  migration has to reach: a schema change edits the models and is regenerated
  into `prisma/migrations/20260715013707_init`, and every environment is rebuilt
  (`./dev pg reset`, `migrate:deploy`) — indexed data is rebuildable from chain
  by definition. Add an incremental migration only once a database exists whose
  contents cannot be recreated. Regenerate with `prisma migrate diff
  --from-empty --to-schema-datamodel prisma --script`, keeping the file's
  hand-written header and its trailing constraints (which the datamodel cannot
  express).
- **Adding a column is a design-review event**, not a migration — edit the
  allowlist and record the rationale in the design notes.
- Amount columns are `Decimal(39,0)`, never `Float`. Weight sums are also
  `Decimal(39,0)`: they are unbounded and exceed 2^53.
- The reconciler and incident derivation live here (spec §9.6); the notifier
  does not (it is an `apps/web` worker).
- The generated read-only Prisma client for `indexed` is published as the
  `@nvhash/db-indexed` workspace package for `services/api`.
- Security ([`SECURITY.md`](../../SECURITY.md)): persist only public chain data
  plus minimal operational data — no user-identifiable information, no
  IP-to-address linkage (including logs); treat indexed events as untrusted
  input; never hold keys or sign.

## Runtime

Shared machinery under `src/`. No worker re-implements a cursor, a decode, or a
transport.

- **`runtime/worker.ts`** — the loop shell (`runWorker`) and `registerWorker`.
  A worker is **two-phase** so chain I/O never happens inside a DB transaction:
  `collect(window)` reads and decodes from chain (no DB); `write(tx, window,
  batch)` applies to `indexed` (no network).
- **`runtime/checkpoint.ts`** — `runWindow` commits a worker's data upserts
  *and* the `indexer_checkpoints` cursor advance in one `prisma.$transaction`;
  the cursor advances only after the window commits (spec §9.2). Workers never
  write their checkpoint directly. `trailingTarget` applies the confirmation
  depth (default 0 — Provenance instant finality). `WINDOW_TX_TIMEOUT_MS` is an
  explicit 120 s: a window is a throughput unit, not a latency one, and an
  aborted window re-collects forever.
- **`runtime/streams.ts`** — the `STREAMS` names and `assertChainIsolation`, the
  per-`(chain_id, contract)` boot check (spec §9.3): the process fails closed if
  the DB holds a foreign history. The marker is a reserved `meta:provenance` row
  in `indexer_checkpoints`; `meta:`-prefixed rows are markers, not worker
  cursors, and lag accounting excludes them.
- **`decode/attributes.ts`** — the single site for the pinned attribute quoting
  layer (chain-facts §events 1): `dequote`, `attr`/`optionalAttr`, `coinAttr`.
  Amount discipline mirrors `packages/chain-client/src/amounts.ts` locally,
  keeping the runtime at a zero cross-package dependency surface.
- **`transport/rpc.ts`** — the transports chain-client (REST-only) lacks:
  `RpcClient` (`block_results`, `tx_search`, `block_search`, `latestHeight`) and
  `PinnedLcdClient.smartAtHeight` / `.getAtHeight` (height-pinned reads via
  `x-cosmos-block-height`). First-party, fetch-based, zero runtime deps.

## Workers

- **`workers/chain-events/`** → `transactions`, `redemption_requests`,
  `operator_payments`. Dual source: `tx_search` plus `block_results` per height
  (EndBlocker payout/refund + NAV marker). `decode.ts` maps raw events to typed
  `DomainEvent`s scoped to the program's vault/receipt denom and, for contract
  payments, to `_contract_address` (chain-facts §events 2). `reduce.ts` is a
  pure fold over an abstract `Store`. Idempotency: `Transaction` upserts by
  `(txhash, msgIndex)` with a deterministic synthetic txhash for txless
  EndBlocker rows; `RedemptionRequest` by `requestId`; `OperatorPayment` by
  `(txhash, msgIndex, ordinal)`. Running NAV persists across windows in a
  reserved `meta:chain-events:nav` checkpoint row.
- **`workers/epoch-history/`** → `epoch_snapshots`. The contract retains only
  the latest snapshot (chain-facts §contract 5), so history is read by
  height-pinned smart query at each `run_epoch` crank height. `boundaries.ts`
  locates cranks; `snapshot.ts` fetches epoch_snapshot + apr as of that height.
  Upsert by `epochIndex`.
- **`workers/validator-sampler/`** → `validator_registry`, `validator_epochs`.
  Anchored to epoch cranks: height-pinned contract `validators()` /
  `jail_reports()` plus x/staking moniker and program delegation. Registry
  enrollment is set-once; a validator absent at a crank is marked
  `unregisteredAt` — the one stateful bit, forward-deterministic so replay
  converges. Writes facts only; the reconciler derives incidents from them.
- **`workers/governance/`** → `gov_proposals`, `gov_votes`. Crosses three planes
  (tx, block, height-pinned state) because `x/group` needs all three — see the
  design notes. Policy discovery is **set-valued** (`policies.ts`); a
  plain-account admin yields the empty set and empty committed windows, the
  honest no-governance state. `GOV_GROUP_POLICIES` *adds* to discovery, never
  replaces it; `GOV_START_HEIGHT` defaults to 1.

## Reconciler

`src/reconciler/` is the honesty alarm (spec §9.6/§12.1) and the **sole writer
of `incidents`**. It runs as its own loop (`RECONCILE_INTERVAL_MS`, default
30 s) **independent of the workers**, so it keeps seeing growing lag and
divergence even if ingestion stalls.

Each pass reads the live plane and the indexed plane, then `deriveActions` — a
**pure** function of both — yields the `reconciler_runs` row plus incidents to
open and close, applied in one transaction. Its deps include `vaultAddress`
(the pause read). **A pass is all-or-nothing**: any failed live read derives
nothing and closes nothing (an unknown pause state must never read as
"unpaused"), and a failed pass is **logged and skipped, never fatal** — the
reconciler advances no cursor, so the workers' crash-fatal rule does not
apply; the alarm must outlive what it watches.

- **`tolerances.ts`** — per-metric, in-code, **not env-tunable**: widening one
  would silence the alarm. Copied snapshot values use exact equality.
- **Incidents:** `reconciler_divergence`, `indexer_lag`, `contract_halted`,
  `vault_paused` (dedupeKey `paused`), `jail_report` (dedupeKey carries the
  EPISODE — `valoper:{addr}:{reportedAtSeconds}`, so a re-jail never merges
  into the first episode's record) — all closeable; `slash_write_down`,
  `redemption_refund` (point-in-time, opened once). Cold start reports
  `indexedHeight = 0`, never the head, and fires no data-degraded incident.
  Still deferred (spec §9.6): `epoch_overdue`, queue-length delta.

## Commands

Part of the root pnpm workspace (ADR-001 Decision 4); all JS tasks run in the
containerized toolchain (ADR-002): `./dev pnpm --filter @nvhash/indexer
<script>`. Dev database via `./dev pg up` (host port 5433); the dev chain is
reachable in-network as `http://dev-node:1317`.

- `typecheck` — `prisma generate` then `tsc --noEmit`. Generate runs first so
  the client types exist; it reads only the schema, so CI needs no database.
- `test` — Vitest. Includes the security-executable gates below. No DB, so
  `pnpm -r run test` stays Postgres-free.
- `test:grants` — the Postgres-backed integration suites (`test/integration/`):
  grant boundary, reconciler alarm, `operator_payments` round-trip, and the
  `gov_proposals`/`gov_votes` round-trip. **The governance monotonicity guard is
  gated only here** — the unit replay suite mirrors the conditional-update arm
  in TypeScript and would still pass if the SQL lost it.
- `generate` — regenerate the Prisma client from `prisma/` into the explicit,
  gitignored `generated/client` path (a sibling of `prisma/`, since anything
  inside it is read as multi-file schema source; imported only via
  `src/prisma.ts`). Every generator in this schema declares an explicit
  `output` — `apps/web` is the repo's sole writer of the hoisted
  `@prisma/client`, and the `prisma-generator-output` test gates the rule.
- `start` — `prisma generate` then run the supervisor (`src/index.ts`): connects
  as `indexer_writer`, runs the chain-isolation boot check, starts the workers,
  and proves liveness via a DB ping written to a heartbeat file
  (`scripts/healthcheck.mjs`). Serves no HTTP, holds no keys, signs nothing —
  there is deliberately no server, listener, or signer here.
- `migrate:dev` / `:deploy` / `:status` / `:reset` — Prisma migration lifecycle.
  These need a database: `./dev pg up` and set `DATABASE_URL`. Prisma auto-loads
  a gitignored `services/indexer/.env`; from inside the tools container the dev
  DB is
  `postgresql://nvhash:nvhash-dev@postgres:5432/nvhash?schema=indexed`.

`test/workers/governance-live.test.ts` skips unless `GOV_LIVE_LCD` /
`GOV_LIVE_CONTRACT` are set; it is the only suite exercising the real transport,
real pagination, and the interaction between the three planes.

### Full-stack wiring

`infra/devnet/stack.sh up` brings up Postgres + indexer + api + web against the
dev node in one command: it applies the two-domain role split
(`infra/dev/postgres/roles.sql` — `indexer_writer`/`api_reader`/`app_writer`,
ADR-001 Decision 1), migrates `indexed` **as `indexer_writer`** so it owns every
table, then starts the `app` compose profile and waits for each component
healthy. `… verify` runs the grant-boundary gate; `… down` stops the app
services.

## CI gates

`pnpm -r run typecheck` and `pnpm -r run test` in `app-ci` pick these up. All
fail CI on violation.

- **Schema-field allowlist** (`test/schema-allowlist.test.ts`): every `indexed`
  column must be on the SECURITY.md allowed-fields list
  (`test/security/allowed-fields.ts`); a column outside it, or matching a
  PII/IP/device substring, fails. The same suite asserts amount discipline.
- **Log scrubbing** (`test/log-scrubbing.test.ts`): the source tree must never
  reference an IP/device/identity token; the logger's `SAFE_FIELDS` allowlist is
  asserted identity-free.
- **Grant boundary** (`test/integration/grant-boundary.test.ts`, `db-grants`
  job): against a live Postgres bootstrapped by `roles.sql`, asserts the ADR-001
  Decision 1 ownership split — `api_reader` may SELECT but not write `indexed`;
  `app_writer` may not SELECT `indexed`; `indexer_writer` has no privileges on
  `app`. A regression in `roles.sql` fails it.
- **Reconciler alarm** (`test/integration/reconciler-alarm.test.ts`, `db-grants`
  job): corrupt an indexed row → incident opens; fix → closes.
- **Replay convergence** — per-worker `-replay` suites (fast-check): replay from
  0 equals resume from any height, and re-apply is idempotent. Governance adds
  the three §9 invariants.
