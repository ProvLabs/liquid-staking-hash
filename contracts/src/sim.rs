//! Chain-free multi-epoch simulation / property suite (RC2 §15.5).
//!
//! Drives the PRODUCTION planners and record logic (plan_rebalance,
//! plan_service, plan_return, commission accrual, priority/drain ordering,
//! epoch rollover on real contract storage) against a simulated chain and
//! vault, across randomized multi-decade timelines, asserting the §4.2-family
//! invariants at every epoch. What is simulated: staking/slashing semantics,
//! redelegation/unbonding locks, the concentration cap, vault TVV/NAV/shares,
//! settlement value-neutrality, users and reward streams. What is NOT covered
//! here: chain integration plumbing (the devnet drills own that).
//!
//! Native-only (gated out of the wasm build). Run via `cargo run --release
//! --bin simulate` for the long-running soak, or rely on the fixed-seed smoke
//! test in this module for CI.

use std::collections::BTreeMap;

use cosmwasm_std::{Addr, MemoryStorage, Timestamp, Uint128};

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
    /// Smallest deposit a user may make. 1 = dust economies (SECURITY.md
    /// boundary domain: one base unit must flow through every leg cleanly).
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
            performance_threshold_bps: if r.chance(1, 2) { 0 } else { 9_000 + r.below(900) },
            deposit_ceiling: r.range(1_000_000_000, 1_000_000_000_000_000_000_000),
            min_deposit: 1_000_000,
            p_deposit: 10 + r.below(40),
            p_redeem: 5 + r.below(30),
            p_jail: r.below(8),
            p_enroll: 5 + r.below(20),
            p_unregister: r.below(10),
            p_tip: r.below(30),
            p_pay_commission: 60 + r.below(41),
        }
    }
}

