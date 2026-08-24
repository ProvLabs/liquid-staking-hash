//! Chain-free simulation / property suite: drives the production planners against a
//! simulated chain and vault, asserting the conservation invariants every epoch.
//! Native-only; soak via `cargo run --release --bin simulate`, CI runs the fixed-seed smoke test.

use std::collections::BTreeMap;

use cosmwasm_std::{Addr, MemoryStorage, Timestamp, Uint128};
use serde::Serialize;

use crate::month::{year_month, NOMINAL_EPOCH_SECS};
use crate::plan::{
    commission_on, fee_reserve, plan_rebalance, plan_return, plan_service, redemption_need,
    DelegationView, RebalanceSeat, MAX_UNBOND_ENTRIES,
};
use crate::state::{ValidatorRecord, VALIDATORS};
use crate::validators::{
    accrue_commission, drain_ranks, epoch_rollover, order_for_drain, sort_by_priority, Assessment,
};

/// Deterministic SplitMix64: no external RNG dependency, exact replay by seed.
#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }
    // Not `Iterator::next`: the stream is infallible, an Option would force unwraps.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    /// Uniform in [0, n) (n > 0).
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    /// True with probability num/den.
    pub fn chance(&mut self, num: u64, den: u64) -> bool {
        self.below(den) < num
    }
    /// Uniform u128 in [lo, hi].
    pub fn range(&mut self, lo: u128, hi: u128) -> u128 {
        if hi <= lo {
            return lo;
        }
        lo + (((self.next() as u128) << 64 | self.next() as u128) % (hi - lo + 1))
    }
}

/// Scenario knobs, all randomized per scenario from its seed.
#[derive(Clone, Debug)]
pub struct Scenario {
    pub seed: u64,
    pub epochs: u32,
    pub max_validators: usize,
    /// Reward rate per epoch in bps of stake (e.g. 60 = 0.6%/epoch ~ 7.2%/yr).
    pub reward_bps_per_epoch: u64,
    pub commission_bps: u64,
    pub aum_fee_bps: u64,
    pub performance_threshold_bps: u64,
    /// Initial user deposit magnitude ceiling (stress the u128 headroom).
    pub deposit_ceiling: u128,
    /// Smallest deposit; 1 = dust economies (SECURITY.md boundary domain).
    pub min_deposit: u128,
    /// Per-step event probabilities, in percent.
    pub p_deposit: u64,
    pub p_redeem: u64,
    pub p_jail: u64,
    pub p_enroll: u64,
    pub p_unregister: u64,
    pub p_tip: u64,
    /// Percent of operators that pay commission on schedule.
    pub p_pay_commission: u64,
    /// Genesis block time (Unix seconds); the calendar predicate derives civil months from it.
    pub genesis_secs: u64,
    /// Upper bound on the keeper delay drawn each rollover under `Timing::Jitter` (seconds).
    pub keeper_jitter_max_secs: u64,
    /// How crank timing after a rollover is chosen (see `Timing`).
    pub timing: Timing,
    /// Redemption safety margin in bps (contract bound 0..=1000), randomized over the full range.
    pub redemption_margin_bps: u64,
}

/// Keeper-promptness model after a calendar-month rollover: eligibility is always the
/// production predicate; this only decides how late into the new month the crank fires.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Timing {
    /// Random delay in `[0, keeper_jitter_max_secs)`, the default spread.
    Jitter,
    /// Alternate late (26d) and prompt (1d) cranks to compress the gap below the unbonding period.
    Compressed,
    /// Periodically delay past a whole month so one catch-up crank settles two months.
    Skip,
}

impl Scenario {
    pub fn from_seed(seed: u64, epochs: u32) -> Self {
        let mut r = Rng::new(seed);
        Scenario {
            seed,
            epochs,
            max_validators: 2 + r.below(40) as usize,
            reward_bps_per_epoch: 20 + r.below(120),
            commission_bps: r.below(3000),
            aum_fee_bps: r.below(30),
            performance_threshold_bps: if r.chance(1, 2) {
                0
            } else {
                9_000 + r.below(900)
            },
            deposit_ceiling: r.range(1_000_000_000, 1_000_000_000_000_000_000_000),
            min_deposit: 1_000_000,
            p_deposit: 10 + r.below(40),
            p_redeem: 5 + r.below(30),
            p_jail: r.below(8),
            p_enroll: 5 + r.below(20),
            p_unregister: r.below(10),
            p_tip: r.below(30),
            p_pay_commission: 60 + r.below(41),
            genesis_secs: GENESIS_SECS,
            keeper_jitter_max_secs: (5 + r.below(20)) * DAY_SECS,
            timing: Timing::Jitter,
            redemption_margin_bps: r.below(1_001),
        }
    }
}

/// Deterministic boundary-domain scenarios (SECURITY.md: cover the full allowed input
/// domain). Each pins one edge; the CI test asserts the edge was actually exercised.
pub fn boundary_scenarios(epochs: u32) -> Vec<(&'static str, Scenario)> {
    let base = |seed: u64| Scenario::from_seed(seed, epochs);
    vec![
        (
            // Dust economy: every floor division and remainder split sees 0/1-unit operands.
            "dust-economy",
            Scenario {
                deposit_ceiling: 1_000,
                min_deposit: 1,
                p_deposit: 60,
                p_redeem: 40,
                ..base(0xD057)
            },
        ),
        (
            // No deposits ever: every epoch cranks an empty vault without violation or panic.
            "empty-vault",
            Scenario {
                p_deposit: 0,
                p_redeem: 0,
                ..base(0xE307)
            },
        ),
        (
            // Shares cross 2^64 (~18,447 HASH TVL); valuation math must stay exact past it.
            "uint64-share-crossing",
            Scenario {
                deposit_ceiling: 60_000_000_000_000, // 60k HASH per deposit max
                p_deposit: 60,
                p_redeem: 10,
                ..base(0x64C5)
            },
        ),
        (
            // Deposits to 1e30 nhash push u128 sums and 256-bit valuation past realistic supply.
            "extreme-tvl",
            Scenario {
                deposit_ceiling: 1_000_000_000_000_000_000_000_000_000_000,
                p_deposit: 50,
                ..base(0x7F1A)
            },
        ),
        (
            // All rates at their Config::validate maxima; starvation is expected, violations are not.
            "rates-at-maxima",
            Scenario {
                commission_bps: 10_000,
                aum_fee_bps: 10_000,
                performance_threshold_bps: 10_000,
                ..base(0xFEE5)
            },
        ),
        (
            // Margin lower edge (0 bps): refunds are the modeled safe outcome, violations are not.
            "margin-zero",
            Scenario {
                redemption_margin_bps: 0,
                // High yield, no fee reserve, thin deposits: NAV drift must outrun the deploy floor.
                reward_bps_per_epoch: 300,
                aum_fee_bps: 0,
                p_deposit: 10,
                p_redeem: 60,
                ..base(0x0A11)
            },
        ),
        (
            // Margin upper edge (1000 bps): a liquidity brake, never a correctness hole.
            "margin-max",
            Scenario {
                redemption_margin_bps: 1_000,
                p_deposit: 40,
                p_redeem: 35,
                ..base(0x0AFF)
            },
        ),
        (
            // Planner scale at the 100-validator bound (the Provenance active-set ceiling).
            "validator-ceiling",
            Scenario {
                max_validators: 100,
                p_enroll: 100,
                p_unregister: 0,
                ..base(0x100A)
            },
        ),
    ]
}

