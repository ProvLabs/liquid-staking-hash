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
  The window transaction sets an EXPLICIT `WINDOW_TX_TIMEOUT_MS` (120 s):
  Prisma's 5 s default is a latency default, but a window is a throughput unit —
  workers upsert row-by-row across up to `INDEX_WINDOW_SPAN` (500) heights, so a
  busy window or a genesis backfill crossed it, and an aborted window
  re-collects forever (2026-07-28 review). M6.4's permissionless
  `operator_payments` made that materially more reachable. The per-row
  round-trip count is unchanged and remains the underlying cost; batching it
  needs `INSERT … ON CONFLICT DO UPDATE`, since `createMany({skipDuplicates})`
  would break replay-corrects-stale-rows.
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
  **Operator payments (PR 6.4 commit A)** → `operator_payments`, a third decode
  provenance on the same tx-search leg: the CONTRACT's own `wasm` events for
  `pay_commission`/`pay_tip`, scoped by `_contract_address` (`EventScope` gains
  `contractAddress` — the `wasm` type belongs to every contract on chain, so
  that attribute is the only thing making an event ours). `decodeTxPayments` is
  the worker's one **pair** decoder and has to be: verified on devnet
  2026-07-27, `pay_tip`'s event carries only the epoch-cumulative `tip_epoch`,
  never the payment's own nhash — so amount and payer come from the bank
  `transfer` at the same `msg_index` with the contract as recipient (the
  attached funds, bounded to one coin by `cw_utils::must_pay`).
  **Batched payments DECODE** (PR #22 review): payments and transfers are
  bucketed by `msg_index` and paired k-th to k-th, because events are appended
  in EXECUTION order and a sub-message's funds transfer is emitted immediately
  before that sub-call's own wasm event. A contract batching two `pay_tip`
  sub-calls in one message is legal, and dropping it would lose real payments
  from history, totals and the CSV. `pay_commission` publishes its own amount,
  which cross-checks the pairing whenever a commission is in the batch; a
  pure-tip batch has no equivalent check, and the batched shape is NOT yet in
  the devnet corpus — worth a §7 Q1-style exercise before a batching caller
  exists in the wild.
  **Two classes of bad input, deliberately handled differently** (2026-07-28
  review): our own event's shape (missing attribute, unparseable coin string —
  only an upgrade or a decoder bug makes that) still throws `DecodeError`;
  but an UNPAIRABLE bucket — a transfer count that does not match the payment
  count, or a `pay_commission` whose declared `amount` disagrees with the funds
  moved — returns an `undecodable` entry instead. That payment is skipped
  (never a stored guess) and logged; the rest of the window still commits.
  Why: how many transfers land at a `msg_index` is a property of how the
  TRANSACTION was composed, and paying is permissionless — a contract batching
  two `pay_tip` sub-calls in one message legally produces two. Throwing there
  aborted `collectWindow`, and since the runner re-collects an aborted window on
  restart, one such tx stalled the ENTIRE chain-events stream (`transactions`
  and `redemption_requests` included) permanently. The skip is recoverable
  because ingest is idempotent and rebuildable — a later decoder picks the row
  up on replay — which a wedged worker never is.
  `epochIndex` is deliberately null at ingest (deriving it needs the
  epoch-history worker's table, which would make replay order-sensitive);
  services/api joins `epoch_snapshots` at read time. Rows upsert by
  `(txhash, msgIndex)`; the replay property covers them.

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

- **`workers/governance/`** (stream `governance`, PR 7.1) → `gov_proposals` +
  `gov_votes`. Structurally chain-events (tx + block planes) crossed with
  validator-sampler (height-pinned sweep), because `x/group` needs both. Policy
  discovery is **set-valued** (`policies.ts`, decision D1): `Config.admin` →
  `group_policy_info` → group → all policies on that group ∪ all policies the
  group's admin administers. A plain-account admin yields the **empty set** and
  empty committed windows — the honest no-governance state, not a crash.
  `GOV_GROUP_POLICIES` adds policies to (never replaces) discovery, for a chain
  whose contract was deployed before its group existed; `GOV_START_HEIGHT`
  defaults to 1 (D13).

  **Six devnet observations (2026-07-29, `contracts/drills/gov-drill.sh`, pinned
  in `packages/fixtures/fixtures/manifest.json`) shape this worker, and FOUR of
  them contradicted the M7.1 plan. The manifest is authority over the plan text
  where they differ:**
  1. **A successfully executed proposal is pruned in its OWN transaction**, so
     `ACCEPTED` + `SUCCESS` is a pair no state read can ever return.
     `EventExec.result` plus `EventProposalPruned` (which carries the terminal
     status AND the full tally) are its only record — which is why the tx plane
     is load-bearing rather than provenance-only.
  2. **Votes are DELETED at the voting-period-end tally**, even for a proposal
     that passes; only `final_tally_result` survives. So `votes_by_proposal`
     recovers votes only while a proposal is OPEN (`state.ts` reads them for
     `SUBMITTED` only), per-voter history for anything closed exists solely in tx
     history, and an empty vote read must **never** delete stored rows (the
     writer's `COALESCE` arms).
  3. **A missing proposal answers HTTP 500, not 404**, with a body identical for
     a pruned id and one that never existed — and an LCD outage answers 500 too.
     Prune is therefore **never** inferred from a status code: only from absence
     in a **successful** paginated sweep (`sweepOk`) or an observed
     `EventProposalPruned`. `sweepOk` is a single flag across all policies
     because a partial sweep is not a weaker prune signal, it is none at all.
  4. **Voting-period-end transitions are EVENTLESS** — no tally event in
     `finalize_block_events`, so the state sweep is their only observer.
     `EventProposalPruned` is the ONE x/group EndBlocker event (295 heights
     scanned), which is what the block plane exists for; `GROUP_BLOCK_EVENT_TYPES`
     is a set, and an empty set skips the per-height fetch entirely.
  5. `EventVote` carries only `proposal_id` + `msg_index` — voter and option come
     from the **`MsgVote` body**, paired by `msg_index` (never positionally, and
     never by txhash: one tx may carry several votes for different proposals).
     The `Vote` payload has **no weight**; weight comes from `group_members` at
     the height, or stays null.
  6. A second `MsgVote` from the same voter is **rejected by the chain**, so
     `(proposalId, voter)` is a sound natural key — **measured, not assumed**,
     because M6.4 shipped a named-and-gated natural key that was wrong.

  **A proposal whose WHOLE lifecycle lands in one window is RECOVERED by a pinned
  read** (`state.ts` `recoverAbsentProposals`, added by the PR #23 review's P1).
  It is absent from the ending sweep, and every event-derived write is an UPDATE on
  `proposalId` — so without a base row the submit, exec result, terminal tally and
  prune all silently affected zero rows and the proposal vanished, while its votes
  (which insert on `(proposalId, voter)`) survived as orphans. **This is the common
  case, not an edge:** a successful exec prunes in its own transaction and a
  500-height window is about eight minutes. The M7.1 plan §2.2 specified this read;
  it was dropped in implementation when the 404-means-pruned semantics were
  corrected — the mechanism went out with the wrong error handling instead of being
  re-based on the right one.
  Which height gets pinned is the correctness of the pass, and the two signals are
  NOT interchangeable: a SUBMIT height is one the proposal existed at, while a
  terminal height is one where it is already gone (a prune lands in the same block
  as its transaction), so the block before it is the last that had it. A naive
  minimum across both can pin BEFORE the proposal existed — caught by a test, not by
  review. Submit-and-finish in the SAME block (reachable with
  `MsgSubmitProposal.exec = EXEC_TRY` when the proposers alone meet the threshold)
  has no live height at all: no read is attempted, it is logged, and recovering it
  from the submit tx BODY is a recorded follow-on. A failed pinned read recovers
  NOTHING — below a pruning node's retention horizon it is the app-spec §9.3 caveat,
  not a prune signal — and the writer then declines to store that proposal's votes
  rather than leave orphans the detail endpoint can never reach.

  **Idempotency is a property of the SQL, not of scheduling** (§4b C3):
  `store.ts` upserts with `INSERT … ON CONFLICT DO UPDATE … WHERE
  observedHeight < EXCLUDED.observedHeight`, so a window observing height H
  cannot overwrite a row observed at H′ > H even with a backfill running beside
  the live worker. Prisma cannot express a conditional update arm, which is why
  these are `$executeRaw`. Provenance and prune stamps are set-once
  (`IS NULL` / `COALESCE`); `executorResult` is monotone and a sweep's `NOT_RUN`
  default can never erase a known outcome (a hole the replay suite caught, not
  review). A prune **stamps, never deletes**. Pagination follows to exhaustion
  and **throws at the page cap** rather than truncating — a short sweep is
  indistinguishable from a prune and would mark live proposals pruned.
  Tally counts and weights are `Decimal(39,0)`: they are unbounded WEIGHT sums,
  not token amounts, so a JS number would corrupt them past 2^53.

  Tests: `test/workers/governance-decode` (fixture corpus, 18),
  `-sources` (discovery, pagination cap, `sweepOk` gating, honest-empty, 12),
  `-replay` (fast-check convergence + the three §9 invariants, 15), and
  `test/integration/governance-roundtrip.test.ts` (14) — the last is the only one
  that proves the guards are real SQL, since the replay suite mirrors them in
  TypeScript and would still pass if the `ON CONFLICT … WHERE` clause were
  dropped. Plus **`-live`**, which skips unless `GOV_LIVE_LCD`/`GOV_LIVE_CONTRACT`
  are set (the `e2e-live` convention; it needs a devnet with the substrate
  bootstrapped and `gov-drill.sh` run — invocation is in the file header). None of
  the other three exercises the real transport, real pagination, or the
  interaction between the three planes; this one does, and on the governed devnet
  it reproduced all six drill findings in a single pass — including the load-
  bearing one, that successfully executed proposals are absent from chain state
  while their outcome is still recoverable from events.

## Reconciler (PR 2.5)

`src/reconciler/` is the honesty alarm (spec §9.6/§12.1) and the **sole writer of
`incidents`**. It runs as its OWN loop (cadence `RECONCILE_INTERVAL_MS`, default
30 s) **independent of the workers**, so it keeps running and sees growing
lag/divergence even if ingestion stalls (§12.1.3). Each pass reads the live plane
(chain's retained latest snapshot + halted, via pinned-at-head smart queries) and
the indexed plane (DB), then `deriveActions` — a **pure** function of both planes
— yields the `reconciler_runs` row plus incidents to open/close, applied in one
transaction. Purity is what lets the alarm be unit-tested without Postgres.

- **`tolerances.ts`** — per-metric tolerances, in-code and **not env-tunable**
  (widening one would silence the alarm, §12.1.3). Copied snapshot values use
  exact (0); `lagHeights` bounds trailing before DATA DEGRADED.
- **Incidents:** `reconciler_divergence` (indexed copy ≠ chain), `indexer_lag`
  (per-stream checkpoint lag), `contract_halted` (closeable); `slash_write_down`,
  `redemption_refund` (point-in-time — opened once, and only for facts not
  already recorded, so per-pass work stays bounded as history grows). Cold start
  (no worker stream committed yet) reports `indexedHeight = 0`, never the head
  (§12.1 honesty), and does NOT fire a DATA-DEGRADED incident (that means "was
  fresh, now behind"). Deferred fast-follow (need more live decoders):
  `vault_paused`, `jail_report`, `epoch_overdue`, and the queue-length delta.
- **Tests:** `test/reconciler/reconciler.test.ts` (pure, Postgres-free — deltas,
  lag, derivation incl. the corrupt-value alarm) and
  `test/integration/reconciler-alarm.test.ts` (the Postgres-backed acceptance
  gate: corrupt an indexed row → incident opens; fix → closes), in the
  `db-grants` job alongside grant-boundary.

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
- `test:grants` — the Postgres-backed integration tests (needs Postgres, see
  "Full-stack wiring" below): the grant-boundary gate, the PR 2.5 reconciler
  alarm acceptance gate, the PR 6.4 `operator_payments` round-trip, and the PR
  7.1 `gov_proposals`/`gov_votes` round-trip (`test/integration/`). That last one
  is where the governance monotonicity guard is actually gated: the unit replay
  suite mirrors the conditional-update arm in TypeScript, so only this suite
  fails if the SQL loses it.
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

Index-only migrations may ride another lane's branch (one-PR-per-milestone
precedent): the M6.2 notifier's redemption cursor read added
`@@index([lastHeight])` on `redemption_requests`
(`20260724010000_redemption_last_height_index`) via `apps/web`'s PR 6.2 — no
column, schema-allowlist unaffected, rebuildable. The 2026-07-28 review added
`20260728000000_keyset_indexes` the same way: `operator_payments` and
`transactions` each gain the `msgIndex` tie-break column on their existing
index (`(valoper, height, msgIndex)`, `(address, height, msgIndex)`), replacing
the narrower one. That column is what lets the §14.11 exports' keyset predicate
`(height, msgIndex) > (?, ?)` become a real index range bound instead of a
post-scan filter — no column added, allowlist unaffected. The `indexed` schema stays
indexer-owned; only DDL runs as `indexer_writer`.

**Allowlist extensions to date** (each a recorded design-review event, per the
gate's own contract): PR 7.1 commit B extended `GovProposal` and
`GovVote` (`20260729000000_governance_state`) — the tables had existed since the
init migration with nine and six columns and NOTHING had ever written them,
because the devnet had no `x/group` substrate at all until commit A bootstrapped
one. The column set and its rationale were approved IN ADVANCE (M7 overview D3 +
the app-spec §9.1 forward note), with two deltas recorded rather than slipped in:
`proposer` was **replaced** by `proposers String[]` (x/group permits several, so
the scalar was a lie whenever there were two), and `title`/`summary` were added
by direction (Ira, 2026-07-29) beyond that enumeration — SDK >= 0.50 proposal
fields, public chain text, and the only human-readable label a proposal has,
which for a pruned proposal exists nowhere else. `height`/`txhash` widened to
NULLABLE on both tables: a proposal or vote recovered from a height-pinned sweep
has no transaction to point at, and null is honest where a fabricated height is
not. Every column is public chain data; the tally counts and `weight` are
`Decimal(39,0)` unbounded weight sums, not token amounts. the PR #22 review added `OperatorPayment.ordinal`
(`20260728010000_operator_payment_ordinal`) — the payment's position within its
`(txhash, msgIndex)`, derived from event order in the tx. It is part of the
row's natural key: a message may batch several payments, and the old two-part
key made every sibling upsert onto the same row, silently keeping only the
last. An ordinal read off chain data, never user or off-chain input. PR 6.4
commit A added the `OperatorPayment` model —
nine columns, all read straight off a public tx, reviewed 2026-07-27 against
the §14.11 operator-CSV requirement that `validator_epochs` provably cannot
serve (per-epoch cumulative totals, no txhash). `payer` is a bech32 account
already public in the tx body, kept because payment is permissionless and an
operator auditing "who paid on my behalf" needs it (decided, Ira 2026-07-27).

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
