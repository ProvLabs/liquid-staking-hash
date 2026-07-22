# E-CAL — Calendar-Month Epoch Alignment implementation (four commits)

**Status:** DRAFT 2026-07-22 (implementation plan for milestone E-CAL; reviewed
with Ira before implementation — three approach decisions locked in §"Decisions"
and the design step-back on configurable cadence resolved to ship calendar-month
only. Delivery shape per Ira: the four PRs land as **four commits on one
contracts branch** (`e-cal-calendar-month-epoch`), each staged for Ira to
commit.)
**Epic:** nvHASH Staking Contract —
[`docs/specs/liquid-staking-spec.md`](../specs/liquid-staking-spec.md) (v1.0, baselined)
**Milestone:** E-CAL — Calendar-month epoch alignment; design & PR table in the
[E-CAL design plan](2026-07-15-calendar-month-epoch-alignment.md) (§2 mechanism
fixed, §4 PR table).
**Companions:** [`contracts/IMPLEMENTATION-STATUS.md`](../../contracts/IMPLEMENTATION-STATUS.md) §2,
[`SECURITY.md`](../../SECURITY.md), [`app-spec.md`](../specs/app-spec.md) §14.12,
[`contracts/CLAUDE.md`](../../contracts/CLAUDE.md)

## Context

The App spec ([`app-spec.md`](../specs/app-spec.md) §14.12, DECIDED 2026-07-15)
says epochs align to **calendar-month boundaries computed from block time**, and
the App already *displays* that. The contract as built does not match:
`RunEpoch` is gated on `min_run_interval_secs` — a fixed-duration minimum since
`last_run` — so whoever cranks first after the interval sets the epoch time and
the boundaries drift relative to the calendar. Shipping the App against this
non-aligned contract is a spec/behavior mismatch
([`liquid-staking-spec.md`](../specs/liquid-staking-spec.md) §14 carries an
explicit **pending** note until this lands).

This milestone retires the interval gate outright and makes eligibility a
deterministic, caller-independent property of consensus block time. The model is
simply: **record the `(year, month)` of the last run, and allow the next run
only once block time is in a later `(year, month)`** — compared as a plain tuple:

> `RunEpoch` becomes eligible once `year_month(env.block.time) > year_month(last_run)`.

**Why any conversion at all:** the contract does not receive the block header's
RFC3339 date string (`"2026-07-22T20:59:37Z"`). CosmWasm hands execution
`env.block.time` as a `Timestamp` — **nanoseconds since the Unix epoch, nothing
else** (every access in the crate is `block.time.seconds()` or the raw
`Timestamp`; there is no date/`chrono`/`time` dependency). So getting the numeric
`(year, month)` the comparison needs requires a small on-chain integer conversion
of the nanosecond count. Enforcement must be on-chain and deterministic:
`RunEpoch` is permissionless, and `SECURITY.md` forbids gating a safety property
on who calls or on any off-chain-supplied value.

The mechanism is **fixed** by the [design plan](2026-07-15-calendar-month-epoch-alignment.md)
§2 — the one open call (§5, scheduling / launch-blocking) is answered by
scheduling it now. Because it is a contract behavior change, `SECURITY.md`'s
same-change rules bind: the predicate, the simulation input-domain + invariant
extension, and the spec text all move **together** in the first commit.

### Decisions (reviewed with Ira, 2026-07-22)
- **Commit workflow:** the four E-CAL steps are staged as four self-contained,
  commit-ready change-sets on `e-cal-calendar-month-epoch`; each carries a
  suggested message; **Ira runs every commit** (standing never-commit rule).
- **No-panic verification:** add `proptest` as a `[dev-dependencies]` entry and
  write a true property test for the year/month conversion (a reviewed
  dependency addition; pure-Rust, no install scripts, dev-only — not shipped in
  wasm).
- **Config field removal:** drop `min_run_interval_secs` from `Config` /
  `InstantiateMsg` / `UpdateConfig` with **fresh devnet instantiate**; no
  `migrate` entrypoint / `MigrateMsg` is added (pre-mainnet, disposable
  bootstrap-rebuilt devnet).
- **Cadence stays calendar-month only** (not configurable). The `month.rs` seam
  is kept clean so a future policy generalization (quarterly/annual/interval) is
  a localized change, but no cadence config, enum, or strategy is added now —
  that would require a separate accepted spec modification and carries knock-ons
  (withdrawal-delay redesign for non-monthly periods, App re-coupling) that
  aren't warranted without a concrete requirement.