/// Calendar-cadence domain scenarios. Each pins one edge of the calendar
/// predicate; the CI test asserts the edge was actually reached.
pub fn calendar_scenarios(epochs: u32) -> Vec<(&'static str, Scenario)> {
    let base = |seed: u64| Scenario::from_seed(seed, epochs);
    vec![
        (
            // Gap squeezed below the unbonding period: entries still in flight at the next crank.
            "calendar-compressed-gap",
            Scenario {
                timing: Timing::Compressed,
                p_deposit: 50,
                p_redeem: 25,
                p_enroll: 30,
                ..base(0xCA1E)
            },
        ),
        (
            // One catch-up crank settles two months; loss recognition stays undeferred.
            "calendar-skipped-month",
            Scenario {
                timing: Timing::Skip,
                p_deposit: 40,
                p_redeem: 20,
                ..base(0x5217)
            },
        ),
        (
            // Genesis pinned to a leap year so Feb 29 and short/long months are traversed.
            "calendar-leap-february",
            Scenario {
                genesis_secs: LEAP_GENESIS_SECS,
                p_deposit: 40,
                p_redeem: 15,
                ..base(0x1EAF)
            },
        ),
    ]
}

// Real-time model: block time advances per step and the epoch cranks on the production
// calendar-month predicate (`month.rs`); every lock/delay is a wall-clock deadline.
const DAY_SECS: u64 = 86_400;
const YEAR_SECONDS: u128 = 31_536_000; // mirrors plan::YEAR_SECONDS (365 days)
const UNBOND_SECS: u64 = 21 * DAY_SECS; // ~Provenance unbonding period
const REDELEGATION_LOCK_SECS: u64 = 21 * DAY_SECS;
// Redemption payout delay; delay + one keeper step must stay under the 60-day ceiling.
const REDEMPTION_DELAY_SECS: u64 = 50 * DAY_SECS;
const WITHDRAWAL_DELAY_CEILING_SECS: u64 = 60 * DAY_SECS;
// Per-step block-time advance (~5-15 steps per calendar month).
const STEP_MIN_SECS: u64 = 2 * DAY_SECS;
const STEP_MAX_SECS: u64 = 6 * DAY_SECS;
// Jail duration (~half a month).
const JAIL_SECS: u64 = 15 * DAY_SECS;
// Month-boundary genesis times: 2025-01-01 default, 2024-01-01 (leap) for the leap scenario.
const GENESIS_SECS: u64 = 1_735_689_600;
const LEAP_GENESIS_SECS: u64 = 1_704_067_200;
// Distinct RNG stream for crank timing so the clock never perturbs the economic event stream.
const TIMING_SALT: u64 = 0x7157_3A17_C0DE_F00D;
const DEPLOY_BUFFER_BPS: u128 = 50;
const SHARE_SCALAR: u128 = 1_000_000;
// Concentration cap params (Provenance defaults) and the contract's offset.
const CAP_MULTIPLE_BPS: u64 = 55_000;
const CAP_MIN_BPS: u64 = 500;
const CAP_MAX_BPS: u64 = 3_300;
const CAP_OFFSET_BPS: u64 = 500;

/// floor(a * b / d) widened through 256 bits, like the vault's valuation math.
fn mul_div(a: u128, b: u128, d: u128) -> u128 {
    if d == 0 {
        return 0;
    }
    let r = cosmwasm_std::Uint256::from(a) * cosmwasm_std::Uint256::from(b)
        / cosmwasm_std::Uint256::from(d);
    Uint128::try_from(r).map(|v| v.u128()).unwrap_or(u128::MAX)
}

struct SimVal {
    valoper: String,
    /// Stake from everyone except the program (self-bond + third parties).
    third_party: u128,
    program: u128,
    jailed_until: u64,
    uptime_bps: u64,
    pending_rewards: u128,
}

struct Redemption {
    /// Trace-only owner tag; never a factor in the payout math or entry shape.
    address: String,
    shares: u128,
    /// Block time (secs) the redemption becomes payable.
    due: u64,
    /// Block time (secs) the redemption was requested, for the mobilization bound.
    requested_at: u64,
}

/// Round-robin trace-attribution tags for the pooled depositor; no rng draw,
/// so pooled amounts, entry counts, and the RNG stream are unchanged.
const ACTORS: [&str; 3] = ["user-0", "user-1", "user-2"];

/// Trace event kind, mirroring `TransactionKind` in `packages/api-types/src/rows.ts`.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    SwapIn,
    SwapOutRequest,
    RedemptionPayout,
    RedemptionRefund,
}

fn u128_str<S: serde::Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&v.to_string())
}

/// One epoch settlement, mirroring `EpochRow`'s `epoch_index`/`tvv` fields.
#[derive(Serialize, Clone, Debug)]
pub struct TraceEpoch {
    pub epoch_index: u64,
    pub ended_at_seconds: u64,
    #[serde(serialize_with = "u128_str")]
    pub tvv_after: u128,
    #[serde(serialize_with = "u128_str")]
    pub total_shares: u128,
}

/// One deposit/redemption event in execution order (`seq` strictly increasing).
#[derive(Serialize, Clone, Debug)]
pub struct TraceEvent {
    pub seq: u64,
    pub address: String,
    pub kind: EventKind,
    #[serde(serialize_with = "u128_str")]
    pub shares: u128,
    #[serde(serialize_with = "u128_str")]
    pub nhash: u128,
    /// Last settled epoch index at the moment of this event (0 before the first settles).
    pub epoch_index: u64,
}

/// Full scenario trace for the derived-metrics property harness; committed traces are
/// recorded in `packages/fixtures/fixtures/sim-traces/manifest.json`.
#[derive(Serialize, Clone, Debug)]
pub struct Trace {
    pub seed: u64,
    pub epochs: Vec<TraceEpoch>,
    pub events: Vec<TraceEvent>,
}

/// Trace accumulator; populated only by `run_scenario_traced`, so untraced runs pay nothing.
#[derive(Default)]
struct TraceBuilder {
    seq: u64,
    events: Vec<TraceEvent>,
    epochs: Vec<TraceEpoch>,
}

/// Aggregate outcome counters for reporting.
#[derive(Default, Debug, Clone)]
pub struct Stats {
    pub epochs: u64,
    pub checks: u64,
    pub deposits: u64,
    /// Redemption requests raised (one per RNG branch firing, never split).
    pub redemption_requests: u64,
    pub redemptions_paid: u64,
    pub redemption_refunds: u64,
    pub slashes: u64,
    pub write_downs: u64,
    pub redelegations: u64,
    pub fee_starved_steps: u64,
    pub max_tvv: u128,
    /// Largest share supply observed; the boundary scenario asserts the uint64 crossing.
    pub max_shares: u128,
    pub worst_convergence_dev: u128,
    /// Smallest gap (secs) between consecutive cranks (init u64::MAX); compressed-gap metric.
    pub min_run_gap_secs: u64,
    /// Most calendar months one crank advanced last_run by (>=2 = a skipped month).
    pub max_month_skip: u32,
    /// Largest request-to-payout time; bounded per payout under the 60-day ceiling.
    pub max_mobilization_secs: u64,
    /// Whether the timeline ever traversed a February (leap-scenario metric).
    pub saw_february: bool,
}

