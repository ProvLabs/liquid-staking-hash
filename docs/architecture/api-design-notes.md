# `services/api` — design notes

Rationale, measured results, and recorded decisions for the query API. The
durable interface is `docs/specs/app-spec.md` §9; the working conventions are
[`services/api/CLAUDE.md`](../../services/api/CLAUDE.md). This document holds
the *why* — read it before changing a read path, a cursor, or an auth rule.

## Why the API is DB-only

ADR-001 Decision 1: this service has no chain client by design. It serves the
durable **mirror**; everything that must be true *right now* — live tallies, the
current policy set, current membership — is a web-tier read. `/market` and
`/portfolio` established the division and `/governance` follows it.

Two consequences worth stating because they look like bugs:

- `/governance/policies` is the **historical** set observed in `gov_proposals`.
  A policy that exists on chain but has never had a proposal is legitimately
  absent.
- Every figure is as of `observed_height`, never "now".

## Honest-empty over absent

A shape-complete endpoint serving nulls is preferred to a missing endpoint. The
web tier renders null as "n/a" and never as `0`. `/market` set the precedent
while the market sampler was parked; `/redemptions/stats` follows it with
`sample_count: 0` + `cold_start: true` until data and a settled epoch exist.

Statistical gates live **server-side and ride in the payload as data**, so the
web tier does not re-decide them: the ≥10-terminal and ≥1-completed-epoch gates
null the stats, and the 21–60-day band bounds are payload fields. A
small-sample "typical" would be a lie, so below threshold the flow shows the
60-day guarantee alone.

## Authorization is in-process, never topological

ADR-001 Decision 2. Address-scoped routes require a short-lived HMAC service
assertion minted by the web tier's session layer, verified *inside this
process*. "The web app is the only caller" is not a control.

The failure ladder is deliberately uninformative — every rejection is a bare
401 with no distinguishing detail, so an attacker learns nothing about which
check failed. Order is pinned at 429→404→405→401→400→403; the scope↔address
equality check is last because it needs the zod-parsed query.

**An unowned valoper is answered honest-empty, never 403.** A 403 would confirm
the valoper exists and belongs to someone else. `test/operator-endpoints.test.ts`
asserts an unowned valoper and a well-formed nonexistent one are byte-identical.

The operator surface carries a second boundary beyond the scope check: the
address→valoper mapping resolves server-side from `validator_registry.operator`,
the single source, and every other operator read is called only on a valoper
that came from it.

## Cursors: why row comparison, why `$queryRaw`

`operator_payments` is the one indexed table fed by a **permissionless** write
path — anyone may `PayTip` for any validator (chain-facts §contract 4) — so its
row count is bounded by nobody, and anything reading it must be sized for that
rather than for the validator cap.

Three cursor forms were measured on the dev DB at **300 000 payments on one
valoper** (2026-07-28, superseding a 2026-07-27 plan-check). Only the third is
flat:

| form | total | notes |
|---|---|---|
| `OFFSET` chunking | 14.8 s, +323 MB RSS | each chunk re-scans every prior row |
| Prisma two-arm `OR` cursor | 6.2 s | Postgres cannot push it into an index condition and demotes it to a post-scan `Filter` (`Rows Removed by Filter: 250 118`) — still quadratic, and it *looks* fast if you only sample the last chunk |
| SQL row comparison `("height","msgIndex","ordinal") > (?,?,?)` | **1.6 s** | `Index Cond: … ROW(…) > ROW(…)`, ~56 buffers / 0.3 ms per chunk at **any** depth, heap flat at 24 MB, first byte immediate |

Prisma's query builder cannot express row comparison. That — not preference —
is why `operatorPaymentsAscStream` / `transactionsAscStream` are `$queryRaw`.
Completeness is the property under test, so a cursor that skips a row is a wrong
statement of fact; gated by the chunk-boundary / same-height-burst case in
`test/integration/reader.test.ts`.

`latestOperatorEpochs` and the public `listValidators` use **`DISTINCT ON`**,
not Prisma's `distinct`, which is not pushed down — the emitted SQL carried
neither `DISTINCT ON` nor `LIMIT` (verified from the Postgres statement log) and
fetched `validators × epochs_ever` rows to return one per valoper.

Do **not** cargo-cult keyset machinery onto structurally tiny tables. Proposals
per policy number in the tens; adding raw SQL there buys nothing.

### Recorded decisions — accepted as-is

**`operatorPaymentTotalsFor` seq scan (Ira, 2026-07-28).** The planner flips to
a full parallel seq scan (8 663 buffers, 58 ms) once one valoper holds a large
share of `operator_payments`. It is index-backed at even distribution (3
buffers) and runs on every `/validators/mine` load. A covering
`(valoper, paymentType, amount)` index was built and measured: **no effect** —
with one valoper holding most of the table the seq scan is genuinely the cheaper
plan. Do not "fix" this with an index; that was tried and measured. Do not
denormalise until real volumes justify it. Bounding it would need precomputed
totals, i.e. a schema change. Re-open only if a validator's payment count makes
the summary read a visible cost.