### Testing acceleration — clock control, not a duration knob
Retiring `min_run_interval_secs` removes the old lever that let drills crank
epochs seconds apart (devnet set it to `0`). The predicate stays **pure
calendar** — no test-only "short month", interval override, or build-flag bypass
— so the shipped enforcement path is exactly what every layer tests (SECURITY.md
spec/code parity, "test the boundary as shipped"). Acceleration comes from the
**clock** at each layer:
- **Simulation** — synthetic `block_time_secs`; months/years advance instantly.
  Coverage *increases* (jitter, compressed gaps, skipped months, leap Feb).
- **Embedded chain (test-tube)** — `ProvwasmTestApp::increase_time(secs)`
  (provwasm-test-tube 0.5.0, `app.rs:93`) jumps the chain clock a month
  in-process. The authoritative, deterministic "two consecutive aligned epochs +
  early-crank-before-rollover rejected" assertions live here (Commit 1).
- **Live devnet** — the only wall-clock layer; the drill (Commit 2) crosses a
  boundary by setting `genesis_time` near a month-end, not by any contract knob.

## Commit map

Milestone **E-CAL**. `[P]` marks lanes independent of each other (authored in
either order); all four are committed sequentially on the one branch per Ira's
request. Maps to the design plan's E-CAL.1–.4 (§4).

| Commit | Scope | Depends on |
| --- | --- | --- |
| **1 · E-CAL.1** | The same-change unit: `month.rs` util (+ unit tests + proptest); `RunEpoch` predicate swap; fee-reserve horizon rederive; retire `min_run_interval_secs`; `cargo schema` regen; simulation calendar-time refactor + new invariants; spec amendments (§9, §9.3, §11.1, §14 pending→resolved). | app-spec §14.12 (decided) |
| **2 · E-CAL.2** `[P]` | Devnet drill: cross a month boundary (genesis pinned near month-end) — early pre-rollover crank asserted rejected, post-rollover aligned epoch runs. | Commit 1 |
| **3 · E-CAL.3** `[P]` | Params/ops: re-pin `withdrawal_delay_seconds` against the calendar cadence + live `unbonding_time`; keeper runbook entry; launch-checklist rows. | Commit 1 |
| **4 · E-CAL.4** | Close: check off `IMPLEMENTATION-STATUS.md` §2; flip app-spec §14.12 to implemented; revisit the App "monthly settlement" copy caveat. | Commits 2–3 |

---

## Commit 1 — E-CAL.1 (predicate + sim + spec, one unit)

### 1a. Year/month module — `contracts/src/month.rs` (new; `mod month;` in `lib.rs`)
Small, dependency-free, shared by production and the sim so the predicate agrees
bit-for-bit. The whole thing is one conversion plus a nominal constant — the
comparison itself is a plain tuple `>` at the call site, no packed key needed.

```rust
use cosmwasm_std::Timestamp;

/// Nominal epoch length feeding the AUM fee-reserve horizon now that
/// min_run_interval_secs is retired (~30 days).
pub const NOMINAL_EPOCH_SECS: u64 = 2_592_000;

/// The calendar (year, month) of a block time. Total for any Timestamp.
/// Eligibility is simply `year_month(now) > year_month(last_run)` (tuple order:
/// a later year, or the same year and a later month).
pub fn year_month(t: Timestamp) -> (i32, u32) {
    let (y, m, _) = ymd_from_days((t.seconds() / 86_400) as i64);
    (y, m)
}

/// First Unix second of the month after `t`'s month — the first eligible
/// instant, used for the `TooSoon { next }` payload (and the sim jitter base).
pub fn first_of_next_month_secs(t: Timestamp) -> u64;

/// Days-since-epoch → (year, month, day). Standard days-from-civil integer
/// algorithm (era/doe/yoe/doy/mp steps): exact, no floats, no leap-year
/// special-casing at the call site, total & panic-free for all i64 day inputs
/// (u64::MAX/86_400 ≈ 2.1e14 fits i64).
fn ymd_from_days(z: i64) -> (i32 /*y*/, u32 /*m*/, u32 /*d*/);
```

- **Unit tests:** month lengths, leap years incl. the 2000 (leap) / 2100
  (non-leap) century rule, December→January year rollover, and the
  strictly-later comparison at boundaries.