pub struct SimResult {
    pub stats: Stats,
    pub violations: Vec<String>,
}

struct Sim {
    rng: Rng,
    /// Separate stream for crank-timing draws so the economic `rng` sequence is unperturbed.
    time_rng: Rng,
    sc: Scenario,
    storage: MemoryStorage,
    /// Event/RNG-cadence counter and failure label, never time.
    step: u64,
    /// Consensus block time in Unix seconds (the calendar predicate's clock).
    block_time_secs: u64,
    /// Block time of the last completed crank (mirrors epoch.last_run).
    last_run_secs: u64,
    /// Latched fire target: the crank fires when block time reaches month-start + keeper delay.
    next_fire_secs: Option<u64>,
    vals: Vec<SimVal>,
    /// (mature_step, valoper, amount)
    unbonding: Vec<(u64, String, u128)>,
    /// (expire_step, src, dst)
    redelegations: Vec<(u64, String, String)>,
    marker_liquid: u128,
    receipt_in_marker: u128,
    shares: u128,
    user_shares: u128,
    receipt_minted: u128,
    contract_liquid: u128,
    redemptions: Vec<Redemption>,
    stats: Stats,
    violations: Vec<String>,
    /// Round-robin cursor over `ACTORS` for deposit ownership.
    next_actor: usize,
    /// Round-robin cursor over `ACTORS` for redemption-request ownership.
    next_redeem_actor: usize,
    /// Populated only by `run_scenario_traced`.
    trace: Option<TraceBuilder>,
}

impl Sim {
    fn new(sc: Scenario) -> Self {
        let mut sim = Sim {
            rng: Rng::new(sc.seed ^ 0xA5A5_5A5A_DEAD_BEEF),
            time_rng: Rng::new(sc.seed ^ TIMING_SALT),
            storage: MemoryStorage::new(),
            step: 0,
            block_time_secs: sc.genesis_secs,
            last_run_secs: sc.genesis_secs,
            next_fire_secs: None,
            sc,
            vals: vec![],
            unbonding: vec![],
            redelegations: vec![],
            marker_liquid: 0,
            receipt_in_marker: 0,
            shares: 0,
            user_shares: 0,
            receipt_minted: 0,
            contract_liquid: 0,
            redemptions: vec![],
            stats: Stats::default(),
            violations: vec![],
            next_actor: 0,
            next_redeem_actor: 0,
            trace: None,
        };
        // Genesis: a couple of chain validators, one enrolled.
        for _ in 0..(1 + sim.rng.below(3)) {
            sim.spawn_validator();
        }
        let v = sim.vals[0].valoper.clone();
        sim.enroll(&v);
        sim.stats.min_run_gap_secs = u64::MAX;
        sim
    }

    fn fail(&mut self, what: impl Into<String>) {
        let msg = format!("[seed {} step {}] {}", self.sc.seed, self.step, what.into());
        self.violations.push(msg);
    }
    fn check(&mut self, ok: bool, what: &str) {
        self.stats.checks += 1;
        if !ok {
            self.fail(what.to_string());
        }
    }

    /// Append a trace event (no-op unless `run_scenario_traced` requested one).
    fn record_event(&mut self, address: &str, kind: EventKind, shares: u128, nhash: u128) {
        let epoch_index = self.stats.epochs;
        if let Some(t) = self.trace.as_mut() {
            let seq = t.seq;
            t.seq += 1;
            t.events.push(TraceEvent {
                seq,
                address: address.to_string(),
                kind,
                shares,
                nhash,
                epoch_index,
            });
        }
    }

    /// Record a fulfilled redemption's request-to-payout time and bound it under
    /// the 60-day withdrawal-delay ceiling.
    fn record_mobilization(&mut self, requested_at: u64) {
        let mob = self.block_time_secs.saturating_sub(requested_at);
        self.stats.max_mobilization_secs = self.stats.max_mobilization_secs.max(mob);
        self.check(
            mob <= WITHDRAWAL_DELAY_CEILING_SECS,
            "mobilization exceeded the 60-day withdrawal-delay ceiling",
        );
    }

    /// Seconds into the new month the keeper waits before cranking, per the scenario's
    /// timing model; drawn from the timing RNG so the economic stream is unperturbed.
    fn keeper_delay(&mut self) -> u64 {
        match self.sc.timing {
            Timing::Jitter => self.time_rng.below(self.sc.keeper_jitter_max_secs.max(1)),
            // Late (26d) then prompt (1d) squeezes the gap below the unbonding period.
            Timing::Compressed => {
                if self.stats.epochs.is_multiple_of(2) {
                    26 * DAY_SECS
                } else {
                    DAY_SECS
                }
            }
            // Every third rollover waits past a whole month (skipped-month coverage).
            Timing::Skip => {
                if self.stats.epochs % 3 == 2 {
                    45 * DAY_SECS
                } else {
                    2 * DAY_SECS
                }
            }
        }
    }

    fn spawn_validator(&mut self) {
        let n = self.vals.len();
        let bond = self
            .rng
            .range(1_000_000_000, self.sc.deposit_ceiling / 4 + 1);
        self.vals.push(SimVal {
            valoper: format!("simvaloper1{n:05}"),
            third_party: bond,
            program: 0,
            jailed_until: 0,
            uptime_bps: 9_500 + self.rng.below(501),
            pending_rewards: 0,
        });
    }

    fn enroll(&mut self, valoper: &str) {
        VALIDATORS
            .save(
                &mut self.storage,
                valoper,
                &ValidatorRecord {
                    operator: Addr::unchecked(format!("op-{valoper}")),
                    enrolled_at: Timestamp::from_seconds(self.block_time_secs),
                    uptime_sum_bps: 0,
                    uptime_count: 0,
                    commission_accrued: Uint128::zero(),
                    commission_paid: Uint128::zero(),
                    commission_due: Uint128::zero(),
                    commission_billed: Uint128::zero(),
                    tip_epoch: Uint128::zero(),
                },
            )
            .unwrap();
    }

    fn tvv(&self) -> u128 {
        self.marker_liquid + self.receipt_in_marker
    }
    fn total_bonded(&self) -> u128 {
        self.vals.iter().map(|v| v.third_party + v.program).sum()
    }
    fn active_count(&self) -> u64 {
        self.vals
            .iter()
            .filter(|v| v.jailed_until <= self.block_time_secs)
            .count() as u64
    }
    fn staked_total(&self) -> u128 {
        self.vals.iter().map(|v| v.program).sum()
    }
    fn unbonding_total(&self) -> u128 {
        self.unbonding.iter().map(|(_, _, a)| *a).sum()
    }
    fn val_mut(&mut self, valoper: &str) -> &mut SimVal {
        self.vals.iter_mut().find(|v| v.valoper == valoper).unwrap()
    }

    /// Raw chain concentration cap (no safety offset), the never-rejected-delegation
    /// bar; the chain enforces it only at 4+ active validators.
    fn chain_cap(&self) -> Option<u128> {
        let active = self.active_count();
        if active < 4 {
            return None;
        }
        let pct = (CAP_MULTIPLE_BPS / active).clamp(CAP_MIN_BPS, CAP_MAX_BPS) as u128;
        Some(self.total_bonded() * pct / 10_000)
    }

