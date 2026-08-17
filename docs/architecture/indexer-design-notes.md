# `services/indexer` — design notes

Rationale and recorded decisions for the chain-event indexer. Working
conventions are [`services/indexer/CLAUDE.md`](../../services/indexer/CLAUDE.md);
measured chain behavior is [`docs/specs/chain-facts.md`](../specs/chain-facts.md).
This document holds the *why* — read it before changing a worker's shape, a
cursor, or an idempotency guard.

## The two-phase worker contract

A worker is `collect(window)` then `write(tx, window, batch)` so that **chain
I/O never happens inside a database transaction**. `collect` reads and decodes
from chain with no DB access; `write` applies to the `indexed` schema with no
network access. The runner polls the head, pages the un-processed range into
bounded windows, and commits each via `runWindow`.

`runWindow` puts the data upserts *and* the `indexer_checkpoints` cursor advance
in one `prisma.$transaction`, so the cursor advances only after the window
commits. Workers never write their checkpoint directly.

### Why the window transaction sets an explicit timeout

`WINDOW_TX_TIMEOUT_MS` is 120 s. Prisma's 5 s default is a *latency* default,
but a window is a *throughput* unit: workers upsert row-by-row across up to
`INDEX_WINDOW_SPAN` (500) heights, so a busy window or a genesis backfill
crossed it — and an aborted window re-collects forever. The permissionless
`operator_payments` path made that materially more reachable.

The per-row round-trip count is unchanged and remains the underlying cost.
Batching it needs `INSERT … ON CONFLICT DO UPDATE`;
`createMany({skipDuplicates})` would break replay-corrects-stale-rows.

## Idempotency is a property of the SQL, not of scheduling

Upserts use `INSERT … ON CONFLICT DO UPDATE … WHERE observedHeight <
EXCLUDED.observedHeight`, so a window observing height H cannot overwrite a row
observed at H′ > H — even with a backfill running beside the live worker.
Prisma cannot express a conditional update arm, which is why these are
`$executeRaw`.

Supporting rules:

- Provenance and prune stamps are set-once (`IS NULL` / `COALESCE`).
- `executorResult` is monotone: a sweep's `NOT_RUN` default can never erase a
  known outcome.
- A prune **stamps, never deletes**.
- Pagination follows to exhaustion and **throws at the page cap** rather than
  truncating — a short sweep is indistinguishable from a prune and would mark
  live proposals pruned (chain-facts §x/group 3).

Only `test/integration/governance-roundtrip.test.ts` proves these guards are
real SQL. The unit replay suite mirrors the conditional-update arm in
TypeScript and would still pass if the `ON CONFLICT … WHERE` clause were
dropped.

## Two classes of bad input, handled differently

Deliberate asymmetry in the chain-events decoder:

- **Our own event's shape is wrong** — missing attribute, unparseable coin
  string. Only an upgrade or a decoder bug produces that, so it throws
  `DecodeError`.
- **A bucket is unpairable** — the transfer count does not match the payment
  count, or a `pay_commission`'s declared amount disagrees with the funds
  moved. This returns an `undecodable` entry: the payment is skipped, never
  stored as a guess, and logged. The rest of the window still commits.

Why the second is not an error: how many transfers land at a `msg_index` is a
property of how the *transaction* was composed, and paying is permissionless
(chain-facts §contract 4) — a contract batching two `pay_tip` sub-calls in one
message legally produces two. Throwing there aborted `collectWindow`, and since
the runner re-collects an aborted window on restart, one such transaction
stalled the entire chain-events stream — `transactions` and
`redemption_requests` included — permanently.

The skip is recoverable because ingest is idempotent and rebuildable: a later
decoder picks the row up on replay. A wedged worker never is.

Batched payments are bucketed by `msg_index` and paired k-th to k-th
(chain-facts §events 3). `pay_commission` publishes its own amount, which
cross-checks the pairing whenever a commission is in the batch; a pure-tip batch
has no equivalent check, and the batched shape is **not yet in the devnet
corpus** — worth exercising before a batching caller exists in the wild.

## Governance: three planes and which is authoritative

`x/group` needs all three because no one of them is complete
(chain-facts §x/group 1–4):

1. **TX plane** (`tx_search`) — provenance, plus the terminal outcomes the
   state plane cannot hold, plus the only durable record of *who voted*.
2. **BLOCK plane** (`block_results.finalize_block_events`) — prune detection
   only. `EventProposalPruned` is the one x/group EndBlocker event, so
   `GROUP_BLOCK_EVENT_TYPES` is a set and an empty set skips the per-height
   fetch entirely.