- **Proptest:** `year_month` / `ymd_from_days` never panic across the full `u64`
  nanosecond domain (add `proptest` to `[dev-dependencies]`).

### 1b. Production predicate swap — `contracts/src/epoch.rs`
- Replace the interval gate at `epoch.rs:454-457` with the rollover predicate.
  `epoch.last_run` stays a `Timestamp` (single source of truth, already exposed
  via the EpochStatus query); its month is derived at compare time — no new state
  field:
  ```rust
  if month::year_month(env.block.time) <= month::year_month(epoch.last_run) {
      return Err(ContractError::TooSoon { next });
  }
  ```
  `next` (`error.rs:19`) now carries the **first eligible instant** —
  `month::first_of_next_month_secs(epoch.last_run)`. The continuation-crank
  bypass above it (`epoch.rs:445-449`) and both `last_run = env.block.time`
  writes (`epoch.rs:876`, `:965`) are unchanged.
- **Second consumer (not in the design plan — must be handled):** the fee-reserve
  horizon at `epoch.rs:536` reads `cfg.min_run_interval_secs.saturating_mul(2)`.
  Rederive it from the nominal constant: `let horizon = 2 * month::NOMINAL_EPOCH_SECS;`.
  `fee_reserve` itself (`plan.rs:147`) is already seconds-based — no change.

### 1c. Retire `min_run_interval_secs`
Drop the field and every reference (fresh-instantiate, no migrate):
- `state.rs:16-18` (`Config`) — remove field; `Config::validate` (`state.rs:60`)
  unaffected (it never validated the field).
- `msg.rs:10-11` (`InstantiateMsg`), `msg.rs:42-54` (`UpdateConfig` variant),
  `msg.rs:156` (`ConfigResponse`).
- `contract.rs:51` (instantiate set), `contract.rs:331-333` (`exec_update_config`
  merge), `contract.rs:150` (query echo).
- Regenerate `schema/nvhash-staking.json` via `cargo schema`.
- **Devnet bootstrap (same commit — else the deploy sends a dropped field):**
  remove `MIN_RUN_INTERVAL_SECS` (`infra/devnet/bootstrap/nvhash-deploy-p2p.sh:53`)
  and the `min_run_interval_secs` key from the instantiate JSON (`:233`).
- **Test updates:** the unit gate test `run_epoch_rejects_before_min_interval_elapsed`
  (`contract.rs:1341`) and `UpdateConfig` round-trip (`contract.rs:628`) drop the
  field; `epoch.rs` `sequence_tests` setup (`epoch.rs:1082`) and the test-tube
  setup (`tests.rs:199`, `min_run_interval_secs: 0`) drop it too. The
  embedded-chain gate test `run_epoch_enforces_min_interval_...` (`tests.rs:625`)
  is rewritten as the **authoritative calendar coverage**: run epoch 1; attempt a
  second crank same month and assert `TooSoon`; `app.increase_time(~32 days)` to
  cross the boundary; assert epoch 2 now runs — deterministic, instant, no
  wall-clock wait.

### 1d. Simulation calendar-time refactor — `contracts/src/sim.rs`
Today time is a pure `step` counter (`sim.rs:192,931-933`) with fixed
4-steps-per-epoch and 3-step locks, so unbonding always matures before the next
crank and the planner's defensive guards **never bite**. Introduce a real clock:

- **Explicit clock:** add `block_time_secs: u64` (genesis pinned to a month
  boundary per scenario) advanced each `run_step` by a seeded per-step delta;
  keep `step` only as an event/RNG-cadence counter and failure label.
- **Crank gate** (replace `sim.rs:931-933`): fire when
  `month::year_month(block_time) > month::year_month(last_run)` **and** a
  per-epoch keeper-promptness draw (`month_start + delay_days`) is reached. Small
  delay → prompt; large → weeks-late; delay past the next boundary →
  skipped-month catch-up; late-then-prompt across a boundary → compressed gap
  below unbonding.
- **Separate timing RNG** `time_rng = Rng::new(sc.seed ^ TIMING_SALT)` (mirrors
  the event-RNG fork at `sim.rs:279`) so existing economic scenarios' draw
  streams stay byte-identical and no spurious violations appear.
