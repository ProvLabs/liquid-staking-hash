use std::collections::BTreeSet;

use cosmwasm_std::Uint128;

#[derive(Clone, Debug, PartialEq)]
pub struct DelegationView {
    pub valoper: String,
    pub staked: Uint128,
}

/// Seconds per year used by the vault module's AUM accrual (365-day year).
const YEAR_SECONDS: u128 = 31_536_000;

/// Split `total` into `n` parts as evenly as possible (largest-remainder): the first
/// `total % n` parts get one extra unit. Sums exactly to `total`. Empty when `n == 0`.
pub fn split_even(total: Uint128, n: usize) -> Vec<Uint128> {
    if n == 0 {
        return vec![];
    }
    let n_u = Uint128::new(n as u128);
    let base = total / n_u;
    let rem = (total - base * n_u).u128() as usize;
    (0..n)
        .map(|i| if i < rem { base + Uint128::one() } else { base })
        .collect()
}

/// Spread `budget` underlying across validators as evenly as their concentration
/// headroom allows (RC1 §9.2/§9.7): waterfall redistribution — each pass splits
/// the remainder evenly over validators with room left, clamping each share to
/// that validator's headroom. Anything no validator can legally take is simply
/// not allocated (the undeliverable residual stays liquid in the vault, §8).
/// Deterministic: input order is preserved; zero-amount entries are dropped.
pub fn plan_deploy_capped(
    budget: Uint128,
    headrooms: &[(String, Uint128)],
) -> Vec<(String, Uint128)> {
    let n = headrooms.len();
    let mut alloc: Vec<Uint128> = vec![Uint128::zero(); n];
    let mut remaining = budget;
    loop {
        let open: Vec<usize> = (0..n).filter(|&i| alloc[i] < headrooms[i].1).collect();
        if open.is_empty() || remaining.is_zero() {
            break;
        }
        let shares = split_even(remaining, open.len());
        let mut progressed = false;
        for (share, &i) in shares.into_iter().zip(open.iter()) {
            let room = headrooms[i].1 - alloc[i];
            let take = share.min(room);
            if !take.is_zero() {
                alloc[i] += take;
                remaining -= take;
                progressed = true;
            }
        }
        // No validator could take anything (remaining spread to zero shares):
        // the leftover is sub-splittable dust; stop.
        if !progressed {
            break;
        }
    }
    headrooms
        .iter()
        .zip(alloc)
        .filter(|(_, a)| !a.is_zero())
        .map(|((v, _), a)| (v.clone(), a))
        .collect()
}

/// Signed-blocks ratio in bps from a slashing SigningInfo read. Saturating and
/// clamped so malformed inputs (window 0, missed > window) degrade to 0.
pub fn uptime_ratio_bps(signed_blocks_window: i64, missed_blocks_counter: i64) -> u64 {
    if signed_blocks_window <= 0 {
        return 0;
    }
    let window = signed_blocks_window as u128;
    let missed = missed_blocks_counter.max(0) as u128;
    let signed = window.saturating_sub(missed);
    ((signed * 10_000) / window) as u64
}

/// Per-validator max bond under the Provenance concentration cap (§9.7), reduced
/// by the configured safety offset:
/// `maxValPct = clamp(multiple / active_count, min_cap, max_cap)` (all bps of 1);
/// `max_bond = total_bonded × maxValPct × (1 − offset)`. Floor arithmetic.
pub fn max_bond_adjusted(
    total_bonded: Uint128,
    active_count: u64,
    multiple_bps: u64,
    min_cap_bps: u64,
    max_cap_bps: u64,
    offset_bps: u64,
) -> Uint128 {
    if active_count == 0 {
        return Uint128::zero();
    }
    let pct_bps = (multiple_bps / active_count)
        .max(min_cap_bps)
        .min(max_cap_bps);
    total_bonded
        .multiply_ratio(pct_bps, 10_000u128)
        .multiply_ratio(10_000u128.saturating_sub(offset_bps as u128), 10_000u128)
}

/// Validators to claim from: enrolled validators (enrollment order) that have
/// rewards, then any other validator the contract still has reward-bearing
/// delegations with (e.g. unregistered but not yet unbonded), sorted for
/// determinism.
pub fn plan_claim(validators: &[String], with_rewards: &[String]) -> Vec<String> {
    let mut out: Vec<String> = validators
        .iter()
        .filter(|v| with_rewards.contains(v))
        .cloned()
        .collect();
    let mut extras: Vec<String> = with_rewards
        .iter()
        .filter(|w| !validators.contains(w))
        .cloned()
        .collect();
    extras.sort();
    out.extend(extras);
    out
}