**Deep `OFFSET` on `/operator/payments` (Ira, 2026-07-28).** Linear in the
offset by construction. The composite index removed the sort (67 ms → 32 ms,
pure `Index Scan Backward`). `MAX_PAGE_OFFSET` deliberately stays the *shared*
codebase bound rather than a per-route one — a lower bound here would be exactly
the per-route divergence the consistency lens flags. The CSV export is keyset
and unaffected.

Query plans are index-backed **except** `validator_registry` (bounded by the
validator cap) and `epoch_snapshots` (one row per calendar month). Both are
structurally tiny, so no index was added.

## Shape decisions that look arbitrary

**`?id=` is a string schema.** x/group proposal ids are uint64 and the JSON
number domain stops at 2^53, so `z.coerce.number()` would silently accept a
corrupted id. The schema validates a canonical decimal string — no leading
zeros, so one proposal cannot be addressed by two spellings.

**`proposal` is a query param, not a path segment.** `findRoute` is an exact
string match; this service has no path-parameter support at all. The web tier is
free to use `/governance/:proposalId` for its own URL.

**An unknown id is 404, not an empty 200.** "We hold no record of this id" and
"it exists and is blank" are different answers; conflating them renders a
mistyped id as a real, empty proposal.

**Truncation is always flagged.** `votes[]` is not page-controlled by the
caller — a proposal's vote set size is a property of the group, and x/group caps
membership at nothing (chain-facts §x/group 9). A payload that quietly dropped a
message would misstate what is being voted on, so both trims carry
`votes_truncated` / `messages_truncated`.

**`indexed_from_height` is load-bearing.** x/group prunes, so a proposal that
closed before the indexer existed is unrecoverable; a list omitting it silently
would imply a completeness it lacks. Null — never 0 — when no height certifies
the window.

**CSV amount columns carry base-unit names.** The operator export serves
`nhash_amount`, not `hash_amount`: the value is nhash base units, so a
whole-HASH column name would read 10⁹× high and contradict `/validators/mine`,
which formats the same fact to whole HASH. Base-unit content under a base-unit
column name is the convention for both exports. A CSV column that renames a unit
renames it in the spec's §14.11 delivery note in the same change.

## Shared formulas, not parallel implementations

`meetsThreshold` (`@nvhash/api-types/tally.ts`) and `navHashPerShare` are shared
because a duplicated formula drifted once already, and two implementations of
"has this passed?" would eventually disagree about the same proposal.
Threshold compares YES weight **alone** — writing it as `yes - no` reimplements
a different module's rule. BigInt-only over unbounded member weights, with
**null for undecidable** (unknown policy type, malformed count, percentage rule
with no electorate).

Wire bounds live in `@nvhash/api-types/bounds.ts` — one declaration imported by
both tiers, with `packages/api-types/test/bounds.test.ts` asserting producer ⊆
consumer for every registered pair. This closes a defect class where a fix added
a constant while `rows.ts` went on coupling the two sides in a *comment*, so
nothing imported or tested the pairing. The pre-governance collection bounds on
`/validators`, `/portfolio.active_redemptions` and `/market` were adopted into
the registry at PR 8.0b (producer caps, flagged trims, `CORE_BOUNDED_FIELDS`
cross-check) — the registry is complete for the v1 wire surface.

## Registry-derived test harnesses

The cross-address and envelope suites iterate the actual route table, so a new
route is covered automatically and cannot slip past the harness. Two traps this
was built to catch:

- A route needing extra required params must declare them
  (`VALOPER_PATHS` / `personalQuery`), and the suite asserts that coverage —
  otherwise a **400 masquerades as a deliberate 403**.
- The same applies to public routes with a required param
  (`PUBLIC_REQUIRED_QUERY`): a public route 400s under the bare harness, and a
  400 can look like a rejection that was never tested.

## Measured under load — 2026-08-14 (PR 8.2, the reproducible pass)

Environment: single Docker host (macOS Docker Desktop VM), `./dev` stack —
Postgres 17-alpine, API on Node 22, k6 1.3.0 in-network. Data from the
committed deterministic seeder (`seed:load`, seed 1) at the two recorded
depths. Latency runs at a raised `RATE_LIMIT_MAX=100000`; the rate-limit run
at the production default 120/60 s. Shortened sustain (60 s) for this pass;
the release-branch runs use the scenario defaults. Numbers are
environment-bound; the reproducibility, not the absolute values, is the
deliverable.

