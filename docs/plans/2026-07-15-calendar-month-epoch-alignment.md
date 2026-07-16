# Calendar-Month Epoch Alignment — Contract Follow-On

**Status:** DRAFT 2026-07-15 (contract follow-on to the app-spec §14.12
decision; the mechanism in §2 is fixed — the one remaining call is scheduling,
§5).
**Epic:** nvHASH Staking Contract —
[`docs/specs/liquid-staking-spec.md`](../specs/liquid-staking-spec.md) (v1.0, baselined)
**Companions:** [`contracts/IMPLEMENTATION-STATUS.md`](../../contracts/IMPLEMENTATION-STATUS.md),
[`SECURITY.md`](../../SECURITY.md), [`app-spec.md`](../specs/app-spec.md) §14.12,
[`contracts/CLAUDE.md`](../../contracts/CLAUDE.md)

## 1. Origin & problem statement

The App spec's §14.12 decision (2026-07-15, Ira) records that epochs align to
calendar-month boundaries computed from block time. The contract as built gates
`RunEpoch` on `min_run_interval_secs (≈ monthly)` — a fixed-duration minimum
since `last_run` — so whoever cranks first after the interval sets the epoch
time and the boundaries drift relative to the calendar.

Two facts scope this change correctly:

- **The gate is an eligibility floor, not a trigger.** The contract cannot run
  itself. An epoch ends (and the next begins) when an unauthenticated caller
  cranks `RunEpoch` at or after eligibility. Epoch durations were therefore
  **always variable** — this change introduces no new variability; it redefines
  the floor so the earliest-valid moment is calendar-deterministic instead of
  drifting with crank history.
- **It is a contract behavior change**, so `SECURITY.md`'s same-change rules
  apply: the simulation domain, per-epoch invariant assertions, and spec text
  move in the same change as the predicate.

Until this lands, `liquid-staking-spec.md` §14 carries an explicit **pending**
note and the App's "calendar month" copy matches the contract only once it
ships.

## 2. The mechanism (fixed)

**Time source (non-negotiable).** The month is computed from
**`env.block.time`** — the BFT **consensus timestamp**, the only deterministic
clock available to contract execution. It is expressed in Unix-epoch
(UTC-based) time, but its authority is **consensus agreement**, never a node's
wall clock or an external UTC source; the civil `(year, month)` is a pure
deterministic function of it.

**Predicate.** `RunEpoch` becomes eligible once

> `civil_month(env.block.time) > civil_month(last_run)`

— block time has rolled into a later calendar month than the last run —
replacing the interval gate outright.

- **Gates validity, not execution.** This is the minimum point at which ending
  the epoch becomes valid; the run itself happens whenever a caller cranks.
  Keeper promptness after rollover is a liveness concern, exactly as today.
- **Deterministic, caller-independent boundary.** No caller — keeper or third
  party — can crank early or choose the epoch's duration; the boundary is a
  property of consensus block time, not of who calls (SECURITY: never gate a
  safety property on who calls). A keeper-scheduled interval floor was
  considered and rejected for exactly this reason: it would hand crank callers
  control over epoch duration through a permissionless entrypoint.
- **`min_run_interval_secs` is retired, not repurposed.** An interval-seconds
  gate is a categorically different gating method and does not compose with a
  month-rollover predicate. No residual guard is needed: immediately after a
  run, `civil_month(last_run)` equals the current month, so the predicate
  itself rejects any further run until the next rollover — double-run is
  structurally impossible.

Cost: a bounded, checked civil-time conversion (block-time nanoseconds →
`(year, month)` via the days-from-civil algorithm, no external calendar crate)
and the verification surface in §3.

## 3. Security & invariant impact (enforced mechanisms with gating tests)

1. **Bounded, checked civil-time conversion of block time.** The conversion to
   `(year, month)` is overflow-checked and total (no panic on any `u64`
   nanosecond value); determinism is inherited from consensus block time.
   *Gate:* unit tests across month lengths, leap years (incl. the 2000/2100
   century rule), and year rollover; a proptest that the conversion never
   panics on the full `u64` domain.
2. **Run spacing vs the unbonding lock.** Nominal spacing is 28–31 days when
   cranks land promptly after rollover, clearing the ~21-day unbonding as
   today. But because the crank is permissionless and only floored, a **late**
   run (e.g. the last day of a month) followed by a prompt run after the next
   rollover **compresses the gap below the unbonding period**. This is safe by
   the existing plan-time defensive guards (spec §9.3): the planner reads live
   redelegations, pins validators with in-flight inbound entries, and routes
   around entry-capacity pairs — deferring moves rather than emitting one the
   chain would reject. A compressed gap degrades that epoch's convergence
   (more deferrals), never correctness. *Gate:* the simulation asserts the
   never-rejected-move invariant explicitly across compressed-gap sequences.
3. **Simulation domain extension (same change as the predicate swap).** Model
   crank time as eligibility + jitter (prompt through weeks late), across all
   month lengths (incl. February/leap), skipped-month catch-up, and
   compressed-gap sequences; extend the per-epoch invariant assertions
   alongside. *Gate:* seed-reproducible soak with the new dimension in the CI
   smoke run.
4. **`withdrawal_delay_seconds` (60-day ceiling) re-pin.** Worst-case
   mobilization is now: the full remainder of a 31-day month until the next
   eligibility, plus crank lag, plus ~21-day unbonding, plus buffer — must stay
   ≤ 60 days, on the same keeper-liveness assumption as today. *Gate:* a
   launch-checklist assertion and a simulation bound on observed mobilization
   time vs the ceiling.
5. **Skipped-month catch-up.** The strict month comparison means a month with
   no crank simply extends eligibility; one run settles the whole gap, and a
   longer gap is *safer* for lock-clearing. *Gate:* a settlement-correctness
   test across a skipped month.

## 4. Milestones & PRs

Milestone **E-CAL**. `SECURITY.md`'s same-change rule shapes PR 1: predicate,
simulation extension, and spec amendment travel together. **[P]** marks
parallel lanes.

| PR | Scope | Depends on |
| --- | --- | --- |
| E-CAL.1 | **Build & verify (the same-change unit):** civil-time util with unit + proptest suite; `RunEpoch` predicate swap; retire `min_run_interval_secs` (config, migration/`UpdateConfig` surface, `cargo schema` regen); simulation-domain + invariant extension (§3.2–3.5); amend `liquid-staking-spec.md` (§9 cadence text, config list, §14 pending → resolved). | app-spec §14.12 (decided) |
| E-CAL.2 [P] | **Devnet drill:** two consecutive calendar-aligned epochs, including an early-crank attempt before rollover asserted rejected; repeatable script alongside `p2p-drill.sh`. | E-CAL.1 |
| E-CAL.3 [P] | **Params/ops:** re-pin `withdrawal_delay_seconds` against the calendar cadence + live `unbonding_time`; keeper runbook entry (crank promptly after each rollover); launch-checklist rows. | E-CAL.1 |
| E-CAL.4 | **Close:** check off the `IMPLEMENTATION-STATUS.md` §2 entry; flip app-spec §14.12 from "pending contract amendment" to implemented. | E-CAL.2–3 |

## 5. Open question

**Is this v1-launch-blocking or a v1.x refinement?** The App now *displays*
calendar alignment, so shipping the App against a non-aligned contract would be
a spec/behavior mismatch — argues for launch-blocking. Confirm when scheduling
E-CAL.1.