/// Delegation targets as `(valoper, amount)` pairs, in plan order.
pub type DelegationTargets = Vec<(String, Uint128)>;

/// Split delegation targets into (this-run, remainder) for chunked execution.
/// `max == 0` means unlimited. Keeps the per-validator delegate loop inside the
/// per-tx gas budget; the remainder is persisted and drained by continuation cranks.
pub fn take_chunk(
    mut targets: DelegationTargets,
    max: u32,
) -> (DelegationTargets, DelegationTargets) {
    if max == 0 || targets.len() <= max as usize {
        return (targets, vec![]);
    }
    let rest = targets.split_off(max as usize);
    (targets, rest)
}

/// nhash the deploy leg must leave liquid so the vault can pay the AUM fee that will
/// accrue over `horizon_secs`. The fee accrues on the whole TVV and is skimmed from
/// the principal marker's liquid nhash at each reconcile; deploying it away starves
/// the fee (observed live in the POC). Design C note: with payment == underlying the
/// fee path is identity end to end, but the liquidity requirement is unchanged.
pub fn fee_reserve(tvv: Uint128, aum_fee_bps: u64, horizon_secs: u64) -> Uint128 {
    if aum_fee_bps == 0 || horizon_secs == 0 {
        return Uint128::zero();
    }
    tvv.multiply_ratio(aum_fee_bps as u128, 10_000u128)
        .multiply_ratio(horizon_secs as u128, YEAR_SECONDS)
}