3. **STATE plane** (height-pinned, paginated) — authority for the status and
   tally of every proposal the chain still holds, and the only observer of the
   eventless voting-period-end transition.

Policy discovery is **set-valued**: `Config.admin` → `group_policy_info` →
group → all policies on that group ∪ all policies the group's admin
administers. Never "the admin policy" — hardcoding a single policy is the
topology assumption SECURITY.md forbids, and the admin/ops split is open. A
plain-account admin yields the **empty set** and empty committed windows: the
honest no-governance state, not a crash. `GOV_GROUP_POLICIES` *adds* to
discovery (never replaces it) for a chain whose contract was deployed before its
group existed.

### Recovering a proposal whose whole lifecycle lands in one window

**This is the common case, not an edge:** a successful exec prunes in its own
transaction and a 500-height window is about eight minutes.

Such a proposal is absent from the ending sweep, and every event-derived write
is an `UPDATE` on `proposalId` — so without a base row the submit, exec result,
terminal tally and prune all silently affect zero rows and the proposal
vanishes, while its votes (which insert on `(proposalId, voter)`) survive as
orphans. `recoverAbsentProposals` does a height-pinned read to create the base
row.

**Which height gets pinned is the correctness of the pass**, and the two signals
are not interchangeable:

- a **submit** height is one the proposal existed at;
- a **terminal** height is one where it is already gone — a prune lands in the
  same block as its transaction — so the block *before* it is the last that had
  it.

A naive minimum across both can pin *before* the proposal existed. That was
caught by a test, not by review.

Submit-and-finish in the same block — reachable with
`MsgSubmitProposal.exec = EXEC_TRY` when the proposers alone meet the threshold
— has no live height at all. No read is attempted and it is logged; recovering
it from the submit tx *body* is a recorded follow-on.

A failed pinned read recovers **nothing** (chain-facts §lcd 3) and is not a
prune signal. The writer then declines to store that proposal's votes rather
than leave orphans the detail endpoint can never reach.

## The reconciler runs independently on purpose

`src/reconciler/` is the honesty alarm and the **sole writer of `incidents`**.
It runs as its own loop, independent of the workers, so it keeps running and
sees growing lag or divergence *even if ingestion stalls* — an alarm that stops
when the thing it watches stops is not an alarm.

Each pass reads the live plane and the indexed plane, then `deriveActions` — a
**pure** function of both — yields the `reconciler_runs` row plus incidents to
open and close, applied in one transaction. Purity is what lets the alarm be
unit-tested without Postgres.

Tolerances are in-code and **not env-tunable**: widening one would silence the
alarm. Copied snapshot values use exact equality (tolerance 0).

Cold start (no worker stream committed yet) reports `indexedHeight = 0`, never
the head, and does **not** fire a data-degraded incident — degraded means "was
fresh, now behind".

Point-in-time incidents (`slash_write_down`, `redemption_refund`) are opened
once and only for facts not already recorded, so per-pass work stays bounded as
history grows.

`vault_paused` and `jail_report` are live-derived closeables (PR 8.1):
the pause pair comes from a pinned vault read parsed by a local mirror
(`reconciler/decode.ts`), and jail episodes reuse the validator-sampler's
`parseJailReports` in-package. The jail dedupe key carries the EPISODE
(`valoper:{addr}:{reportedAtSeconds}`) — a bare valoper key would
reopen-in-place and merge a re-jail into the first episode's record.

Still deferred: `epoch_overdue` and the queue-length delta. `epoch_overdue`'s
constraint is not the decoder — **no falsifiable drill exists until a
calendar-month boundary can pass with the crank withheld** (the E-CAL
constraint), so its slack tolerance has no measured basis; its first exercise
is Phase B's T1 calendar-month observation window (M8 overview §5 T1.6).