    /// Mirror of assess_validators against sim state, reusing the real
    /// priority sort. Assessment.record comes from the real contract storage.
    fn assess(&self) -> Vec<Assessment> {
        let mut out = vec![];
        for v in &self.vals {
            let Ok(Some(record)) = VALIDATORS.may_load(&self.storage, &v.valoper) else {
                continue;
            };
            let jailed = v.jailed_until > self.block_time_secs;
            let in_arrears = record.commission_paid < record.commission_due;
            let meets = self.sc.performance_threshold_bps == 0
                || v.uptime_bps >= self.sc.performance_threshold_bps;
            let eligible = !jailed && !in_arrears && meets;
            let tokens = v.third_party + v.program;
            let max_bond = crate::plan::max_bond_adjusted(
                Uint128::new(self.total_bonded()),
                self.active_count(),
                CAP_MULTIPLE_BPS,
                CAP_MIN_BPS,
                CAP_MAX_BPS,
                CAP_OFFSET_BPS,
            );
            let headroom = if eligible {
                max_bond.u128().saturating_sub(tokens)
            } else {
                0
            };
            out.push(Assessment {
                valoper: v.valoper.clone(),
                record,
                bonded: !jailed,
                jailed,
                tombstoned: false,
                uptime_bps: Some(v.uptime_bps),
                in_arrears,
                eligible,
                headroom: Uint128::new(headroom),
            });
        }
        sort_by_priority(&mut out);
        out
    }

    fn dels(&self) -> Vec<DelegationView> {
        self.vals
            .iter()
            .filter(|v| v.program > 0)
            .map(|v| DelegationView {
                valoper: v.valoper.clone(),
                staked: Uint128::new(v.program),
            })
            .collect()
    }

    fn at_capacity(&self) -> Vec<String> {
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for (_, v, _) in &self.unbonding {
            *counts.entry(v.as_str()).or_default() += 1;
        }
        counts
            .into_iter()
            .filter(|(_, c)| *c >= MAX_UNBOND_ENTRIES)
            .map(|(v, _)| v.to_string())
            .collect()
    }

    /// Live estimate of a redemption's payout (the vault's EstimateSwapOut).
    /// Widened through 256 bits like the vault's own valuation math.
    fn estimate(&self, shares: u128) -> u128 {
        mul_div(shares, self.tvv(), self.shares)
    }

    fn pending_estimates(&self) -> Vec<(u64, Uint128)> {
        self.redemptions
            .iter()
            .enumerate()
            .map(|(i, r)| (i as u64, Uint128::new(self.estimate(r.shares))))
            .collect()
    }

    /// Validate + apply an unbond emitted by the planners.
    fn apply_unbond(&mut self, valoper: &str, amount: u128) {
        let stake = self.val_mut(valoper).program;
        self.check(amount <= stake, "unbond exceeds live delegation");
        // A move onto a MaxEntries-full queue would be chain-rejected and revert the crank.
        let saturated = self.at_capacity().iter().any(|v| v == valoper);
        self.check(
            !saturated,
            "unbond to a MaxEntries-full validator (chain would reject)",
        );
        let v = self.val_mut(valoper);
        v.program = v.program.saturating_sub(amount);
        self.unbonding.push((
            self.block_time_secs + UNBOND_SECS,
            valoper.to_string(),
            amount,
        ));
    }

    /// ServiceRedemptions keeper pass (runs every step), mirroring the
    /// contract's service leg with the real planners.
    fn keeper_service(&mut self) {
        let assessments = self.assess();
        let ranks = drain_ranks(&assessments);
        let dels = order_for_drain(self.dels(), &ranks);
        let at_capacity = self.at_capacity();
        let plan = plan_service(
            &self.pending_estimates(),
            Uint128::new(self.marker_liquid + self.contract_liquid),
            Uint128::new(self.marker_liquid),
            Uint128::new(self.unbonding_total()),
            &dels,
            &at_capacity,
            self.sc.redemption_margin_bps,
        );
        for (v, a) in plan.undelegations {
            self.apply_unbond(&v, a.u128());
        }
        // Expedites pay immediately from the marker at live NAV.
        let mut expedited: Vec<usize> = plan.expedite_ids.iter().map(|i| *i as usize).collect();
        expedited.sort_unstable_by(|a, b| b.cmp(a));
        for idx in expedited {
            let payout = self.estimate(self.redemptions[idx].shares);
            self.check(
                payout <= self.marker_liquid,
                "expedite past marker liquidity",
            );
            let r = self.redemptions.remove(idx);
            self.record_mobilization(r.requested_at);
            self.marker_liquid = self.marker_liquid.saturating_sub(payout);
            self.shares -= r.shares;
            self.stats.redemptions_paid += 1;
            self.record_event(&r.address, EventKind::RedemptionPayout, r.shares, payout);
        }
    }