- **Seconds constants** replacing the step-unit ones (`sim.rs:192-195`):
  `month::NOMINAL_EPOCH_SECS` (shared), `UNBOND_SECS`/`REDELEGATION_LOCK_SECS`
  (~21d), `REDEMPTION_DELAY_SECS` (2×nominal), per-step delta range, keeper-jitter
  max, `WITHDRAWAL_DELAY_CEILING_SECS` (60d).
- **Rederive step-fixed quantities to elapsed seconds:** AUM fee skim
  (`sim.rs:921-928`) and reward accrual (`sim.rs:795-800`) → `× step_delta /
  YEAR_SECONDS` (resp. `/ NOMINAL_EPOCH_SECS`); fee-reserve horizon
  (`sim.rs:544-550`) → `2 * NOMINAL_EPOCH_SECS`; convert all lock/maturity/jail
  deadlines (`sim.rs:337,356,388,413,467,610,613,668,820,824-831,887-904`) from
  `step` to `block_time_secs`. **Guard:** grep `self.step` after migration — every
  remaining use must be a pure counter, else compressed-gap coverage silently
  disappears.
- **Run loop by crank count** (`run_scenario` `sim.rs:944`, smoke asserts
  `sim.rs:990,1007`): loop until `sc.epochs` cranks fire (steps-per-epoch is now
  variable), with a max-step safety cap.

### 1e. New / changed invariant assertions (design plan §3 gates)
- **Never-rejected-move under compression (§3.2):** strengthen `apply_unbond`
  (`sim.rs:461-468`) to assert the target isn't `at_capacity()`; the existing
  redelegation / deploy-budget never-rejected checks (`sim.rs:645-694`) now run
  against a genuinely non-empty in-flight set. Add `min_run_gap_secs` to `Stats`;
  the compressed-gap scenario asserts it dropped below `UNBOND_SECS`.
- **Settlement-correctness across a skipped month (§3.5):** the
  `settle + write_down == matured` identity (`sim.rs:581`) + receipt conservation
  (`sim.rs:728`) already hold; add `max_catchup_secs` and a scenario asserting a
  month was skipped (`>= ~2×NOMINAL_EPOCH_SECS`) with zero violations.
- **Mobilization vs 60-day ceiling (§3.4, sim side):** add `requested_at_secs` to
  `Redemption`; at each payout site (`sim.rs:493,705,905`) check
  `block_time − requested_at ≤ WITHDRAWAL_DELAY_CEILING_SECS`; fold into
  `max_mobilization_secs`. (The launch-checklist *assertion* side is Commit 3.)
- Per-crank TVV/NAV identities (`sim.rs:718-746`) need no change — skim/accrual
  happen between cranks, outside `run_epoch`.

### 1f. New calendar scenarios + third smoke test
Add `calendar_scenarios()` (mirroring `boundary_scenarios`) with three edges —
`calendar-compressed-gap`, `calendar-skipped-month`, `calendar-leap-february` —
and a `simulation_calendar_domain_zero_violations` `#[test]` beside the two
existing smoke tests (`sim.rs:977-1038`), each asserting zero violations **and**
its exercise metric (anti-rot discipline). Boundary scenarios keep a single
default timing profile — no timing axis (orthogonal, avoids combinatorial
blow-up).

### 1g. Spec amendments — `docs/specs/liquid-staking-spec.md` (same change)
- §9 cadence (`:220`) and §9.3 lock-clearing rationale (`:248`, `:252`): rewrite
  fixed-interval "monthly" → calendar-month rollover; note the compressed-gap
  case is safe by the §9.3 plan-time deferral guards.
- §11.1 `config` list (`:429`): remove `min_run_interval_secs` and its
  "(calendar-month alignment pending — §14 note)" annotation.
- §14 pending note (`:543`): flip "scheduled, not implemented" → resolved and
  fold into the numbered resolution record with today's date.

**Suggested commit message:** `E-CAL.1: calendar-month RunEpoch predicate, year/month util, sim domain + spec`

---

## Commit 2 — E-CAL.2 `[P]` (devnet drill)
New `contracts/drills/calendar-drill.sh` alongside `p2p-drill.sh` /
`jail-drill.sh`, following their pattern (phase assertions against live
vault/marker state; runs against the `infra/devnet/` chain). Because the live
chain's clock is wall-clock and the old `MIN_RUN_INTERVAL_SECS=0` lever is gone,
the drill crosses the boundary via the **chain clock, not a contract knob**: boot
the disposable devnet with `genesis_time` set just before a month-end (patched in
`dev-node.sh`, which already edits genesis). Phases: run epoch 1; attempt a second
crank before the rollover and assert it is **rejected** (`TooSoon`); after the
short real interval the natural rollover lands; run the now-aligned epoch and
assert alignment. (A multi-boundary variant via an accelerated fake node clock,
e.g. libfaketime, is possible but deferred — the authoritative multi-epoch
coverage is the deterministic test-tube path in Commit 1; this drill proves the
real predicate on a live chain across one boundary.) Add a bullet to
`drills/README.md`.