| Threshold | depth1 (400 k tx) | depth2 (1.2 M tx) | Verdict |
| --- | --- | --- | --- |
| T1 public-mix p95 @50 rps | 83 ms ✓ | **4.12 s ✗** | depth2 BREACH — see below |
| T2 `/portfolio/metrics` typical / heavy p95 | 103 ms ✓ / 6.77 s ✗ | 36 ms ✓ / 6.51 s ✗ | heavy BREACH — recorded, remedy is a follow-on per the ratified T2 lane |
| T3 `/admin/holder-cohorts` p95 (admin scenario) | 3.59 s ✗ | **21.6 s ✗ → commit D landed → 9.41 s ✗ loaded / 1.63 s unloaded** | breached → D landed; residual named below |
| T4 CSV completion / RSS | ✓ | completes (2.9 s max); RSS 285→504 MiB warm-up over five heavy streams, then FLAT (plateau) | streaming holds at steady state; the 64 MB "delta" as measured from a cold process is V8 heap warm-up, not per-stream retention — methodology recorded, no regression |
| T5 rate-limit correctness @ defaults | — | **PASS in full**: ceiling exact at 120, `Retry-After` ≤ 60 s, unknown paths consume budget (429 precedes 404), full recovery post-reset | limiter correct |
| T6 deep-OFFSET worst case (1 M) | 86 ms ✓ | 214 ms ✓ | accepted-linear decision stands |
| T7 indexer under load | NOT RUN | NOT RUN | needs the dev chain; runs at the first live-lane dispatch (the 8.1 activation posture) |

**T1's depth2 breach, diagnosed:** `/metrics` costs ~610 ms per request
unloaded at depth2 — `participant_count` is `COUNT(DISTINCT address)` over
1.2 M rows, uncached, per request — and `/redemptions/stats` ~190 ms. At
50 rps the mix carries ~5 rps of `/metrics`, which saturates the shared
Postgres and queues everything (median 1.17 s). Per T1's ratified lane this is
investigate-and-record: the remedy candidates (indexer-side participant-count
materialization, or response caching keyed on `indexedHeight`) are follow-on
design, and no index or cache rode in on this measurement.

**T3 and commit D:** the pre-D admin scenario at depth2 measured
`/admin/holder-cohorts` p95 = 21.6 s with 12 % request failures — far past the
pre-ratified 2.5 s criterion — so commit D landed the CO-20 recorded remedy:
`indexed.holder_lifecycles`, maintained by the chain-events worker as a
recompute-from-truth over each window's touched addresses, read back as an
indexed `ORDER BY + LIMIT` (equality-gated both ways in the indexer's
integration suite). Post-D the panel reads 1.63 s unloaded (from ~5 s+) and
9.41 s p95 under the full admin scenario. **The residual breach is not the
lifecycle fold**: `holderPositions` (the concentration read) is a second
whole-history window fold, and `/admin/program-health` carries
`depositor_count` (the same COUNT(DISTINCT)) and `firstDepositorsSince` —
these saturate Postgres under three concurrent dashboards. Their
materialization is NOT CO-20's recorded remedy and did not ride in; they are
the named follow-on candidates, each needing its own design review.

**CO-21 re-measurements at depth2 (EXPLAIN ANALYZE, recorded decisions all
stand):** `operatorPaymentTotalsFor` at the 300 k-payment skew: parallel seq
scan + partial hash aggregate, 94 ms — the rejected covering index stays
rejected; `validator_registry` seq scan 0.07 ms and `epoch_snapshots` index
scan 0.08 ms (structurally tiny, as recorded); deep OFFSET at 100 k: bitmap
index scan + external merge sort (12 MB), 127 ms — linear-by-construction, as
accepted.

**Rate-limit tuning (Q2, aggregate channel):** the shipped topology meters
the whole SSR tier as ONE limiter key (`TRUST_PROXY` off; web forwards no
client identity). Measured aggregate demand at the target concurrency of this
pass: ~55–60 rps ≈ 3 500 req/min — the production default (120/min) is a
devnet-safe floor, not a pilot ceiling. **Defaults stand**; the pilot
environment sizes `RATE_LIMIT_MAX` per D24 (recommended starting point:
7 200/60 s ≈ 2× the measured demand, revisited against the pilot's real
concurrency at 8.4). The fixed-window boundary burst (≤ 2× max straddling a
reset) is inherent to the algorithm and stands characterized; forwarding
client identity is 8.4 deployment-topology work, not tuning.

**Operational note found by the pass:** a reconciler's FIRST pass over a
large seeded history opens every point-in-time incident (15 k
`redemption_refund` rows at depth2) inside one Prisma transaction and blows
the 5 s interactive-transaction default. Harmless in production today (the
mirror grows incrementally from genesis), but a from-scratch backfill against
a long history would hit it — recorded for the reconciler's next pass, not
fixed here.