A failed reconciler pass is LOGGED AND SKIPPED, never fatal (PR 8.1): the
reconciler advances no cursor, so the workers' crash-fatal rule does not apply
to it — a skipped pass is honest (the previous run's `ranAt` ages, and the
chrome's stale-heads clause surfaces exactly that), while a killed process is
a silenced alarm. The alarm must outlive what it watches; compose's
`restart: unless-stopped` covers the workers' fatal-crash contract.

## Local mirrors over cross-package imports

`decode/attributes.ts` mirrors the amount discipline in
`packages/chain-client/src/amounts.ts` rather than importing it, keeping the
indexer runtime at a zero cross-package dependency surface (SECURITY.md supply
chain).

The epoch-history decoder likewise mirrors chain-client parsers locally: raw
Node's strip-only TypeScript cannot import that package's `.ts` sources. Whether
height-pinned query promotes into `@nvhash/chain-client` is still open, and moot
at runtime for the same reason.

## Schema-allowlist extensions — recorded design-review events

The schema-field allowlist gate treats adding a column as a design-review event.
Each extension is recorded here, per the gate's own contract.

**`GovProposal` / `GovVote` (reviewed 2026-07-29).** The tables had existed with
nine and six columns and nothing had ever written them — the devnet had no
`x/group` substrate at all until it was
bootstrapped. The column set and rationale were approved in advance (M7 overview
D3 + the app-spec §9.1 forward note), with two deltas recorded rather than
slipped in:

- `proposer` was **replaced** by `proposers String[]` — x/group permits several,
  so the scalar was a lie whenever there were two.
- `title` / `summary` were added **by direction (Ira, 2026-07-29)** beyond that
  enumeration: SDK ≥ 0.50 proposal fields, public chain text, and the only
  human-readable label a proposal has — which for a pruned proposal exists
  nowhere else.

`height` / `txhash` widened to nullable on both tables: a proposal or vote
recovered from a height-pinned sweep has no transaction to point at, and null is
honest where a fabricated height is not. Tally counts and `weight` are
`Decimal(39,0)` unbounded weight sums, not token amounts
(chain-facts §x/group 10).

**`OperatorPayment.ordinal` (reviewed 2026-07-28).** The
payment's position within its `(txhash, msgIndex)`, derived from event order in
the tx. It is part of the row's natural key: a message may batch several
payments, and a two-part key made every sibling upsert onto the same row,
silently keeping only the last. Read off chain data, never user or off-chain
input.

**`OperatorPayment` model.** Nine columns, all read straight off a public tx,
reviewed 2026-07-27 against the §14.11 operator-CSV requirement that
`validator_epochs` provably cannot serve (per-epoch cumulative totals, no
txhash). `payer` is a bech32 account already public in the tx body, kept because
payment is permissionless and an operator auditing "who paid on my behalf" needs
it (decided, Ira 2026-07-27).

**Index-only changes may ride another lane's branch** (one-PR-per-milestone
precedent), since they add no column and leave the allowlist unaffected. Two
carry rationale a reader would otherwise be tempted to simplify away:

- `redemption_requests.@@index([lastHeight])` serves the notifier's cursor read,
  which selects `lastHeight > since_height` ascending each tick.
- `operator_payments` and `transactions` each carry the `msgIndex` tie-break
  column on their walk index (`(valoper, height, msgIndex, ordinal)`,
  `(address, height, msgIndex)`) rather than the leading column alone. That
  column is what lets the §14.11 exports' keyset predicate
  `(height, msgIndex) > (?, ?)` become a real index range bound instead of a
  post-scan filter. Measured 2026-07-28 at 300 000 rows for one valoper: without
  it, 9 564 buffers / 25 ms per chunk and rising with depth; with it, ~42
  buffers / 0.2 ms, flat at every depth.

The `indexed` schema stays indexer-owned; only DDL runs as `indexer_writer`.

## Schema history

The schema is one baseline migration, regenerated from the models, not an
append-only chain — see `services/indexer/CLAUDE.md`. Indexed data is
rebuildable from chain by definition, so until a database exists whose contents
cannot be recreated, a schema change is an edit to the models plus a rebuild.
One constraint the Prisma datamodel cannot express is therefore hand-written at
the end of the baseline and must survive a regeneration: `gov_proposals.proposers`
is `NOT NULL` — a list column's nullability is not a datamodel property, and
x/group requires at least one proposer.

## Deliberate nulls

`epochIndex` on `operator_payments` is null at ingest. Deriving it needs the
epoch-history worker's table, which would make replay order-sensitive;
`services/api` joins `epoch_snapshots` at read time instead.

`uptimeBps` has no capture yet and stores as 0, read together with `eligible`
rather than as an asserted 0%.

## Live-transport test coverage

`test/workers/governance-live.test.ts` skips unless `GOV_LIVE_LCD` /
`GOV_LIVE_CONTRACT` are set. None of the decode, sources, or replay suites
exercises the real transport, real pagination, or the interaction between the
three planes; this one does. On the governed devnet it reproduced all six drill
findings in a single pass — including the load-bearing one, that successfully
executed proposals are absent from chain state while their outcome is still
recoverable from events.