**Suggested commit message:** `E-CAL.2: calendar-alignment devnet drill`

---

## Commit 3 — E-CAL.3 `[P]` (params / ops)
- **Re-pin `withdrawal_delay_seconds`** against the calendar cadence + live
  `unbonding_time`: worst case is now the full remainder of a 31-day month to the
  next eligibility + crank lag + ~21-day unbonding + buffer, which must stay ≤ 60
  days. Update `liquid-staking-spec.md` §7 row (`:171`), §8 sizing (`:70`, `:96`),
  and the §14 launch-checklist row (`:548`) — the launch-checklist assertion side
  of design plan §3.4 (the sim bound is in Commit 1).
- **Keeper runbook:** create `docs/user/keeper-runbook.md` (dir is currently
  empty `.gitkeep`) with the standing entry: **crank `RunEpoch` promptly after
  each month rollover** (promptness is a liveness concern; a late crank compresses
  the gap and degrades convergence but never correctness).

**Suggested commit message:** `E-CAL.3: re-pin withdrawal_delay ceiling; keeper runbook`

---

## Commit 4 — E-CAL.4 (close)
- `contracts/IMPLEMENTATION-STATUS.md` §2 (`:85-105`): check off the
  calendar-month entry; record verification (soak seed/date) per SECURITY.md.
- `docs/specs/app-spec.md` §14.12 (`:642`): flip "not implemented in this change…
  only once that ships" → implemented.
- `docs/specs/app-spec.md` (`:373-374`): resolve the "monthly settlement" copy
  caveat (the contract now genuinely aligns to calendar months).

**Suggested commit message:** `E-CAL.4: close calendar-month alignment (status ledger + app-spec)`

---

## Verification

Run from `contracts/` (per [`contracts/CLAUDE.md`](../../contracts/CLAUDE.md);
prefix `GOTOOLCHAIN=go1.24.5` on Go ≥ 1.26 hosts):

1. **Year/month correctness & totality** — `cargo test --lib month` (unit +
   proptest: leap/century, year rollover, `u64` no-panic sweep).
2. **Predicate & config** — `cargo test --lib` covers the rewritten unit gate
   test, `UpdateConfig` round-trip (field gone), epoch sequence tests, and the
   embedded-chain calendar test that crosses a month boundary via
   `app.increase_time(...)` (epoch 1 → same-month crank `TooSoon` → advance →
   epoch 2 aligned). Rebuild the wasm artifact for test-tube
   (`scripts/build-artifact.sh`, Docker) since `run_epoch` changed.
3. **Schema parity** — `cargo schema`; confirm `schema/nvhash-staking.json`
   dropped `min_run_interval_secs` and the diff is committed.
4. **Simulation** — `cargo test --lib` runs the three smoke tests (existing two +
   `simulation_calendar_domain_zero_violations`). Then a soak:
   `cargo run --release --bin simulate -- --scenarios 2000` — expect zero
   violations; reproduce any failure with `--seed <s> --scenarios 1`. Confirm the
   calendar scenarios actually exercised compressed-gap / skipped-month /
   leap-February (exercise metrics non-trivial).
5. **Devnet drill (Commit 2)** — stand up `infra/devnet/` with `genesis_time`
   near a month-end, run `drills/calendar-drill.sh`; the pre-rollover crank is
   rejected and the post-rollover aligned epoch passes on the live chain.
6. **Docs parity** — grep `liquid-staking-spec.md` / `app-spec.md` /
   `IMPLEMENTATION-STATUS.md` for residual "min_run_interval" / "pending" /
   "monthly cadence" cadence claims; none should remain after Commit 4.

Note: contracts currently have **no automated CI** (`.github/workflows/` runs
only pnpm/apps/services). The "CI smoke run" the design plan references is the
`cargo test --lib` smoke set above; wiring a contracts GitHub Actions job is a
separate, out-of-scope gap.