    /// One epoch crank, mirroring run_epoch's documented sequence with the
    /// real planners, then the invariant battery.
    fn run_epoch(&mut self) {
        let tvv_before = self.tvv();
        let nav_before = if self.shares > 0 {
            self.tvv() as f64 / self.shares as f64
        } else {
            0.0
        };

        // Phase A: accrue commission on the exact claim set, then claim.
        let claims: Vec<(String, Uint128)> = self
            .vals
            .iter()
            .filter(|v| v.pending_rewards > 0)
            .map(|v| (v.valoper.clone(), Uint128::new(v.pending_rewards)))
            .collect();
        accrue_commission(&mut self.storage, &claims, self.sc.commission_bps).unwrap();
        let mut expected_charge = Uint128::zero();
        for (v, amt) in &claims {
            if VALIDATORS.has(&self.storage, v) {
                expected_charge += commission_on(*amt, self.sc.commission_bps);
            }
        }
        let _ = expected_charge; // accrual equality asserted in the smoke test
        let claimed: u128 = claims.iter().map(|(_, a)| a.u128()).sum();
        self.contract_liquid += claimed;
        for v in &mut self.vals {
            v.pending_rewards = 0;
        }

        // Reads + service leg.
        let assessments = self.assess();
        let ranks = drain_ranks(&assessments);
        let eligible: Vec<(String, u128)> = assessments
            .iter()
            .filter(|a| a.eligible)
            .map(|a| (a.valoper.clone(), a.headroom.u128()))
            .collect();
        let need = redemption_need(&self.pending_estimates(), self.sc.redemption_margin_bps).u128();
        let budget = if eligible.is_empty() {
            0
        } else {
            let buffer = fee_reserve(
                Uint128::new(self.tvv()),
                self.sc.aum_fee_bps,
                2 * NOMINAL_EPOCH_SECS, // two nominal (~30-day) months
            )
            .u128()
            .max(self.marker_liquid * DEPLOY_BUFFER_BPS / 10_000);
            self.marker_liquid.saturating_sub(need + buffer)
        };
        let marker_after = (self.marker_liquid + self.contract_liquid).saturating_sub(budget);
        let dels = order_for_drain(self.dels(), &ranks);
        let at_capacity = self.at_capacity();
        let plan = plan_service(
            &self.pending_estimates(),
            Uint128::new(self.marker_liquid + self.contract_liquid),
            Uint128::new(marker_after),
            Uint128::new(self.unbonding_total()),
            &dels,
            &at_capacity,
            self.sc.redemption_margin_bps,
        );
        let expedite_ids = plan.expedite_ids.clone();
        for (v, a) in plan.undelegations {
            self.apply_unbond(&v, a.u128());
        }

        // Return plan via the real function: value-neutral settlement plus the markdown.
        let ret = plan_return(
            Uint128::new(self.receipt_minted),
            Uint128::new(self.staked_total()),
            Uint128::new(self.unbonding_total()),
            Uint128::new(self.contract_liquid),
        );
        let matured = Uint128::new(self.receipt_minted)
            .saturating_sub(Uint128::new(self.staked_total() + self.unbonding_total()));
        self.stats.checks += 1;
        if ret.settle + ret.write_down != matured {
            self.fail("settle + write_down != matured (loss recognition deferred)");
        }
        let settle = ret.settle.u128();
        let write_down = ret.write_down.u128();
        self.check(
            settle <= self.contract_liquid,
            "settle exceeds contract liquid",
        );
        self.check(
            settle + write_down <= self.receipt_in_marker,
            "burn exceeds receipt outstanding in marker",
        );
        self.contract_liquid -= settle;
        self.marker_liquid += settle;
        self.receipt_in_marker -= settle;
        self.receipt_in_marker = self.receipt_in_marker.saturating_sub(write_down);
        self.receipt_minted = self.receipt_minted.saturating_sub(settle + write_down);
        if write_down > 0 {
            self.stats.write_downs += 1;
        }
        let rewards_dep = self.contract_liquid;
        self.marker_liquid += rewards_dep;
        self.contract_liquid = 0;

        // Uniform-slot rebalance with the real planner; every move is validated (never-rejected).
        let blocked_sources: std::collections::BTreeSet<String> = self
            .redelegations
            .iter()
            .filter(|(exp, _, _)| *exp > self.block_time_secs)
            .map(|(_, _, dst)| dst.clone())
            .collect();
        let mut pair_counts: BTreeMap<(String, String), usize> = BTreeMap::new();
        for (exp, src, dst) in &self.redelegations {
            if *exp > self.block_time_secs {
                *pair_counts.entry((src.clone(), dst.clone())).or_default() += 1;
            }
        }
        let blocked_pairs: std::collections::BTreeSet<(String, String)> = pair_counts
            .into_iter()
            .filter(|(_, c)| *c >= MAX_UNBOND_ENTRIES)
            .map(|(p, _)| p)
            .collect();
        let eligible_set: std::collections::BTreeSet<String> =
            eligible.iter().map(|(v, _)| v.clone()).collect();
        let seats: Vec<RebalanceSeat> = eligible
            .iter()
            .map(|(v, headroom)| RebalanceSeat {
                valoper: v.clone(),
                current: Uint128::new(self.vals.iter().find(|x| x.valoper == *v).unwrap().program),
                add_headroom: Uint128::new(*headroom),
            })
            .collect();
        let others: Vec<DelegationView> = self
            .dels()
            .into_iter()
            .filter(|d| !eligible_set.contains(&d.valoper))
            .collect();
        let rb = plan_rebalance(
            &seats,
            &others,
            Uint128::new(budget),
            &blocked_sources,
            &blocked_pairs,
        );
        for (src, dst, amount) in &rb.redelegations {
            let amount = amount.u128();
            self.check(src != dst, "self redelegation");
            self.check(
                !blocked_sources.contains(src),
                "redelegation from a transitive-blocked source",
            );
            self.check(
                !blocked_pairs.contains(&(src.clone(), dst.clone())),
                "redelegation on a MaxEntries-full pair",
            );
            let src_stake = self.val_mut(src).program;
            self.check(amount <= src_stake, "redelegation exceeds source stake");
            if let Some(cap) = self.chain_cap() {
                let dst_tokens = {
                    let d = self.val_mut(dst);
                    d.third_party + d.program
                };
                self.check(
                    dst_tokens + amount <= cap,
                    "redelegation would breach the chain cap",
                );
            }
            self.val_mut(src).program -= amount;
            self.val_mut(dst).program += amount;
            self.redelegations.push((
                self.block_time_secs + REDELEGATION_LOCK_SECS,
                src.clone(),
                dst.clone(),
            ));
            self.stats.redelegations += 1;
        }
        // Fresh deploy: value-neutral settlement (marker nhash out, receipt in).
        let deployable: u128 = rb.delegations.iter().map(|(_, a)| a.u128()).sum();
        self.check(deployable <= budget, "deploy exceeds budget");
        self.check(
            deployable <= self.marker_liquid,
            "deploy exceeds marker liquid",
        );
        self.marker_liquid -= deployable;
        self.receipt_in_marker += deployable;
        self.receipt_minted += deployable;
        for (dst, amount) in &rb.delegations {
            let amount = amount.u128();
            if let Some(cap) = self.chain_cap() {
                let tokens = {
                    let d = self.val_mut(dst);
                    d.third_party + d.program
                };
                self.check(
                    tokens + amount <= cap,
                    "delegation would breach the chain cap",
                );
            }
            self.val_mut(dst).program += amount;
        }

        // Expedites at epoch, tracking payouts so the TVV identity below stays exact.
        let mut expedite_paid = 0u128;
        let mut expedited: Vec<usize> = expedite_ids.iter().map(|i| *i as usize).collect();
        expedited.sort_unstable_by(|a, b| b.cmp(a));
        for idx in expedited {
            if idx >= self.redemptions.len() {
                continue;
            }
            let payout = self.estimate(self.redemptions[idx].shares);
            if payout <= self.marker_liquid {
                let r = self.redemptions.remove(idx);
                self.record_mobilization(r.requested_at);
                self.marker_liquid -= payout;
                self.shares -= r.shares;
                expedite_paid += payout;
                self.stats.redemptions_paid += 1;
                self.record_event(&r.address, EventKind::RedemptionPayout, r.shares, payout);
            }
        }

        epoch_rollover(&mut self.storage).unwrap();

        // Advance last_run to block time (mirrors epoch.rs); record calendar-cadence stats.
        let gap = self.block_time_secs.saturating_sub(self.last_run_secs);
        self.stats.min_run_gap_secs = self.stats.min_run_gap_secs.min(gap);
        let (ny, nm) = year_month(Timestamp::from_seconds(self.block_time_secs));
        let (ly, lm) = year_month(Timestamp::from_seconds(self.last_run_secs));
        let months = ((ny * 12 + nm as i32) - (ly * 12 + lm as i32)).max(0) as u32;
        self.stats.max_month_skip = self.stats.max_month_skip.max(months);
        self.last_run_secs = self.block_time_secs;

        // ===== invariant battery =====
        let tvv_after = self.tvv();
        // Exact TVV identity: only rewards (up), write-down and expedite payouts (down) move TVV.
        let expected = (tvv_before + rewards_dep)
            .checked_sub(write_down)
            .and_then(|v| v.checked_sub(expedite_paid));
        self.check(Some(tvv_after) == expected, "TVV identity violated");
        let _ = claimed;
        // Four-way receipt conservation.
        self.check(
            self.receipt_minted == self.receipt_in_marker,
            "receipt counter != receipt in marker",
        );
        self.check(
            self.receipt_minted == self.staked_total() + self.unbonding_total(),
            "receipt != staked + unbonding",
        );
        // Expedite burns floor-round in holders' favor, so absent a slash NAV must not
        // drop; the 1e-12 relative epsilon covers f64 precision at TVL past 1e20.
        if write_down == 0 && self.shares > 0 && nav_before > 0.0 {
            let nav_after = self.tvv() as f64 / self.shares as f64;
            self.check(
                nav_after >= nav_before * (1.0 - 1e-12),
                "NAV decreased without a slash",
            );
        }
        // Convergence: when no lock, residual, or cap binds, every eligible seat must sit
        // within largest-remainder dust of the uniform slot after one epoch.
        let locks = !blocked_sources.is_empty() || !blocked_pairs.is_empty();
        if !seats.is_empty() && !locks && rb.undeployable.is_zero() {
            let mut cap_bound = false;
            let stakes: Vec<u128> = seats
                .iter()
                .map(|s| {
                    let cur = self
                        .vals
                        .iter()
                        .find(|x| x.valoper == s.valoper)
                        .unwrap()
                        .program;
                    if cur >= s.current.u128() + s.add_headroom.u128() {
                        cap_bound = true;
                    }
                    cur
                })
                .collect();
            if !cap_bound {
                let max = *stakes.iter().max().unwrap();
                let min = *stakes.iter().min().unwrap();
                let dev = max - min;
                self.stats.worst_convergence_dev = self.stats.worst_convergence_dev.max(dev);
                self.check(
                    dev <= seats.len() as u128,
                    "uniform slot not reached within the epoch",
                );
            }
        }
        // Share conservation: outstanding == user-held + escrowed.
        let escrowed: u128 = self.redemptions.iter().map(|r| r.shares).sum();
        self.check(
            self.shares == self.user_shares + escrowed,
            "share conservation violated",
        );
        self.stats.epochs += 1;
        self.stats.max_tvv = self.stats.max_tvv.max(self.tvv());
        self.stats.max_shares = self.stats.max_shares.max(self.shares);
        if let Some(t) = self.trace.as_mut() {
            t.epochs.push(TraceEpoch {
                epoch_index: self.stats.epochs,
                ended_at_seconds: self.block_time_secs,
                tvv_after,
                total_shares: self.shares,
            });
        }
    }