/// One eligible validator's inputs to the uniform-slot rebalance.
#[derive(Clone, Debug, PartialEq)]
pub struct RebalanceSeat {
    pub valoper: String,
    /// Current program delegation (after this crank's redemption unbonds).
    pub current: Uint128,
    /// Additional delegation the concentration cap admits (RC1 §9.7).
    pub add_headroom: Uint128,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RebalancePlan {
    /// (src, dst, amount) redelegations, sources exhausted in input order,
    /// destinations filled in priority order.
    pub redelegations: Vec<(String, String, Uint128)>,
    /// Fresh-liquidity delegations to destinations still below target.
    pub delegations: Vec<(String, Uint128)>,
    /// Fresh liquidity no eligible validator can legally take: stays liquid.
    pub undeployable: Uint128,
}

/// The uniform-slot rebalance (RC1 §9.2/§9.3/§9.4): drive every eligible
/// validator toward the same slot within the epoch using redelegations
/// (stake stays productive) plus fresh liquidity, never unbonding.
///
/// - `eligible`: priority-ordered seats. Targets are the headroom-capped
///   waterfall of the whole pool (their stake + movable other stake + fresh),
///   so the highest-priority seats absorb largest-remainder units and any
///   cap-blocked residual (RC1 §10.2).
/// - `others`: delegations on non-eligible validators (unregistered,
///   in-arrears, below-threshold, jailed): fully redelegated away (§9.4).
/// - `blocked_sources`: validators with an in-flight INBOUND redelegation
///   entry. The no-transitive-redelegation rule forbids moving stake off
///   them, so their stake is pinned in place this epoch (eligible seats get a
///   floor at `current`; others simply keep their stake) and retried later.
/// - `blocked_pairs`: (src, dst) routes at the staking MaxEntries cap for the
///   contract; the matcher routes around them and defers what cannot move.
pub fn plan_rebalance(
    eligible: &[RebalanceSeat],
    others: &[DelegationView],
    fresh: Uint128,
    blocked_sources: &BTreeSet<String>,
    blocked_pairs: &BTreeSet<(String, String)>,
) -> RebalancePlan {
    if eligible.is_empty() {
        // Nothing may receive: no moves, all fresh liquidity stays liquid.
        return RebalancePlan {
            undeployable: fresh,
            ..Default::default()
        };
    }

    // Movable non-eligible stake joins the pool; pinned stake does not.
    let movable_others: Vec<&DelegationView> = others
        .iter()
        .filter(|d| !blocked_sources.contains(&d.valoper) && !d.staked.is_zero())
        .collect();
    let pool_others: Uint128 = movable_others.iter().map(|d| d.staked).sum();
    let pool_eligible: Uint128 = eligible.iter().map(|s| s.current).sum();
    let total = pool_eligible + pool_others + fresh;

    // Targets by level water-fill: every free seat gets an equal share of the
    // pool; a seat whose share violates its floor (pinned stake that cannot
    // leave) or cap (concentration headroom) is fixed at that bound and the
    // pool re-levels among the rest. Deterministic, feasible (each target
    // stays within its bounds), and uniform wherever bounds do not bind;
    // largest-remainder units land on the highest-priority free seats.
    let n = eligible.len();
    let caps: Vec<Uint128> = eligible
        .iter()
        .map(|s| s.current + s.add_headroom)
        .collect();
    let floors: Vec<Uint128> = eligible
        .iter()
        .map(|s| {
            if blocked_sources.contains(&s.valoper) {
                s.current
            } else {
                Uint128::zero()
            }
        })
        .collect();
    let mut fixed: Vec<Option<Uint128>> = vec![None; n];
    loop {
        let free: Vec<usize> = (0..n).filter(|i| fixed[*i].is_none()).collect();
        if free.is_empty() {
            break;
        }
        let fixed_sum: Uint128 = fixed.iter().flatten().copied().sum();
        let shares = split_even(total.saturating_sub(fixed_sum), free.len());
        let mut changed = false;
        for (share, &i) in shares.iter().zip(&free) {
            if *share < floors[i] {
                fixed[i] = Some(floors[i]);
                changed = true;
            } else if *share > caps[i] {
                fixed[i] = Some(caps[i]);
                changed = true;
            }
        }
        if !changed {
            for (share, &i) in shares.iter().zip(&free) {
                fixed[i] = Some(*share);
            }
            break;
        }
    }
    let targets: Vec<Uint128> = fixed.into_iter().map(|t| t.unwrap_or_default()).collect();

    // Sources: non-eligible stake first (it must all leave), then eligible
    // seats above target. Destinations: seats below target, priority order.
    let mut sources: Vec<(String, Uint128)> = movable_others
        .iter()
        .map(|d| (d.valoper.clone(), d.staked))
        .collect();
    for (seat, target) in eligible.iter().zip(&targets) {
        if seat.current > *target && !blocked_sources.contains(&seat.valoper) {
            sources.push((seat.valoper.clone(), seat.current - *target));
        }
    }
    let mut dest_needs: Vec<(String, Uint128)> = eligible
        .iter()
        .zip(&targets)
        .filter(|(s, t)| **t > s.current)
        .map(|(s, t)| (s.valoper.clone(), *t - s.current))
        .collect();

    // Route source excess into destination needs, skipping blocked routes;
    // whatever cannot be routed stays where it is (retried next epoch).
    let mut redelegations = vec![];
    for (src, mut excess) in sources {
        for (dst, need) in dest_needs.iter_mut() {
            if excess.is_zero() {
                break;
            }
            if need.is_zero() || blocked_pairs.contains(&(src.clone(), dst.clone())) {
                continue;
            }
            let take = excess.min(*need);
            redelegations.push((src.clone(), dst.clone(), take));
            excess -= take;
            *need -= take;
        }
    }

    // Fresh liquidity fills what redelegations did not, bounded by `fresh`;
    // the rest of `fresh` is undeployable residual.
    let mut delegations = vec![];
    let mut fresh_left = fresh;
    for (dst, need) in dest_needs {
        if fresh_left.is_zero() {
            break;
        }
        let take = fresh_left.min(need);
        if !take.is_zero() {
            delegations.push((dst, take));
            fresh_left -= take;
        }
    }

    RebalancePlan {
        redelegations,
        delegations,
        undeployable: fresh_left,
    }
}

/// Annualize a window inflow against a base value, in bps (floor arithmetic):
/// inflow / base scaled from window_secs to a 365-day year. 0 when the base or
/// window is degenerate or the math would overflow (u128-saturating guard).
pub fn annualized_bps(inflow: Uint128, base: Uint128, window_secs: u64) -> u64 {
    if base.is_zero() || window_secs == 0 || inflow.is_zero() {
        return 0;
    }
    let numer = inflow
        .u128()
        .checked_mul(10_000)
        .and_then(|v| v.checked_mul(YEAR_SECONDS));
    let denom = base.u128().checked_mul(window_secs as u128);
    match (numer, denom) {
        (Some(n), Some(d)) if d > 0 => u64::try_from(n / d).unwrap_or(u64::MAX),
        _ => 0,
    }
}

/// Program commission on a claimed reward amount: rewards x bps, floored
/// (RC1 §10.1).
pub fn commission_on(rewards: Uint128, commission_bps: u64) -> Uint128 {
    if commission_bps == 0 {
        return Uint128::zero();
    }
    rewards.multiply_ratio(commission_bps as u128, 10_000u128)
}

/// Cosmos SDK staking MaxEntries: at most this many concurrent unbonding entries per
/// (delegator, validator) pair; an Undelegate beyond it fails the whole tx.
/// [VERIFY] Provenance mainnet staking params still use the SDK default of 7.
pub const MAX_UNBOND_ENTRIES: usize = 7;

/// Total nhash that must be liquid to cover all pending swap-outs, with a small
/// over-cover margin. `pending` amounts are current-NAV payout estimates
/// (EstimateSwapOut); payouts re-price at maturity NAV and escrowed shares keep
/// appreciating during the delay, so the margin covers the drift.
pub fn redemption_need(pending: &[(u64, Uint128)], margin_bps: u64) -> Uint128 {
    let queued: Uint128 = pending
        .iter()
        .map(|(_, a)| *a)
        .fold(Uint128::zero(), |s, a| s + a);
    if queued.is_zero() {
        return Uint128::zero();
    }
    queued.multiply_ratio(10_000u128 + margin_bps as u128, 10_000u128)
}

/// Unbond in the caller-provided drain order (lowest program priority first,
/// RC1 §10.2: unenrolled, then ineligible, then eligible by ascending TIP/uptime
/// priority) until `shortfall` is covered, skipping validators whose
/// unbonding-entry queue is full (`at_capacity`). Never unbonds more than a
/// validator's staked amount. May return less than `shortfall` if every
/// candidate is at capacity; the uncovered remainder is retried on later cranks
/// as entries mature.
pub fn plan_unbond(
    drain_ordered: &[DelegationView],
    shortfall: Uint128,
    at_capacity: &[String],
) -> Vec<(String, Uint128)> {
    let mut remaining = shortfall;
    let mut out = vec![];
    for d in drain_ordered {
        if remaining.is_zero() {
            break;
        }
        if at_capacity.contains(&d.valoper) {
            continue;
        }
        let take = remaining.min(d.staked);
        if !take.is_zero() {
            out.push((d.valoper.clone(), take));
            remaining -= take;
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq)]
pub struct ServicePlan {
    pub undelegations: Vec<(String, Uint128)>,
    pub expedite_ids: Vec<u64>,
}

/// Plan redemption servicing. `delegations` must already be in drain order
/// (lowest priority first); see plan_unbond.
/// - `cover_liquid`: nhash that is in, or will land in, the vault principal
///   (vault liquid + contract liquid); reduces how much must be unbonded.
/// - `expedite_liquid`: nhash the principal marker itself will hold when payouts
///   run. Payouts are made by the vault EndBlocker from the marker only, so
///   expedites are gated on this, never on contract-held balance.
/// - `unbonding`: principal already unbonding back (all unbonding in this contract
///   is redemption-driven); subtracted so it is never re-unbonded.
pub fn plan_service(
    pending: &[(u64, Uint128)],
    cover_liquid: Uint128,
    expedite_liquid: Uint128,
    unbonding: Uint128,
    delegations: &[DelegationView],
    at_capacity: &[String],
    margin_bps: u64,
) -> ServicePlan {
    let need = redemption_need(pending, margin_bps);
    let shortfall = need.saturating_sub(cover_liquid + unbonding);
    let undelegations = plan_unbond(delegations, shortfall, at_capacity);

    let mut remaining = expedite_liquid;
    let mut expedite_ids = vec![];
    for (id, amt) in pending {
        // Hold each request to the same margin the reserve uses so an expedited
        // payout (re-priced at maturity) cannot outrun the marker.
        let covered = amt.multiply_ratio(10_000u128 + margin_bps as u128, 10_000u128);
        if covered <= remaining {
            expedite_ids.push(*id);
            remaining -= covered;
        }
    }
    ServicePlan {
        undelegations,
        expedite_ids,
    }
}

/// The Design C return plan. `matured = receipt_minted - staked - unbonding` is
/// receipt no longer backed by anything out on the chain: either its nhash returned
/// (it is in `liquid`, the contract balance) or it was slashed away.
#[derive(Clone, Debug, PartialEq)]
pub struct ReturnPlan {
    /// Receipt to swap back out via an unpaused exchange settlement, backed 1:1 by
    /// returned nhash (the contract pays `settle` nhash, receives `settle` receipt,
    /// burns it). Value-neutral by construction.
    pub settle: Uint128,
    /// Receipt to withdraw from the marker (paused leg) and burn UNBACKED: principal
    /// lost to slashing. Marks TVV down immediately so redemptions cannot exit at an
    /// overstated NAV between epochs. When rewards on hand exceed the slash, the
    /// loss nets through the settle leg instead and this is zero.
    pub write_down: Uint128,
}

/// settle + write_down always equals matured: loss recognition is never deferred.
/// The caller deposits `liquid - settle` as the reward NAV step-up.
pub fn plan_return(
    receipt_minted: Uint128,
    staked: Uint128,
    unbonding: Uint128,
    liquid: Uint128,
) -> ReturnPlan {
    let matured = receipt_minted.saturating_sub(staked + unbonding);
    let settle = matured.min(liquid);
    ReturnPlan {
        settle,
        write_down: matured.saturating_sub(settle),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tgt(v: &str, a: u128) -> (String, Uint128) {
        (v.to_string(), Uint128::new(a))
    }

    #[test]
    fn split_even_sums_and_spreads() {
        let parts = split_even(Uint128::new(10), 3);
        assert_eq!(
            parts,
            vec![Uint128::new(4), Uint128::new(3), Uint128::new(3)]
        );
        assert_eq!(parts.iter().sum::<Uint128>(), Uint128::new(10));
        assert!(split_even(Uint128::new(10), 0).is_empty());
    }

    fn room(v: &str, h: u128) -> (String, Uint128) {
        (v.to_string(), Uint128::new(h))
    }

    #[test]
    fn plan_deploy_capped_spreads_evenly_when_unconstrained() {
        let rooms = vec![room("valA", 1000), room("valB", 1000), room("valC", 1000)];
        assert_eq!(
            plan_deploy_capped(Uint128::new(10), &rooms),
            vec![tgt("valA", 4), tgt("valB", 3), tgt("valC", 3)]
        );
        assert_eq!(
            plan_deploy_capped(Uint128::new(2), &rooms),
            vec![tgt("valA", 1), tgt("valB", 1)]
        );
        assert!(plan_deploy_capped(Uint128::zero(), &rooms).is_empty());
        assert!(plan_deploy_capped(Uint128::new(10), &[]).is_empty());
    }

    #[test]
    fn plan_deploy_capped_clamps_and_redistributes() {
        // valB can only take 2; its excess share flows to valA and valC.
        let rooms = vec![room("valA", 100), room("valB", 2), room("valC", 100)];
        let targets = plan_deploy_capped(Uint128::new(30), &rooms);
        assert_eq!(
            targets,
            vec![tgt("valA", 14), tgt("valB", 2), tgt("valC", 14)]
        );
        let total: Uint128 = targets.iter().map(|(_, a)| *a).sum();
        assert_eq!(total, Uint128::new(30));
    }

    #[test]
    fn plan_deploy_capped_leaves_undeliverable_residual_unallocated() {
        // Total headroom 5 < budget 30: allocate 5, the rest stays liquid.
        let rooms = vec![room("valA", 3), room("valB", 2), room("valC", 0)];
        let targets = plan_deploy_capped(Uint128::new(30), &rooms);
        assert_eq!(targets, vec![tgt("valA", 3), tgt("valB", 2)]);
        // All-zero headroom: nothing allocated at all.
        assert!(plan_deploy_capped(Uint128::new(30), &[room("valA", 0)]).is_empty());
    }

    #[test]
    fn uptime_ratio_bps_clamps_malformed_inputs() {
        assert_eq!(uptime_ratio_bps(34_560, 0), 10_000);
        assert_eq!(uptime_ratio_bps(34_560, 34_560), 0);
        assert_eq!(uptime_ratio_bps(34_560, 40_000), 0); // missed > window
        assert_eq!(uptime_ratio_bps(34_560, -5), 10_000); // negative missed
        assert_eq!(uptime_ratio_bps(0, 0), 0); // degenerate window
        assert_eq!(uptime_ratio_bps(10_000, 200), 9_800);
    }

    #[test]
    fn max_bond_adjusted_clamps_and_offsets() {
        let bonded = Uint128::new(1_000_000);
        // 5.5x / 68 validators = 808 bps (within 5%..33%); no offset.
        assert_eq!(
            max_bond_adjusted(bonded, 68, 55_000, 500, 3300, 0),
            Uint128::new(80_800)
        );
        // 5.5x / 200 = 275 bps, clamped up to the 5% floor.
        assert_eq!(
            max_bond_adjusted(bonded, 200, 55_000, 500, 3300, 0),
            Uint128::new(50_000)
        );
        // 5.5x / 10 = 5500 bps, clamped down to the 33% ceiling.
        assert_eq!(
            max_bond_adjusted(bonded, 10, 55_000, 500, 3300, 0),
            Uint128::new(330_000)
        );
        // 5% safety offset shaves 5% off the max bond.
        assert_eq!(
            max_bond_adjusted(bonded, 200, 55_000, 500, 3300, 500),
            Uint128::new(47_500)
        );
        // No active validators: zero.
        assert_eq!(
            max_bond_adjusted(bonded, 0, 55_000, 500, 3300, 0),
            Uint128::zero()
        );
    }

    #[test]
    fn plan_claim_includes_removed_validators_with_rewards() {
        let vals = vec!["valA".to_string(), "valB".to_string()];
        let with = vec!["valZ".to_string(), "valA".to_string()];
        assert_eq!(
            plan_claim(&vals, &with),
            vec!["valA".to_string(), "valZ".to_string()]
        );
    }

    #[test]
    fn take_chunk_splits_by_max() {
        let t = vec![tgt("a", 1), tgt("b", 2), tgt("c", 3)];
        let (run, rest) = take_chunk(t.clone(), 0);
        assert_eq!(run, t);
        assert!(rest.is_empty());
        let (run, rest) = take_chunk(t.clone(), 2);
        assert_eq!(run, vec![tgt("a", 1), tgt("b", 2)]);
        assert_eq!(rest, vec![tgt("c", 3)]);
        let (run, rest) = take_chunk(t.clone(), 5);
        assert_eq!(run, t);
        assert!(rest.is_empty());
    }

    #[test]
    fn fee_reserve_scales_with_tvv_and_time() {
        // 1e9 TVV at 15 bps over 30 days: annual AUM fee is 1e9 * 15/10000 = 1_500_000;
        // for 30 days: 1_500_000 * 2_592_000/31_536_000 = 123_287 (floor).
        assert_eq!(
            fee_reserve(Uint128::new(1_000_000_000), 15, 2_592_000),
            Uint128::new(123_287)
        );
        assert_eq!(
            fee_reserve(Uint128::new(1_000_000_000), 0, 2_592_000),
            Uint128::zero()
        );
        assert_eq!(
            fee_reserve(Uint128::new(1_000_000_000), 15, 0),
            Uint128::zero()
        );
    }

    #[test]
    fn redemption_need_applies_margin() {
        assert_eq!(
            redemption_need(&[(1, Uint128::new(1000)), (2, Uint128::new(1000))], 50),
            Uint128::new(2010)
        );
        assert_eq!(redemption_need(&[], 50), Uint128::zero());
    }

    #[test]
    fn plan_unbond_walks_drain_order() {
        // Caller provides drain order (lowest priority first); the plan takes
        // from the front, spilling to the next only when a validator is
        // exhausted.
        let dels = vec![
            DelegationView {
                valoper: "valB".into(),
                staked: Uint128::new(100),
            },
            DelegationView {
                valoper: "valA".into(),
                staked: Uint128::new(300),
            },
            DelegationView {
                valoper: "valC".into(),
                staked: Uint128::new(50),
            },
        ];
        assert_eq!(
            plan_unbond(&dels, Uint128::new(250), &[]),
            vec![tgt("valB", 100), tgt("valA", 150)]
        );
        assert_eq!(
            plan_unbond(&dels, Uint128::new(420), &[]),
            vec![tgt("valB", 100), tgt("valA", 300), tgt("valC", 20)]
        );
        assert!(plan_unbond(&dels, Uint128::zero(), &[]).is_empty());
    }

    fn seat(v: &str, current: u128, headroom: u128) -> RebalanceSeat {
        RebalanceSeat {
            valoper: v.to_string(),
            current: Uint128::new(current),
            add_headroom: Uint128::new(headroom),
        }
    }
    fn dv(v: &str, staked: u128) -> DelegationView {
        DelegationView {
            valoper: v.to_string(),
            staked: Uint128::new(staked),
        }
    }
    fn no_blocks() -> (BTreeSet<String>, BTreeSet<(String, String)>) {
        (BTreeSet::new(), BTreeSet::new())
    }

    #[test]
    fn rebalance_converges_to_uniform_slot() {
        // 300 + 0 + 0 staked, 60 fresh: slot = 120 each.
        let (bs, bp) = no_blocks();
        let plan = plan_rebalance(
            &[
                seat("valA", 300, 1000),
                seat("valB", 0, 1000),
                seat("valC", 0, 1000),
            ],
            &[],
            Uint128::new(60),
            &bs,
            &bp,
        );
        // valA sheds 180 to B (120) and C (60); fresh 60 tops C to 120.
        assert_eq!(
            plan.redelegations,
            vec![
                ("valA".into(), "valB".into(), Uint128::new(120)),
                ("valA".into(), "valC".into(), Uint128::new(60)),
            ]
        );
        assert_eq!(
            plan.delegations,
            vec![("valC".to_string(), Uint128::new(60))]
        );
        assert_eq!(plan.undeployable, Uint128::zero());
    }

    #[test]
    fn rebalance_drains_non_eligible_via_redelegation() {
        // Unregistered valX's 90 moves to the eligible seats, never unbonds.
        let (bs, bp) = no_blocks();
        let plan = plan_rebalance(
            &[seat("valA", 30, 1000), seat("valB", 0, 1000)],
            &[dv("valX", 90)],
            Uint128::zero(),
            &bs,
            &bp,
        );
        // Pool 120 -> slot 60: valX's 90 fills valB's 60 then valA's 30.
        let moved: Uint128 = plan
            .redelegations
            .iter()
            .filter(|(s, _, _)| s == "valX")
            .map(|(_, _, a)| *a)
            .sum();
        assert_eq!(moved, Uint128::new(90));
        assert!(plan.redelegations.iter().all(|(s, d, _)| s != d));
        assert!(plan.delegations.is_empty());
    }

    #[test]
    fn rebalance_respects_headroom_and_priority_residual() {
        // Slot would be 100 each, but valB can only add 10 (cap): the excess
        // flows to the higher-priority valA; fresh that no seat can take
        // stays liquid.
        let (bs, bp) = no_blocks();
        let plan = plan_rebalance(
            &[seat("valA", 0, 130), seat("valB", 0, 10)],
            &[],
            Uint128::new(200),
            &bs,
            &bp,
        );
        assert_eq!(
            plan.delegations,
            vec![
                ("valA".to_string(), Uint128::new(130)),
                ("valB".to_string(), Uint128::new(10))
            ]
        );
        assert_eq!(plan.undeployable, Uint128::new(60));
    }

    #[test]
    fn rebalance_pins_blocked_sources_and_routes_around_blocked_pairs() {
        let mut bs = BTreeSet::new();
        bs.insert("valA".to_string()); // in-flight inbound redelegation: cannot give
        let bp = BTreeSet::new();
        let plan = plan_rebalance(
            &[seat("valA", 300, 100), seat("valB", 0, 1000)],
            &[dv("valX", 60)],
            Uint128::zero(),
            &bs,
            &bp,
        );
        // valA is pinned at 300; only valX's 60 moves, all to valB.
        assert_eq!(
            plan.redelegations,
            vec![("valX".into(), "valB".into(), Uint128::new(60))]
        );

        // A blocked (src,dst) route defers that movement entirely when no
        // other destination needs stake.
        let (bs2, mut bp2) = no_blocks();
        bp2.insert(("valX".to_string(), "valB".to_string()));
        let plan = plan_rebalance(
            &[seat("valB", 0, 1000)],
            &[dv("valX", 60)],
            Uint128::zero(),
            &bs2,
            &bp2,
        );
        assert!(plan.redelegations.is_empty()); // deferred, stays staked
    }

    #[test]
    fn rebalance_with_no_eligible_moves_nothing() {
        let (bs, bp) = no_blocks();
        let plan = plan_rebalance(&[], &[dv("valX", 500)], Uint128::new(70), &bs, &bp);
        assert!(plan.redelegations.is_empty());
        assert!(plan.delegations.is_empty());
        assert_eq!(plan.undeployable, Uint128::new(70));
    }

    #[test]
    fn annualized_bps_scales_and_guards() {
        // 1% inflow over a 365-day window = 100 bps.
        assert_eq!(
            annualized_bps(Uint128::new(10_000), Uint128::new(1_000_000), 31_536_000),
            100
        );
        // Same inflow over half the window doubles the rate.
        assert_eq!(
            annualized_bps(Uint128::new(10_000), Uint128::new(1_000_000), 15_768_000),
            200
        );
        assert_eq!(annualized_bps(Uint128::zero(), Uint128::new(1), 100), 0);
        assert_eq!(annualized_bps(Uint128::new(1), Uint128::zero(), 100), 0);
        assert_eq!(annualized_bps(Uint128::new(1), Uint128::new(1), 0), 0);
        // Overflow guard degrades to 0 rather than panicking.
        assert_eq!(annualized_bps(Uint128::MAX, Uint128::new(1), 1), 0);
    }

    #[test]
    fn commission_on_floors() {
        assert_eq!(commission_on(Uint128::new(1000), 1000), Uint128::new(100));
        assert_eq!(commission_on(Uint128::new(999), 1000), Uint128::new(99)); // floor
        assert_eq!(commission_on(Uint128::new(1000), 0), Uint128::zero());
        assert_eq!(commission_on(Uint128::zero(), 1000), Uint128::zero());
    }

    #[test]
    fn plan_unbond_skips_validators_at_entry_capacity() {
        let dels = vec![
            DelegationView {
                valoper: "valA".into(),
                staked: Uint128::new(300),
            },
            DelegationView {
                valoper: "valB".into(),
                staked: Uint128::new(100),
            },
        ];
        let plan = plan_unbond(&dels, Uint128::new(150), &["valA".to_string()]);
        assert_eq!(plan, vec![tgt("valB", 100)]);
    }

    #[test]
    fn plan_service_expedites_only_from_marker_liquid() {
        let dels = vec![DelegationView {
            valoper: "valA".into(),
            staked: Uint128::new(500),
        }];
        // 300 total counts toward coverage (need = 200, so no unbond), but only 50
        // is in the principal marker: nothing may be expedited. The vault EndBlocker
        // pays from the marker; expediting past it forces an unfunded maturity,
        // which refunds (cancels) the user's redemption.
        let plan = plan_service(
            &[(1, Uint128::new(100)), (2, Uint128::new(100))],
            Uint128::new(300),
            Uint128::new(50),
            Uint128::zero(),
            &dels,
            &[],
            0,
        );
        assert!(plan.expedite_ids.is_empty());
        assert!(plan.undelegations.is_empty());
    }

    #[test]
    fn plan_service_expedite_gate_includes_margin() {
        // estimate 1000 at 50 bps needs 1005 in the marker; 1004 is not enough.
        let plan = plan_service(
            &[(1, Uint128::new(1000))],
            Uint128::new(10_000),
            Uint128::new(1004),
            Uint128::zero(),
            &[],
            &[],
            50,
        );
        assert!(plan.expedite_ids.is_empty());
        let plan = plan_service(
            &[(1, Uint128::new(1000))],
            Uint128::new(10_000),
            Uint128::new(1005),
            Uint128::zero(),
            &[],
            &[],
            50,
        );
        assert_eq!(plan.expedite_ids, vec![1]);
    }

    #[test]
    fn plan_service_subtracts_inflight_unbonding_and_adds_margin() {
        let dels = vec![DelegationView {
            valoper: "valA".into(),
            staked: Uint128::new(1000),
        }];
        // need = 1000 * (1 + 100bps) = 1010; cover 200 + 700 already unbonding ->
        // unbond only the 110 increment; never re-unbond what is on its way back.
        let plan = plan_service(
            &[(1, Uint128::new(1000))],
            Uint128::new(200),
            Uint128::new(200),
            Uint128::new(700),
            &dels,
            &[],
            100,
        );
        assert_eq!(plan.undelegations, vec![tgt("valA", 110)]);
        let plan2 = plan_service(
            &[(1, Uint128::new(1000))],
            Uint128::new(200),
            Uint128::new(200),
            Uint128::new(900),
            &dels,
            &[],
            100,
        );
        assert!(plan2.undelegations.is_empty());
    }

    #[test]
    fn plan_return_splits_settle_and_write_down() {
        // nothing out: nothing to do.
        assert_eq!(
            plan_return(
                Uint128::zero(),
                Uint128::zero(),
                Uint128::zero(),
                Uint128::new(100)
            ),
            ReturnPlan {
                settle: Uint128::zero(),
                write_down: Uint128::zero()
            }
        );
        // all matured and backed by returned liquid: settle everything.
        assert_eq!(
            plan_return(
                Uint128::new(1000),
                Uint128::zero(),
                Uint128::zero(),
                Uint128::new(1000)
            ),
            ReturnPlan {
                settle: Uint128::new(1000),
                write_down: Uint128::zero()
            }
        );
        // still unbonding: not matured, nothing moves.
        assert_eq!(
            plan_return(
                Uint128::new(1000),
                Uint128::zero(),
                Uint128::new(1000),
                Uint128::zero()
            ),
            ReturnPlan {
                settle: Uint128::zero(),
                write_down: Uint128::zero()
            }
        );
        // partial: 600 staked + 300 unbonding of 1000 out; liquid 150
        // (100 returned + 50 rewards): settle the 100, deposit the 50 as rewards.
        assert_eq!(
            plan_return(
                Uint128::new(1000),
                Uint128::new(600),
                Uint128::new(300),
                Uint128::new(150)
            ),
            ReturnPlan {
                settle: Uint128::new(100),
                write_down: Uint128::zero()
            }
        );
    }

    #[test]
    fn plan_return_write_down_recognizes_slash_immediately() {
        // 1000 deployed, validator slashed 5%: 950 staked, nothing unbonding.
        // No liquid: the whole 50 is an unbacked write-down THIS epoch.
        assert_eq!(
            plan_return(
                Uint128::new(1000),
                Uint128::new(950),
                Uint128::zero(),
                Uint128::zero()
            ),
            ReturnPlan {
                settle: Uint128::zero(),
                write_down: Uint128::new(50)
            }
        );
        // 30 of rewards on hand: 30 nets through the settlement leg, 20 writes down.
        // Either way settle + write_down == matured: loss recognition never defers.
        assert_eq!(
            plan_return(
                Uint128::new(1000),
                Uint128::new(950),
                Uint128::zero(),
                Uint128::new(30)
            ),
            ReturnPlan {
                settle: Uint128::new(30),
                write_down: Uint128::new(20)
            }
        );
    }
}