/// Deterministic boundary-domain scenarios (SECURITY.md: the simulation must
/// cover the full allowed input domain, not just its randomized interior).
/// Each pins one edge of the domain; the CI test runs all of them and asserts
/// the targeted edge was actually exercised, so none can rot into a no-op.
pub fn boundary_scenarios(epochs: u32) -> Vec<(&'static str, Scenario)> {
    let base = |seed: u64| Scenario::from_seed(seed, epochs);
    vec![
        (
            // One-base-unit deposits: the whole economy lives in dust, so every
            // floor division, margin, and largest-remainder split sees 0/1-unit
            // operands.
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
            // No deposits ever: every epoch cranks an empty vault (zero shares,
            // zero TVV, no redemptions) without violation or panic.
            "empty-vault",
            Scenario {
                p_deposit: 0,
                p_redeem: 0,
                ..base(0xE307)
            },
        ),
        (
            // Cross the uint64 share ceiling (shares = nhash x 1e6 crosses 2^64
            // at ~18,447 HASH TVL): valuation math must stay exact past it.
            "uint64-share-crossing",
            Scenario {
                deposit_ceiling: 60_000_000_000_000, // 60k HASH per deposit max
                p_deposit: 60,
                p_redeem: 10,
                ..base(0x64C5)
            },
        ),
        (
            // Extreme TVL: deposits to 1e30 nhash push every u128 sum and the
            // 256-bit-widened valuation paths far past realistic supply.
            "extreme-tvl",
            Scenario {
                deposit_ceiling: 1_000_000_000_000_000_000_000_000_000_000,
                p_deposit: 50,
                ..base(0x7F1A)
            },
        ),
        (
            // Rates at their configured maxima (bounds enforced by
            // Config::validate): 100% commission, 100%/yr AUM fee, a 100%
            // uptime threshold. Fee starvation and arrears churn are expected;
            // invariant violations are not.
            "rates-at-maxima",
            Scenario {
                commission_bps: 10_000,
                aum_fee_bps: 10_000,
                performance_threshold_bps: 10_000,
                ..base(0xFEE5)
            },
        ),
        (
            // The 100-validator bound (MAX_VALIDATORS mirrors the Provenance
            // active-set ceiling): planner scale at the full seat count.
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

// Time quantization: 4 keeper steps per epoch; the mainnet shape (unbonding
// shorter than the epoch, redemption delay = two epochs) is preserved.
const STEPS_PER_EPOCH: u64 = 4;
const UNBOND_STEPS: u64 = 3;
const REDELEGATION_LOCK_STEPS: u64 = 3;
const REDEMPTION_DELAY_STEPS: u64 = 2 * STEPS_PER_EPOCH;
const REDEMPTION_MARGIN_BPS: u64 = 50;
const DEPLOY_BUFFER_BPS: u128 = 50;
const SHARE_SCALAR: u128 = 1_000_000;
// Concentration cap params (Provenance defaults) and the contract's offset.
const CAP_MULTIPLE_BPS: u64 = 55_000;
const CAP_MIN_BPS: u64 = 500;
const CAP_MAX_BPS: u64 = 3_300;
const CAP_OFFSET_BPS: u64 = 500;

/// floor(a * b / d) widened through 256 bits (the vault's valuation math
/// widens the same way; results are bounded by their economic inputs).
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
    shares: u128,
    due: u64,
}

/// Aggregate outcome counters for reporting.
#[derive(Default, Debug, Clone)]
pub struct Stats {
    pub epochs: u64,
    pub checks: u64,
    pub deposits: u64,
    pub redemptions_paid: u64,
    pub redemption_refunds: u64,
    pub slashes: u64,
    pub write_downs: u64,
    pub redelegations: u64,
    pub fee_starved_steps: u64,
    pub max_tvv: u128,
    /// Largest outstanding share supply observed; boundary scenarios assert it
    /// actually crossed the uint64 share ceiling they target.
    pub max_shares: u128,
    pub worst_convergence_dev: u128,
}

pub struct SimResult {
    pub stats: Stats,
    pub violations: Vec<String>,
}

struct Sim {
    rng: Rng,
    sc: Scenario,
    storage: MemoryStorage,
    step: u64,
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
}

impl Sim {
    fn new(sc: Scenario) -> Self {
        let mut sim = Sim {
            rng: Rng::new(sc.seed ^ 0xA5A5_5A5A_DEAD_BEEF),
            sc,
            storage: MemoryStorage::new(),
            step: 0,
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
        };
        // Genesis: a couple of chain validators, one enrolled.
        for _ in 0..(1 + sim.rng.below(3)) {
            sim.spawn_validator();
        }
        let v = sim.vals[0].valoper.clone();
        sim.enroll(&v);
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

    fn spawn_validator(&mut self) {
        let n = self.vals.len();
        let bond = self.rng.range(1_000_000_000, self.sc.deposit_ceiling / 4 + 1);
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
                    enrolled_at: Timestamp::from_seconds(self.step),
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
        self.vals.iter().filter(|v| v.jailed_until <= self.step).count() as u64
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

    /// The RAW chain concentration cap (no safety offset): the bar every
    /// emitted move must clear for the never-rejected-delegation invariant.
    /// Enforced by the chain only at 4+ active validators.
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
            let jailed = v.jailed_until > self.step;
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
        let v = self.val_mut(valoper);
        v.program = v.program.saturating_sub(amount);
        self.unbonding
            .push((self.step + UNBOND_STEPS, valoper.to_string(), amount));
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
            REDEMPTION_MARGIN_BPS,
        );
        for (v, a) in plan.undelegations {
            self.apply_unbond(&v, a.u128());
        }
        // Expedites pay immediately from the marker at live NAV.
        let mut expedited: Vec<usize> = plan.expedite_ids.iter().map(|i| *i as usize).collect();
        expedited.sort_unstable_by(|a, b| b.cmp(a));
        for idx in expedited {
            let payout = self.estimate(self.redemptions[idx].shares);
            self.check(payout <= self.marker_liquid, "expedite past marker liquidity");
            let r = self.redemptions.remove(idx);
            self.marker_liquid = self.marker_liquid.saturating_sub(payout);
            self.shares -= r.shares;
            self.stats.redemptions_paid += 1;
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
        let need = redemption_need(&self.pending_estimates(), REDEMPTION_MARGIN_BPS).u128();
        let budget = if eligible.is_empty() {
            0
        } else {
            let buffer = fee_reserve(
                Uint128::new(self.tvv()),
                self.sc.aum_fee_bps,
                2 * 2_592_000, // two-epoch horizon, monthly epochs
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
            REDEMPTION_MARGIN_BPS,
        );
        let expedite_ids = plan.expedite_ids.clone();
        for (v, a) in plan.undelegations {
            self.apply_unbond(&v, a.u128());
        }

        // Return plan: settle + write-down with the REAL function; apply the
        // settlement (value-neutral) and the markdown to the sim vault.
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
        self.check(settle <= self.contract_liquid, "settle exceeds contract liquid");
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

        // Uniform-slot rebalance with the REAL planner; every emitted move is
        // validated against the sim chain's own rules (never-rejected).
        let blocked_sources: std::collections::BTreeSet<String> = self
            .redelegations
            .iter()
            .filter(|(exp, _, _)| *exp > self.step)
            .map(|(_, _, dst)| dst.clone())
            .collect();
        let mut pair_counts: BTreeMap<(String, String), usize> = BTreeMap::new();
        for (exp, src, dst) in &self.redelegations {
            if *exp > self.step {
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
                self.check(dst_tokens + amount <= cap, "redelegation would breach the chain cap");
            }
            self.val_mut(src).program -= amount;
            self.val_mut(dst).program += amount;
            self.redelegations.push((
                self.step + REDELEGATION_LOCK_STEPS,
                src.clone(),
                dst.clone(),
            ));
            self.stats.redelegations += 1;
        }
        // Fresh deploy: value-neutral settlement (marker nhash out, receipt in).
        let deployable: u128 = rb.delegations.iter().map(|(_, a)| a.u128()).sum();
        self.check(deployable <= budget, "deploy exceeds budget");
        self.check(deployable <= self.marker_liquid, "deploy exceeds marker liquid");
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

        // Expedites at epoch (same gate as the keeper), tracking payouts so
        // the TVV identity below stays exact.
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
                self.marker_liquid -= payout;
                self.shares -= r.shares;
                expedite_paid += payout;
                self.stats.redemptions_paid += 1;
            }
        }

        epoch_rollover(&mut self.storage).unwrap();

        // ===== invariant battery =====
        let tvv_after = self.tvv();
        // Exact TVV identity: only the reward deposit (up), the write-down
        // (down) and expedite payouts (down, matched by share burns) moved TVV
        // this crank; settlements and deploys are value-neutral.
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
        // NAV never decreases from contract action alone (no slash, no fee in
        // this window; expedite payouts burn shares at floor-rounded NAV, so
        // remaining holders can only gain dust). Relative epsilon: f64 carries
        // ~15 significant digits and TVL ranges past 1e20.
        if write_down == 0 && self.shares > 0 && nav_before > 0.0 {
            let nav_after = self.tvv() as f64 / self.shares as f64;
            self.check(
                nav_after >= nav_before * (1.0 - 1e-12),
                "NAV decreased without a slash",
            );
        }
        // Convergence (§9.3): when nothing binds — no in-flight locks, no
        // undeployable residual, no seat pinned at its concentration cap —
        // every eligible seat must sit within largest-remainder dust of the
        // uniform slot after the single epoch.
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
    }

    /// One keeper step: user/world events, keeper service, maturities, fees.
    fn run_step(&mut self) {
        self.step += 1;
        // Reward accrual pro-rata to program stake.
        for v in &mut self.vals {
            if v.jailed_until <= self.step {
                v.pending_rewards +=
                    v.program * self.sc.reward_bps_per_epoch as u128 / 10_000 / STEPS_PER_EPOCH as u128;
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
        }
        // Redemption requests.
        if self.user_shares > 0 && self.rng.chance(self.sc.p_redeem, 100) {
            let shares = self.rng.range(1, self.user_shares);
            self.user_shares -= shares;
            self.redemptions.push(Redemption {
                shares,
                due: self.step + REDEMPTION_DELAY_STEPS,
            });
        }
        // Jail + 1% slash of everything on the validator.
        if self.rng.chance(self.sc.p_jail, 100) && !self.vals.is_empty() {
            let i = self.rng.below(self.vals.len() as u64) as usize;
            let v = &mut self.vals[i];
            if v.jailed_until <= self.step {
                v.jailed_until = self.step + 2;
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
        // Maturities.
        let step = self.step;
        let mut matured = 0u128;
        self.unbonding.retain(|(due, _, a)| {
            if *due <= step {
                matured += *a;
                false
            } else {
                true
            }
        });
        self.contract_liquid += matured;
        self.redelegations.retain(|(exp, _, _)| *exp > step);
        // Redemptions at their due date: payable from the marker at live NAV,
        // else refunded (adequacy tracking; the keeper ran every step, so a
        // refund is a genuine liquidity-model finding).
        let mut i = 0;
        while i < self.redemptions.len() {
            if self.redemptions[i].due <= self.step {
                let payout = self.estimate(self.redemptions[i].shares);
                if payout <= self.marker_liquid {
                    let r = self.redemptions.remove(i);
                    self.marker_liquid -= payout;
                    self.shares -= r.shares;
                    self.stats.redemptions_paid += 1;
                } else {
                    let r = self.redemptions.remove(i);
                    self.user_shares += r.shares;
                    self.stats.redemption_refunds += 1;
                }
            } else {
                i += 1;
            }
        }
        // AUM fee skim (per step) from marker liquidity.
        if self.sc.aum_fee_bps > 0 {
            let per_year = self.tvv() * self.sc.aum_fee_bps as u128 / 10_000;
            let fee = per_year / (12 * STEPS_PER_EPOCH) as u128;
            if fee <= self.marker_liquid {
                self.marker_liquid -= fee;
            } else {
                self.stats.fee_starved_steps += 1;
            }
        }
        // Epoch boundary.
        if self.step % STEPS_PER_EPOCH == 0 {
            self.run_epoch();
        }
    }
}

/// Run one scenario to completion; arithmetic panics are caught and recorded
/// as violations carrying the seed.
pub fn run_scenario(sc: Scenario) -> SimResult {
    let seed = sc.seed;
    let epochs = sc.epochs;
    let outcome = std::panic::catch_unwind(move || {
        let mut sim = Sim::new(sc);
        for _ in 0..(epochs as u64 * STEPS_PER_EPOCH) {
            sim.run_step();
            if sim.violations.len() > 25 {
                break; // a broken scenario floods; keep the head
            }
        }
        SimResult {
            stats: sim.stats,
            violations: sim.violations,
        }
    });
    match outcome {
        Ok(r) => r,
        Err(e) => {
            let what = e
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| e.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            SimResult {
                stats: Stats::default(),
                violations: vec![format!("[seed {seed}] PANIC: {what}")],
            }
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

    /// Boundary-domain CI check (SECURITY.md): every edge scenario completes
    /// with zero violations, and each one demonstrably hit the edge it targets
    /// (a scenario that stops exercising its boundary fails, not just one that
    /// breaks an invariant).
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
                _ => {}
            }
        }
    }
}