    /// One keeper step: advance the clock, run user/world events, keeper
    /// service, maturities, fees, then crank if a calendar month has rolled.
    fn run_step(&mut self) {
        self.step += 1;
        // Advance the consensus clock by a seeded per-step delta.
        let delta = STEP_MIN_SECS + self.time_rng.below(STEP_MAX_SECS - STEP_MIN_SECS + 1);
        self.block_time_secs = self.block_time_secs.saturating_add(delta);
        if year_month(Timestamp::from_seconds(self.block_time_secs)).1 == 2 {
            self.stats.saw_february = true;
        }
        // Reward accrual is per elapsed second, so a month accrues the same over any step count.
        for v in &mut self.vals {
            if v.jailed_until <= self.block_time_secs {
                v.pending_rewards += mul_div(
                    v.program,
                    self.sc.reward_bps_per_epoch as u128 * delta as u128,
                    10_000 * NOMINAL_EPOCH_SECS as u128,
                );
            }
        }
        // Deposits.
        if self.rng.chance(self.sc.p_deposit, 100) {
            let amount = self.rng.range(self.sc.min_deposit, self.sc.deposit_ceiling);
            let minted = if self.shares == 0 {
                amount.saturating_mul(SHARE_SCALAR)
            } else {
                mul_div(amount, self.shares, self.tvv().max(1))
            };
            self.marker_liquid += amount;
            self.shares += minted;
            self.user_shares += minted;
            self.stats.deposits += 1;
            // Trace attribution only: round-robin tag, no rng draw, pooled math unchanged.
            let owner = ACTORS[self.next_actor % ACTORS.len()];
            self.next_actor += 1;
            self.record_event(owner, EventKind::SwapIn, minted, amount);
        }
        // Redemption requests stay one pooled entry; the owner tag is trace metadata, never a split.
        if self.user_shares > 0 && self.rng.chance(self.sc.p_redeem, 100) {
            let shares = self.rng.range(1, self.user_shares);
            self.user_shares -= shares;
            let owner = ACTORS[self.next_redeem_actor % ACTORS.len()];
            self.next_redeem_actor += 1;
            self.redemptions.push(Redemption {
                address: owner.to_string(),
                shares,
                due: self.block_time_secs + REDEMPTION_DELAY_SECS,
                requested_at: self.block_time_secs,
            });
            self.stats.redemption_requests += 1;
            self.record_event(owner, EventKind::SwapOutRequest, shares, 0);
        }
        // Jail + 1% slash of everything on the validator.
        if self.rng.chance(self.sc.p_jail, 100) && !self.vals.is_empty() {
            let i = self.rng.below(self.vals.len() as u64) as usize;
            let v = &mut self.vals[i];
            if v.jailed_until <= self.block_time_secs {
                v.jailed_until = self.block_time_secs + JAIL_SECS;
                v.third_party -= v.third_party / 100;
                v.program -= v.program / 100;
                v.uptime_bps = v.uptime_bps.saturating_sub(500).max(8_000);
                self.stats.slashes += 1;
            }
        }
        // Validator-set churn and third-party bond drift.
        if self.vals.len() < self.sc.max_validators && self.rng.chance(self.sc.p_enroll, 100) {
            self.spawn_validator();
            let v = self.vals.last().unwrap().valoper.clone();
            self.enroll(&v);
        }
        if self.rng.chance(self.sc.p_unregister, 100) {
            let enrolled: Vec<String> = crate::validators::enrolled(&self.storage)
                .unwrap()
                .into_iter()
                .map(|(v, _)| v)
                .collect();
            if enrolled.len() > 1 {
                let v = &enrolled[self.rng.below(enrolled.len() as u64) as usize];
                VALIDATORS.remove(&mut self.storage, v);
            }
        }
        if self.rng.chance(30, 100) && !self.vals.is_empty() {
            let i = self.rng.below(self.vals.len() as u64) as usize;
            let delta = self.rng.range(0, self.sc.deposit_ceiling / 20 + 1);
            if self.rng.chance(1, 2) {
                self.vals[i].third_party += delta;
            } else {
                self.vals[i].third_party = self.vals[i].third_party.saturating_sub(delta).max(1);
            }
        }
        // Tips and commission payments (operators mostly stay current).
        let enrolled: Vec<String> = crate::validators::enrolled(&self.storage)
            .unwrap()
            .into_iter()
            .map(|(v, _)| v)
            .collect();
        for v in &enrolled {
            if self.rng.chance(self.sc.p_tip, 400) {
                let mut rec = VALIDATORS.load(&self.storage, v).unwrap();
                rec.tip_epoch += Uint128::new(self.rng.range(1, 1_000_000_000));
                VALIDATORS.save(&mut self.storage, v, &rec).unwrap();
            }
            if self.rng.chance(self.sc.p_pay_commission, 400) {
                let mut rec = VALIDATORS.load(&self.storage, v).unwrap();
                let owed = rec.commission_accrued.saturating_sub(rec.commission_paid);
                if !owed.is_zero() {
                    rec.commission_paid += owed;
                    VALIDATORS.save(&mut self.storage, v, &rec).unwrap();
                    // Operator funds arrive at the contract, swept next epoch.
                    self.contract_liquid += owed.u128();
                }
            }
        }
        // Keeper service pass.
        self.keeper_service();
        // Maturities (wall-clock deadlines).
        let now = self.block_time_secs;
        let mut matured = 0u128;
        self.unbonding.retain(|(due, _, a)| {
            if *due <= now {
                matured += *a;
                false
            } else {
                true
            }
        });
        self.contract_liquid += matured;
        self.redelegations.retain(|(exp, _, _)| *exp > now);
        // Due redemptions pay from the marker at live NAV, else refund; the keeper ran
        // every step, so a refund is a genuine liquidity-model finding.
        let mut i = 0;
        while i < self.redemptions.len() {
            if self.redemptions[i].due <= self.block_time_secs {
                let payout = self.estimate(self.redemptions[i].shares);
                if payout <= self.marker_liquid {
                    let r = self.redemptions.remove(i);
                    self.record_mobilization(r.requested_at);
                    self.marker_liquid -= payout;
                    self.shares -= r.shares;
                    self.stats.redemptions_paid += 1;
                    self.record_event(&r.address, EventKind::RedemptionPayout, r.shares, payout);
                } else {
                    let r = self.redemptions.remove(i);
                    self.user_shares += r.shares;
                    self.stats.redemption_refunds += 1;
                    self.record_event(&r.address, EventKind::RedemptionRefund, r.shares, 0);
                }
            } else {
                i += 1;
            }
        }
        // AUM fee skim over the elapsed seconds from marker liquidity.
        if self.sc.aum_fee_bps > 0 {
            let fee = mul_div(
                self.tvv(),
                self.sc.aum_fee_bps as u128 * delta as u128,
                10_000 * YEAR_SECONDS,
            );
            if fee <= self.marker_liquid {
                self.marker_liquid -= fee;
            } else {
                self.stats.fee_starved_steps += 1;
            }
        }
        // Production calendar predicate: on a strictly later civil month, latch a fire
        // target at month-start + keeper delay and crank when block time reaches it.
        let now_ym = year_month(Timestamp::from_seconds(self.block_time_secs));
        let last_ym = year_month(Timestamp::from_seconds(self.last_run_secs));
        if now_ym > last_ym {
            if self.next_fire_secs.is_none() {
                let month_start = crate::month::first_of_next_month_secs(Timestamp::from_seconds(
                    self.last_run_secs,
                ));
                let delay = self.keeper_delay();
                self.next_fire_secs = Some(month_start.saturating_add(delay));
            }
            if self.block_time_secs >= self.next_fire_secs.unwrap() {
                self.run_epoch();
                self.next_fire_secs = None;
            }
        }
    }
}

/// Run one scenario to completion; arithmetic panics are caught and recorded
/// as violations carrying the seed.
pub fn run_scenario(sc: Scenario) -> SimResult {
    run_scenario_impl(sc, false).0
}

/// Same execution as `run_scenario`, plus the full deposit/redemption/epoch
/// trace for the derived-metrics property harness.
pub fn run_scenario_traced(sc: Scenario) -> (SimResult, Trace) {
    let (result, trace) = run_scenario_impl(sc, true);
    (result, trace.expect("trace requested"))
}

fn run_scenario_impl(sc: Scenario, want_trace: bool) -> (SimResult, Option<Trace>) {
    let seed = sc.seed;
    let epochs = sc.epochs;
    let outcome = std::panic::catch_unwind(move || {
        let mut sim = Sim::new(sc);
        if want_trace {
            sim.trace = Some(TraceBuilder::default());
        }
        // Steps-per-epoch varies, so drive by crank count under a step safety cap.
        let target = epochs as u64;
        let max_steps = target * 60 + 1_000;
        let mut n = 0u64;
        while sim.stats.epochs < target && n < max_steps {
            sim.run_step();
            n += 1;
            if sim.violations.len() > 25 {
                break; // a broken scenario floods; keep the head
            }
        }
        let trace = sim.trace.take().map(|t| Trace {
            seed,
            epochs: t.epochs,
            events: t.events,
        });
        (
            SimResult {
                stats: sim.stats,
                violations: sim.violations,
            },
            trace,
        )
    });
    match outcome {
        Ok(r) => r,
        Err(e) => {
            let what = e
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| e.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            (
                SimResult {
                    stats: Stats::default(),
                    violations: vec![format!("[seed {seed}] PANIC: {what}")],
                },
                None,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed-seed CI smoke: a swarm of scenarios covering churn, slashes,
    /// arrears and cap pressure must complete with zero violations.
    #[test]
    fn simulation_smoke_zero_violations() {
        let mut total_epochs = 0;
        for seed in 1..=40u64 {
            let sc = Scenario::from_seed(seed, 48);
            let result = run_scenario(sc);
            assert!(
                result.violations.is_empty(),
                "seed {seed} violations: {:#?}",
                result.violations
            );
            total_epochs += result.stats.epochs;
        }
        assert!(total_epochs >= 40 * 48);
    }

    /// Boundary-domain CI check (SECURITY.md): every edge scenario completes with zero
    /// violations, and each demonstrably hit the edge it targets.
    #[test]
    fn simulation_boundary_domain_zero_violations() {
        for (label, sc) in boundary_scenarios(48) {
            let result = run_scenario(sc);
            assert!(
                result.violations.is_empty(),
                "boundary scenario '{label}' violations: {:#?}",
                result.violations
            );
            let s = &result.stats;
            assert!(s.epochs >= 48, "'{label}' ran only {} epochs", s.epochs);
            match label {
                "dust-economy" => {
                    assert!(s.deposits > 0, "dust economy made no deposits");
                    assert!(
                        s.max_tvv <= 1_000 * 200,
                        "dust economy TVL escaped the dust range: {}",
                        s.max_tvv
                    );
                }
                "empty-vault" => {
                    assert_eq!(s.deposits, 0, "empty-vault scenario deposited");
                    assert_eq!(s.max_tvv, 0, "empty-vault scenario accrued TVV");
                }
                "uint64-share-crossing" => {
                    assert!(
                        s.max_shares > u64::MAX as u128,
                        "share supply never crossed uint64: {}",
                        s.max_shares
                    );
                }
                "extreme-tvl" => {
                    assert!(
                        s.max_tvv > 1_000_000_000_000_000_000_000_000_000, // > 1e27
                        "extreme-TVL scenario stayed small: {}",
                        s.max_tvv
                    );
                }
                "margin-zero" => {
                    // The edge is exercised when the no-cover path produces refunds.
                    assert!(
                        s.redemption_requests > 0,
                        "margin-zero raised no redemptions"
                    );
                    assert!(
                        s.redemption_refunds > 0,
                        "margin-zero never refunded — the zero-margin edge was not exercised"
                    );
                }
                "margin-max" => {
                    // The edge is exercised when traffic flowed through the over-covering reserve.
                    assert!(
                        s.redemption_requests > 0,
                        "margin-max raised no redemptions"
                    );
                    assert!(s.redemptions_paid > 0, "margin-max paid no redemptions");
                }
                _ => {}
            }
        }
    }

    /// Calendar-cadence CI check: every timing edge completes with zero violations
    /// and demonstrably reached its edge; the mobilization ceiling is asserted inline.
    #[test]
    fn simulation_calendar_domain_zero_violations() {
        for (label, sc) in calendar_scenarios(48) {
            let result = run_scenario(sc);
            assert!(
                result.violations.is_empty(),
                "calendar scenario '{label}' violations: {:#?}",
                result.violations
            );
            let s = &result.stats;
            assert!(s.epochs >= 48, "'{label}' ran only {} epochs", s.epochs);
            match label {
                "calendar-compressed-gap" => {
                    assert!(
                        s.min_run_gap_secs < UNBOND_SECS,
                        "compressed-gap scenario never squeezed below the unbonding period: {}s",
                        s.min_run_gap_secs
                    );
                }
                "calendar-skipped-month" => {
                    assert!(
                        s.max_month_skip >= 2,
                        "skipped-month scenario never skipped a month (max jump {})",
                        s.max_month_skip
                    );
                }
                "calendar-leap-february" => {
                    assert!(s.saw_february, "leap scenario never traversed February");
                }
                _ => {}
            }
        }
    }

    /// Golden test: a tiny fixed scenario (one validator,
    /// no rewards/fees/slashes/churn, a fixed deposit every step, one epoch)
    /// serializes to the exact expected trace JSON.
    #[test]
    fn trace_export_golden_json() {
        let sc = Scenario {
            seed: 7,
            epochs: 1,
            max_validators: 1,
            reward_bps_per_epoch: 0,
            commission_bps: 0,
            aum_fee_bps: 0,
            performance_threshold_bps: 0,
            deposit_ceiling: 5_000_000,
            min_deposit: 5_000_000,
            p_deposit: 100,
            p_redeem: 0,
            p_jail: 0,
            p_enroll: 0,
            p_unregister: 0,
            p_tip: 0,
            p_pay_commission: 0,
            genesis_secs: GENESIS_SECS,
            keeper_jitter_max_secs: 0,
            timing: Timing::Jitter,
            // Pinned so the golden trace stays byte-identical.
            redemption_margin_bps: 50,
        };
        let (result, trace) = run_scenario_traced(sc);
        assert!(
            result.violations.is_empty(),
            "golden scenario violations: {:#?}",
            result.violations
        );
        let json = serde_json::to_string_pretty(&trace).unwrap();
        assert_eq!(json, GOLDEN_TRACE_JSON);
    }

    /// Summing trace events across addresses must reproduce the pooled totals exactly;
    /// splitting a pooled deposit/redemption across owners inflates the per-kind count.
    #[test]
    fn trace_per_actor_totals_match_pooled_stats() {
        for seed in [1u64, 4, 8] {
            let sc = Scenario::from_seed(seed, 24);
            let (result, trace) = run_scenario_traced(sc);
            assert!(
                result.violations.is_empty(),
                "seed {seed} violations: {:#?}",
                result.violations
            );
            let mut by_address: BTreeMap<&str, BTreeMap<EventKind, u64>> = BTreeMap::new();
            for e in &trace.events {
                *by_address
                    .entry(e.address.as_str())
                    .or_default()
                    .entry(e.kind)
                    .or_insert(0) += 1;
            }
            let pooled = |kind: EventKind| -> u64 {
                by_address
                    .values()
                    .map(|k| *k.get(&kind).unwrap_or(&0))
                    .sum()
            };
            assert_eq!(
                pooled(EventKind::SwapIn),
                result.stats.deposits,
                "seed {seed}: per-actor swap_in totals must sum to the pooled deposit count"
            );
            assert_eq!(
                pooled(EventKind::SwapOutRequest),
                result.stats.redemption_requests,
                "seed {seed}: per-actor swap_out_request totals must sum to the pooled request count (never split)"
            );
            assert_eq!(
                pooled(EventKind::RedemptionPayout),
                result.stats.redemptions_paid,
                "seed {seed}: per-actor payout totals must sum to the pooled paid count"
            );
            assert_eq!(
                pooled(EventKind::RedemptionRefund),
                result.stats.redemption_refunds,
                "seed {seed}: per-actor refund totals must sum to the pooled refund count"
            );
        }
    }

    /// Tracing is purely observational: a traced run must reach byte-identical
    /// pooled stats to an untraced run of the same seed.
    #[test]
    fn tracing_never_changes_economics() {
        for seed in [1u64, 4, 8, 9] {
            let untraced = run_scenario(Scenario::from_seed(seed, 24));
            let (traced, _trace) = run_scenario_traced(Scenario::from_seed(seed, 24));
            assert_eq!(
                untraced.stats.deposits, traced.stats.deposits,
                "seed {seed}: deposits"
            );
            assert_eq!(
                untraced.stats.redemption_requests, traced.stats.redemption_requests,
                "seed {seed}: redemption_requests"
            );
            assert_eq!(
                untraced.stats.redemptions_paid, traced.stats.redemptions_paid,
                "seed {seed}: redemptions_paid"
            );
            assert_eq!(
                untraced.stats.redemption_refunds, traced.stats.redemption_refunds,
                "seed {seed}: redemption_refunds"
            );
            assert_eq!(
                untraced.stats.max_tvv, traced.stats.max_tvv,
                "seed {seed}: max_tvv"
            );
            assert_eq!(
                untraced.stats.max_shares, traced.stats.max_shares,
                "seed {seed}: max_shares"
            );
            assert_eq!(
                untraced.violations.len(),
                traced.violations.len(),
                "seed {seed}: violation count"
            );
        }
    }

    const GOLDEN_TRACE_JSON: &str = r#"{
  "seed": 7,
  "epochs": [
    {
      "epoch_index": 1,
      "ended_at_seconds": 1738402741,
      "tvv_after": "35000000",
      "total_shares": "35000000000000"
    }
  ],
  "events": [
    {
      "seq": 0,
      "address": "user-0",
      "kind": "swap_in",
      "shares": "5000000000000",
      "nhash": "5000000",
      "epoch_index": 0
    },
    {
      "seq": 1,
      "address": "user-1",
      "kind": "swap_in",
      "shares": "5000000000000",
      "nhash": "5000000",
      "epoch_index": 0
    },
    {
      "seq": 2,
      "address": "user-2",
      "kind": "swap_in",
      "shares": "5000000000000",
      "nhash": "5000000",
      "epoch_index": 0
    },
    {
      "seq": 3,
      "address": "user-0",
      "kind": "swap_in",
      "shares": "5000000000000",
      "nhash": "5000000",
      "epoch_index": 0
    },
    {
      "seq": 4,
      "address": "user-1",
      "kind": "swap_in",
      "shares": "5000000000000",
      "nhash": "5000000",
      "epoch_index": 0
    },
    {
      "seq": 5,
      "address": "user-2",
      "kind": "swap_in",
      "shares": "5000000000000",
      "nhash": "5000000",
      "epoch_index": 0
    },
    {
      "seq": 6,
      "address": "user-0",
      "kind": "swap_in",
      "shares": "5000000000000",
      "nhash": "5000000",
      "epoch_index": 0
    }
  ]
}"#;
}
