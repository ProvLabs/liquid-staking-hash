use std::collections::BTreeSet;
use std::str::FromStr;

use cosmwasm_std::{
    coin, CosmosMsg, Deps, DepsMut, DistributionMsg, Env, Response, StakingMsg, StdError,
    StdResult, Uint128,
};
use prost::Message;
use provwasm_std::types::cosmos::base::query::v1beta1::PageRequest;
use provwasm_std::types::cosmos::base::v1beta1::Coin as ProstCoin;
use provwasm_std::types::cosmos::staking::v1beta1::StakingQuerier;
use provwasm_std::types::provenance::exchange::v1::{MsgCreatePaymentRequest, Payment};
use provwasm_std::types::provenance::marker::v1::{
    MarkerAccount, MarkerQuerier, MsgBurnRequest, MsgMintRequest, MsgTransferRequest,
};
use provwasm_std::types::provlabs::vault::v1::{
    MsgDepositPrincipalFundsRequest, MsgExpeditePendingSwapOutRequest, MsgPauseVaultRequest,
    MsgUnpauseVaultRequest, PendingSwapOut, VaultQuerier,
};

use crate::plan::{
    fee_reserve, plan_claim, plan_return, plan_service, redemption_need, DelegationView,
    MAX_UNBOND_ENTRIES,
};
use crate::state::{
    update_accum, Config, EpochPhase, EpochSnapshot, CONFIG, EPOCH, EPOCH_ACCUM, EPOCH_INDEX,
    HALTED, LAST_SNAPSHOT, PENDING_DELEGATIONS, PENDING_REDELEGATIONS, RECEIPT_MINTED,
};
use crate::validators::{
    accrue_commission, assess_validators, drain_ranks, enrolled, epoch_rollover, order_for_drain,
};
use crate::vault_ext::{accept_asset_msg, update_vault_nav_msg};
use crate::ContractError;

/// Over-cover margin (bps) on the redemption reserve. Payouts re-price at maturity
/// NAV; with no interest rate the only drift is the deposited-reward step.
pub const REDEMPTION_MARGIN_BPS: u64 = 50;

/// Floor for the deploy-leg liquid buffer, in bps of vault liquid. The primary
/// buffer is the AUM fee reserve (plan::fee_reserve).
pub const DEPLOY_BUFFER_BPS: u128 = 50;

/// x/exchange payment external ids. Unique per source while outstanding; both
/// payments are created and accepted inside the same tx, so the ids are reusable
/// every epoch.
pub const DEPLOY_PAYMENT_ID: &str = "nvhash.deploy";
pub const RETURN_PAYMENT_ID: &str = "nvhash.return";
pub const WRITEDOWN_PAYMENT_ID: &str = "nvhash.writedown";

const PAGE_LIMIT: u64 = 100;

fn page(key: Vec<u8>) -> Option<PageRequest> {
    Some(PageRequest {
        key,
        offset: 0,
        limit: PAGE_LIMIT,
        count_total: false,
        reverse: false,
    })
}

pub(crate) fn assert_not_halted(deps: Deps) -> Result<(), ContractError> {
    if HALTED.may_load(deps.storage)?.unwrap_or(false) {
        return Err(ContractError::Halted {});
    }
    Ok(())
}

/// Total principal currently unbonding (in-flight, not yet matured), plus the
/// validators whose unbonding-entry queue is already at MAX_UNBOND_ENTRIES
/// (planning another Undelegate against them would revert the whole crank).
/// Paginated: truncating this read would re-unbond principal already on its way
/// back.
pub fn unbonding_state(deps: Deps, env: &Env) -> StdResult<(Uint128, Vec<String>)> {
    let sq = StakingQuerier::new(&deps.querier);
    let mut total = Uint128::zero();
    let mut at_capacity = vec![];
    let mut key: Vec<u8> = vec![];
    loop {
        let resp =
            sq.delegator_unbonding_delegations(env.contract.address.to_string(), page(key))?;
        for u in resp.unbonding_responses {
            if u.entries.len() >= MAX_UNBOND_ENTRIES {
                at_capacity.push(u.validator_address.clone());
            }
            for e in u.entries {
                total += Uint128::from_str(&e.balance).map_err(|_| {
                    StdError::generic_err(format!("bad unbonding balance: {}", e.balance))
                })?;
            }
        }
        key = resp
            .pagination
            .and_then(|p| p.next_key)
            .unwrap_or_default();
        if key.is_empty() {
            break;
        }
    }
    Ok((total, at_capacity))
}

/// The contract's active redelegations, reduced to the rebalance constraints
/// (RC1 §9.3): validators that are DESTINATIONS of in-flight entries cannot be
/// redelegated FROM (the no-transitive-redelegation rule), and (src, dst)
/// routes already at MAX_UNBOND_ENTRIES cannot carry another entry. Paginated:
/// a truncated read could emit a move the chain rejects, reverting the crank.
pub fn redelegation_state(
    deps: Deps,
    env: &Env,
) -> StdResult<(BTreeSet<String>, BTreeSet<(String, String)>)> {
    let sq = StakingQuerier::new(&deps.querier);
    let mut blocked_sources = BTreeSet::new();
    let mut blocked_pairs = BTreeSet::new();
    let mut key: Vec<u8> = vec![];
    loop {
        let resp = sq.redelegations(
            env.contract.address.to_string(),
            String::new(),
            String::new(),
            page(key),
        )?;
        for r in resp.redelegation_responses {
            let Some(red) = r.redelegation else { continue };
            if r.entries.is_empty() {
                continue;
            }
            blocked_sources.insert(red.validator_dst_address.clone());
            if r.entries.len() >= MAX_UNBOND_ENTRIES {
                blocked_pairs.insert((red.validator_src_address, red.validator_dst_address));
            }
        }
        key = resp
            .pagination
            .and_then(|p| p.next_key)
            .unwrap_or_default();
        if key.is_empty() {
            break;
        }
    }
    Ok((blocked_sources, blocked_pairs))
}

/// (liquid nhash in the vault's principal marker, total vault value, total
/// shares). With underlying = nhash both values are natively nhash; the receipt
/// held in the marker is valued into TVV through the vault's internal NAV walk
/// at its seeded 1:1.
pub fn vault_snapshot(deps: Deps, cfg: &Config) -> StdResult<(Uint128, Uint128, Uint128)> {
    let vq = VaultQuerier::new(&deps.querier);
    let resp = vq.vault(cfg.vault_address.to_string())?;
    let liquid = resp
        .principal
        .and_then(|p| {
            p.coins
                .into_iter()
                .find(|c| c.denom == cfg.underlying_denom)
                .map(|c| c.amount)
        })
        .unwrap_or_default();
    let tvv = resp
        .total_vault_value
        .map(|c| c.amount)
        .unwrap_or_default();
    let shares = resp
        .vault
        .and_then(|v| v.total_shares)
        .map(|c| c.amount)
        .unwrap_or_default();
    // unwrap_or_default here (unlike unbonding_state's map_err-to-error): an absent
    // coin in the SDK response legitimately means a zero balance, not malformed data.
    Ok((
        Uint128::from_str(&liquid).unwrap_or_default(),
        Uint128::from_str(&tvv).unwrap_or_default(),
        Uint128::from_str(&shares).unwrap_or_default(),
    ))
}

/// The receipt marker's own account address. Marker burn only burns coin held BY
/// the marker account, so the burn leg must first transfer the receipt there.
fn receipt_marker_address(deps: Deps, cfg: &Config) -> StdResult<String> {
    let resp = MarkerQuerier::new(&deps.querier).marker(cfg.receipt_denom.clone())?;
    let any = resp
        .marker
        .ok_or_else(|| StdError::generic_err("receipt marker not found"))?;
    let acct = MarkerAccount::decode(any.value.as_slice())
        .map_err(|e| StdError::generic_err(format!("bad marker account: {e}")))?;
    acct.base_account
        .map(|b| b.address)
        .ok_or_else(|| StdError::generic_err("marker account missing base account"))
}

/// Estimate the nhash a pending swap-out will pay, via the vault's EstimateSwapOut.
fn estimate_redeem_nhash(deps: Deps, cfg: &Config, p: &PendingSwapOut) -> StdResult<Uint128> {
    let shares = p
        .shares
        .as_ref()
        .map(|c| c.amount.clone())
        .unwrap_or_default();
    if shares.is_empty() || shares == "0" {
        return Ok(Uint128::zero());
    }
    let vq = VaultQuerier::new(&deps.querier);
    let resp = vq.estimate_swap_out(
        cfg.vault_address.to_string(),
        shares,
        cfg.underlying_denom.clone(),
    )?;
    let amt = resp.assets.map(|c| c.amount).unwrap_or_default();
    // Same reasoning as vault_snapshot: an absent assets coin means zero payout,
    // not a malformed response, so unwrap_or_default (not an error) is intentional.
    Ok(Uint128::from_str(&amt).unwrap_or_default())
}

/// Pending swap-outs with estimated payout needs. In Design C the only accepted
/// denom is nhash, so every redemption is nhash; the denom filter is belt-and-braces
/// (empty = the module default, which is also nhash here). Paginated: a truncated
/// read under-reserves and lets later requests mature unfunded (refund = cancelled
/// redemption).
pub fn pending_redemptions(deps: Deps, cfg: &Config) -> StdResult<Vec<(u64, Uint128)>> {
    let vq = VaultQuerier::new(&deps.querier);
    let mut out = vec![];
    let mut key: Vec<u8> = vec![];
    loop {
        let resp = vq.vault_pending_swap_outs(cfg.vault_address.to_string(), page(key))?;
        for e in resp.pending_swap_outs {
            if let Some(p) = e.pending_swap_out {
                if p.redeem_denom == cfg.underlying_denom || p.redeem_denom.is_empty() {
                    let est = estimate_redeem_nhash(deps, cfg, &p)?;
                    out.push((e.request_id, est));
                }
            }
        }
        key = resp
            .pagination
            .and_then(|p| p.next_key)
            .unwrap_or_default();
        if key.is_empty() {
            break;
        }
    }
    Ok(out)
}

/// Delegations the contract holds in the underlying denom.
pub fn delegations(deps: Deps, env: &Env, denom: &str) -> StdResult<Vec<DelegationView>> {
    let all = deps
        .querier
        .query_all_delegations(env.contract.address.to_string())?;
    Ok(all
        .into_iter()
        .filter(|d| d.amount.denom == denom)
        .map(|d| DelegationView {
            valoper: d.validator,
            staked: d.amount.amount,
        })
        .collect())
}

/// Claimable rewards per validator in the underlying denom (floored from the
/// distribution module's decimal amounts). This is exactly what a
/// WithdrawDelegatorReward will pay in the same block, so it doubles as the
/// program-commission accrual base (RC1 §10.1: the contract IS the delegator,
/// so its claims are precisely the rewards earned on program delegations).
pub fn rewards_by_validator(deps: Deps, env: &Env, denom: &str) -> StdResult<Vec<(String, Uint128)>> {
    let total = deps
        .querier
        .query_delegation_total_rewards(env.contract.address.to_string())?;
    Ok(total
        .rewards
        .into_iter()
        .filter_map(|r| {
            let amount = r
                .reward
                .iter()
                .find(|c| c.denom == denom)
                .map(|c| Uint128::try_from(c.amount.to_uint_floor()).unwrap_or(Uint128::MAX))
                .unwrap_or_default();
            (!amount.is_zero()).then_some((r.validator_address, amount))
        })
        .collect())
}

/// Claim ordering: enrolled validators (deterministic order) first, then
/// unregistered-but-still-delegated validators (sorted).
pub fn claim_order(rewards: &[(String, Uint128)], enrolled_valopers: &[String]) -> Vec<String> {
    let with: Vec<String> = rewards.iter().map(|(v, _)| v.clone()).collect();
    plan_claim(enrolled_valopers, &with)
}

fn enrolled_valopers(deps: Deps) -> StdResult<Vec<String>> {
    Ok(enrolled(deps.storage)?.into_iter().map(|(v, _)| v).collect())
}

/// Phase A alone: withdraw accrued staking rewards for every delegated validator
/// that has any (including unregistered validators, so nothing strands), and
/// accrue program commission on what is claimed. Keepers should call this in a
/// tx BEFORE RunEpoch so the epoch's reward deposit includes the current
/// epoch's rewards (rewards claimed inside RunEpoch itself land after that
/// crank's state reads and deposit at the next epoch).
pub fn claim_rewards(deps: DepsMut, env: &Env) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let rewards = rewards_by_validator(deps.as_ref(), env, &cfg.underlying_denom)?;
    accrue_commission(deps.storage, &rewards, cfg.commission_bps)?;
    let claimed_total: Uint128 = rewards.iter().map(|(_, a)| *a).sum();
    update_accum(deps.storage, |a| a.rewards_claimed += claimed_total)?;
    let claim = claim_order(&rewards, &enrolled_valopers(deps.as_ref())?);
    let n = claim.len();
    let msgs: Vec<DistributionMsg> = claim
        .into_iter()
        .map(|validator| DistributionMsg::WithdrawDelegatorReward { validator })
        .collect();
    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "claim_rewards")
        .add_attribute("claimed_validators", n.to_string()))
}

/// Phases B + D2 alone: unbond in drain-priority order (unenrolled, then
/// ineligible, then eligible by ascending TIP/uptime priority — RC1 §8/§10.2)
/// to cover queued swap-outs, and expedite requests already funded BY THE
/// PRINCIPAL MARKER. Contract-held liquid counts toward coverage (it lands in
/// the marker at the next epoch's return settlement / reward deposit) but never
/// toward expedites — and nhash already earmarked for a pending (chunked)
/// delegation continuation is excluded entirely, since the continuation will
/// delegate it away. Undelegation auto-withdraws pending rewards, so program
/// commission is accrued here for the drained validators.
pub fn service_redemptions(deps: DepsMut, env: &Env) -> Result<Response, ContractError> {
    assert_not_halted(deps.as_ref())?;
    let cfg = CONFIG.load(deps.storage)?;
    let (plan, rewards) = {
        let d = deps.as_ref();
        let liquid = d
            .querier
            .query_balance(env.contract.address.to_string(), &cfg.underlying_denom)?
            .amount;
        let earmarked: Uint128 = PENDING_DELEGATIONS
            .may_load(d.storage)?
            .unwrap_or_default()
            .iter()
            .map(|(_, a)| *a)
            .fold(Uint128::zero(), |s, a| s + a);
        let liquid = liquid.saturating_sub(earmarked);
        let dels = delegations(d, env, &cfg.underlying_denom)?;
        let ranks = drain_ranks(&assess_validators(d, &cfg)?);
        let dels = order_for_drain(dels, &ranks);
        let (unbonding, at_capacity) = unbonding_state(d, env)?;
        let (vault_liquid, _tvv, _shares) = vault_snapshot(d, &cfg)?;
        let pending = pending_redemptions(d, &cfg)?;
        let rewards = rewards_by_validator(d, env, &cfg.underlying_denom)?;
        let plan = plan_service(
            &pending,
            vault_liquid + liquid,
            vault_liquid,
            unbonding,
            &dels,
            &at_capacity,
            REDEMPTION_MARGIN_BPS,
        );
        (plan, rewards)
    };

    // Undelegate auto-withdraws the validator's pending rewards: charge
    // commission on them now or they escape the accrual base, and fold them
    // plus the unbond/expedite activity into the epoch analytics (§9.10).
    let drained: Vec<(String, Uint128)> = rewards
        .into_iter()
        .filter(|(v, _)| plan.undelegations.iter().any(|(uv, _)| uv == v))
        .collect();
    accrue_commission(deps.storage, &drained, cfg.commission_bps)?;
    let drained_rewards: Uint128 = drained.iter().map(|(_, a)| *a).sum();
    let unbonded: Uint128 = plan.undelegations.iter().map(|(_, a)| *a).sum();
    let expedited = plan.expedite_ids.len() as u32;
    update_accum(deps.storage, |a| {
        a.rewards_claimed += drained_rewards;
        a.unbonded_for_redemptions += unbonded;
        a.redemptions_expedited += expedited;
    })?;

    let mut msgs: Vec<CosmosMsg> = vec![];
    for (validator, amount) in plan.undelegations {
        msgs.push(
            StakingMsg::Undelegate {
                validator,
                amount: coin(amount.u128(), &cfg.underlying_denom),
            }
            .into(),
        );
    }
    for request_id in plan.expedite_ids {
        msgs.push(
            MsgExpeditePendingSwapOutRequest {
                authority: env.contract.address.to_string(),
                request_id,
            }
            .into(),
        );
    }
    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "service_redemptions"))
}

fn prost_coin(denom: &str, amount: Uint128) -> ProstCoin {
    ProstCoin {
        denom: denom.to_string(),
        amount: amount.to_string(),
    }
}

/// Build the create-payment message for a settlement with the vault: the contract
/// (source) offers `source_amount` in exchange for `target_amount` from the vault
/// (target). Accepted in the same tx via vault_ext::accept_asset_msg under the
/// contract's asset-manager authority. [VERIFY] payment target account (vault
/// address vs principal marker address) together with the vault_ext shim.
fn create_payment_msg(
    env: &Env,
    cfg: &Config,
    source_amount: Vec<ProstCoin>,
    target_amount: Vec<ProstCoin>,
    external_id: &str,
) -> CosmosMsg {
    MsgCreatePaymentRequest {
        payment: Some(Payment {
            source: env.contract.address.to_string(),
            source_amount,
            target: cfg.vault_address.to_string(),
            target_amount,
            external_id: external_id.to_string(),
        }),
    }
    .into()
}

/// The full epoch crank. One transaction end to end: a failure anywhere (including
/// a settlement leg) reverts messages and state together, so the vault cannot be
/// left paused, no payment survives half-settled, and the receipt counter cannot
/// desynchronize from the messages that justify it.
pub fn run_epoch(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    assert_not_halted(deps.as_ref())?;
    let cfg = CONFIG.load(deps.storage)?;

    // Continuation crank: a prior crank left unexecuted rebalance moves or
    // undelegated deploy targets (gas chunking); drain the next chunk.
    // Bypasses the min-interval guard (epoch in progress).
    let pending_redel = PENDING_REDELEGATIONS.may_load(deps.storage)?.unwrap_or_default();
    let pending_targets = PENDING_DELEGATIONS.may_load(deps.storage)?.unwrap_or_default();
    if !pending_redel.is_empty() || !pending_targets.is_empty() {
        return continue_epoch(deps, env, &cfg, pending_redel, pending_targets);
    }

    let mut epoch = EPOCH.load(deps.storage)?;
    let receipt_minted = RECEIPT_MINTED.load(deps.storage)?;

    // Calendar-month rollover gate (liquid-staking-spec §9): the epoch may end
    // once block time is in a strictly later civil (year, month) than the last
    // run. The boundary is a deterministic function of consensus block time, not
    // of who cranks or how long since last_run — no caller can pick the epoch's
    // duration through this permissionless entrypoint. Immediately after a run
    // last_run is in the current month, so the predicate rejects any further run
    // until the next rollover: double-run is structurally impossible.
    if crate::month::year_month(env.block.time) <= crate::month::year_month(epoch.last_run) {
        let next = crate::month::first_of_next_month_secs(epoch.last_run);
        return Err(ContractError::TooSoon { next });
    }

    // Phase A basis: the per-validator claimable rewards this crank will
    // withdraw. Program commission accrues on them up front (mutates storage,
    // so it runs before the read-only planning block below).
    let rewards = rewards_by_validator(deps.as_ref(), &env, &cfg.underlying_denom)?;
    accrue_commission(deps.storage, &rewards, cfg.commission_bps)?;

    let mut msgs: Vec<CosmosMsg> = vec![];
    let redelegate_rest: Vec<(String, String, Uint128)>;
    let delegate_rest: Vec<(String, Uint128)>;
    let burned: Uint128;
    // Hoisted out of the block below so Phase E's receipt-counter delta reuses the
    // same value the mint message and the rebalance plan were sized from, rather
    // than re-deriving it on a second path.
    let deployable: Uint128;
    // Crank measurements for the §9.10 snapshot, assembled inside the planning
    // block from the same values the messages were built from.
    struct CrankStats {
        tvv_before: Uint128,
        total_shares: Uint128,
        eligible_count: u32,
        service_unbonded: Uint128,
        expedited: u32,
        settled: Uint128,
        write_down: Uint128,
        rewards_deposited: Uint128,
        rebalanced: Uint128,
    }
    let stats: CrankStats;
    {
        let d = deps.as_ref();

        // Live eligibility + concentration headroom for every enrolled validator
        // (RC1 §9.7/§10.3/§10.1 arrears). Assessments arrive priority-sorted
        // (TIP desc, uptime desc): rebalance seats take that order, so the
        // highest-priority validators absorb the largest-remainder units and
        // any cap-blocked residual; the drain order is its reverse.
        let enrolled_list = enrolled_valopers(d)?;
        let assessments = assess_validators(d, &cfg)?;
        let ranks = drain_ranks(&assessments);
        let eligible_rooms: Vec<(String, Uint128)> = assessments
            .into_iter()
            .filter(|a| a.eligible)
            .map(|a| (a.valoper, a.headroom))
            .collect();
        let eligible_set: BTreeSet<String> =
            eligible_rooms.iter().map(|(v, _)| v.clone()).collect();

        // Phase A: claim rewards from every delegated validator with any.
        for validator in claim_order(&rewards, &enrolled_list) {
            msgs.push(DistributionMsg::WithdrawDelegatorReward { validator }.into());
        }

        // Gather state. Contract liquid = claimed rewards swept by earlier cranks +
        // matured unbondings.
        let liquid = d
            .querier
            .query_balance(env.contract.address.to_string(), &cfg.underlying_denom)?
            .amount;
        let dels = delegations(d, &env, &cfg.underlying_denom)?;
        let staked: Uint128 = dels
            .iter()
            .map(|x| x.staked)
            .fold(Uint128::zero(), |s, a| s + a);
        let (unbonding, at_capacity) = unbonding_state(d, &env)?;
        let (blocked_sources, blocked_pairs) = redelegation_state(d, &env)?;
        let pending = pending_redemptions(d, &cfg)?;
        let (vault_liquid, tvv, total_shares) = vault_snapshot(d, &cfg)?;

        // Redemption reserve: payout estimates + margin.
        let need = redemption_need(&pending, REDEMPTION_MARGIN_BPS);

        // Fresh-deploy budget: surplus beyond the redemption reserve and the
        // fee buffer. Reserving the same `need` the service leg targets means
        // redemption funds are never staked out from under a pending swap-out.
        let budget = if eligible_rooms.is_empty() {
            Uint128::zero()
        } else {
            // Two nominal epochs of AUM-fee accrual (~30-day months); the epoch
            // cadence is calendar-month, so this uses the nominal-month constant
            // rather than the retired min_run_interval_secs.
            let horizon = crate::month::NOMINAL_EPOCH_SECS.saturating_mul(2);
            let buffer = fee_reserve(tvv, cfg.aum_fee_bps, horizon)
                .max(vault_liquid.multiply_ratio(DEPLOY_BUFFER_BPS, 10_000u128));
            vault_liquid.saturating_sub(need + buffer)
        };

        // Marker liquid once this run's moves land: settle + reward deposit
        // flow in, at most `budget` flows out (the rebalance may deploy less
        // when concentration caps bind, leaving MORE liquid than assumed, so
        // gating expedites on the budget is the conservative side of F1).
        let marker_after = (vault_liquid + liquid).saturating_sub(budget);

        // Phase B: service redemptions (unbond only the increment), walking
        // ALL delegations in drain-priority order: unenrolled first, then
        // ineligible, then eligible by ascending TIP/uptime priority.
        let dels_for_service = order_for_drain(dels.clone(), &ranks);
        let plan = plan_service(
            &pending,
            vault_liquid + liquid,
            marker_after,
            unbonding,
            &dels_for_service,
            &at_capacity,
            REDEMPTION_MARGIN_BPS,
        );
        let service_unbonded: Uint128 = plan.undelegations.iter().map(|(_, a)| *a).sum();
        let expedited = plan.expedite_ids.len() as u32;
        // Post-unbond stake view: what the uniform-slot rebalance operates on
        // (the undelegate messages below execute before the redelegations).
        let mut post_unbond: std::collections::BTreeMap<String, Uint128> =
            dels.iter().map(|v| (v.valoper.clone(), v.staked)).collect();
        for (validator, amount) in &plan.undelegations {
            if let Some(s) = post_unbond.get_mut(validator) {
                *s = s.saturating_sub(*amount);
            }
        }
        for (validator, amount) in plan.undelegations {
            msgs.push(
                StakingMsg::Undelegate {
                    validator,
                    amount: coin(amount.u128(), &cfg.underlying_denom),
                }
                .into(),
            );
        }

        // Uniform-slot rebalance (RC1 §9.2/§9.3/§9.4): every eligible seat
        // levels toward the same slot via redelegations (stake on unregistered
        // or ineligible validators is redirected, never unbonded) plus fresh
        // liquidity; the concentration-capped residual stays liquid.
        let seats: Vec<crate::plan::RebalanceSeat> = eligible_rooms
            .iter()
            .map(|(v, headroom)| crate::plan::RebalanceSeat {
                valoper: v.clone(),
                current: post_unbond.get(v).copied().unwrap_or_default(),
                add_headroom: *headroom,
            })
            .collect();
        let others: Vec<DelegationView> = post_unbond
            .iter()
            .filter(|(v, s)| !eligible_set.contains(*v) && !s.is_zero())
            .map(|(v, s)| DelegationView { valoper: v.clone(), staked: *s })
            .collect();
        let rebalance = crate::plan::plan_rebalance(
            &seats,
            &others,
            budget,
            &blocked_sources,
            &blocked_pairs,
        );
        deployable = budget.saturating_sub(rebalance.undeployable);
        let rebalanced_total: Uint128 =
            rebalance.redelegations.iter().map(|(_, _, a)| *a).sum();

        // Return plan: settle the backed portion, write down the slashed portion.
        let ret = plan_return(receipt_minted, staked, unbonding, liquid);
        let rewards_dep = liquid.saturating_sub(ret.settle);

        // Return settlement (unpaused): contract pays `settle` nhash, the vault
        // pays back `settle` receipt at the 1:1 internal NAV.
        if !ret.settle.is_zero() {
            msgs.push(create_payment_msg(
                &env,
                &cfg,
                vec![prost_coin(&cfg.underlying_denom, ret.settle)],
                vec![prost_coin(&cfg.receipt_denom, ret.settle)],
                RETURN_PAYMENT_ID,
            ));
            msgs.push(accept_asset_msg(
                env.contract.address.as_str(),
                cfg.vault_address.as_str(),
                env.contract.address.as_str(),
                RETURN_PAYMENT_ID,
            ));
        }

        // Slash write-down (unpaused): the vault rejects WithdrawPrincipalFunds
        // of a non-accepted denom (verified on devnet 2026-07-09), so the D5
        // markdown runs as a GUARDRAIL SANDWICH under the contract's NAV
        // authority (rotated in at bootstrap via update-nav-authority):
        //   1. set the receipt's internal NAV to 0 nhash per write_down units
        //      (zero price is valid for a non-accepted denom),
        //   2. settle exactly write_down receipt OUT via a zero-priced payment
        //      (guardrail: write_down x 0 == 0 x write_down), dropping TVV by
        //      the unbacked amount THIS epoch,
        //   3. restore the 1:1 entry so every later settlement leg still prices
        //      exactly at par.
        // A fractional markdown instead of the sandwich would poison future
        // legs: the guardrail is exact cross-multiplication against the entry.
        if !ret.write_down.is_zero() {
            msgs.push(update_vault_nav_msg(
                env.contract.address.as_str(),
                cfg.vault_address.as_str(),
                &cfg.receipt_denom,
                &cfg.underlying_denom,
                0,
                ret.write_down.u128(),
                "nvhash-writedown",
            ));
            msgs.push(create_payment_msg(
                &env,
                &cfg,
                vec![],
                vec![prost_coin(&cfg.receipt_denom, ret.write_down)],
                WRITEDOWN_PAYMENT_ID,
            ));
            msgs.push(accept_asset_msg(
                env.contract.address.as_str(),
                cfg.vault_address.as_str(),
                env.contract.address.as_str(),
                WRITEDOWN_PAYMENT_ID,
            ));
            msgs.push(update_vault_nav_msg(
                env.contract.address.as_str(),
                cfg.vault_address.as_str(),
                &cfg.receipt_denom,
                &cfg.underlying_denom,
                1,
                1,
                "nvhash-writedown-restore",
            ));
        }

        // Phase C: atomic pause window, the reward deposit ONLY (pause, deposit,
        // unpause in one bundle; partial failure reverts the whole tx).
        if !rewards_dep.is_zero() {
            msgs.push(
                MsgPauseVaultRequest {
                    authority: env.contract.address.to_string(),
                    vault_address: cfg.vault_address.to_string(),
                    reason: "epoch".to_string(),
                }
                .into(),
            );
            // The NAV step-up: pure value in, no counter-leg.
            msgs.push(
                MsgDepositPrincipalFundsRequest {
                    authority: env.contract.address.to_string(),
                    vault_address: cfg.vault_address.to_string(),
                    amount: Some(prost_coin(&cfg.underlying_denom, rewards_dep)),
                }
                .into(),
            );
            msgs.push(
                MsgUnpauseVaultRequest {
                    authority: env.contract.address.to_string(),
                    vault_address: cfg.vault_address.to_string(),
                }
                .into(),
            );
        }

        // Burn everything returned or written down (outside pause, same tx).
        // Marker burn only burns coin held by the marker account itself, so the
        // receipt (settlement proceeds + write-down, both in the contract's
        // balance by this point in the message sequence) is first transferred
        // into the receipt marker account. Requires the contract to hold
        // Transfer access on the restricted receipt marker (bootstrap grant).
        burned = ret.settle + ret.write_down;
        if !burned.is_zero() {
            let marker_addr = receipt_marker_address(d, &cfg)?;
            msgs.push(
                MsgTransferRequest {
                    amount: Some(prost_coin(&cfg.receipt_denom, burned)),
                    administrator: env.contract.address.to_string(),
                    from_address: env.contract.address.to_string(),
                    to_address: marker_addr,
                }
                .into(),
            );
            msgs.push(
                MsgBurnRequest {
                    amount: Some(prost_coin(&cfg.receipt_denom, burned)),
                    administrator: env.contract.address.to_string(),
                }
                .into(),
            );
        }

        // Deploy settlement (unpaused): mint receipt, swap it into the marker for
        // the surplus nhash, then delegate.
        if !deployable.is_zero() {
            msgs.push(
                MsgMintRequest {
                    amount: Some(prost_coin(&cfg.receipt_denom, deployable)),
                    administrator: env.contract.address.to_string(),
                    recipient: env.contract.address.to_string(),
                }
                .into(),
            );
            msgs.push(create_payment_msg(
                &env,
                &cfg,
                vec![prost_coin(&cfg.receipt_denom, deployable)],
                vec![prost_coin(&cfg.underlying_denom, deployable)],
                DEPLOY_PAYMENT_ID,
            ));
            msgs.push(accept_asset_msg(
                env.contract.address.as_str(),
                cfg.vault_address.as_str(),
                env.contract.address.as_str(),
                DEPLOY_PAYMENT_ID,
            ));
        }

        // Phase D1: execute rebalance moves under the shared per-crank gas
        // budget: redelegations first, then fresh delegations; remainders
        // carry to continuation cranks (single-EPOCH convergence, §9.3).
        let (redel_now, redel_later, deleg_now, deleg_later) = chunk_moves(
            rebalance.redelegations,
            rebalance.delegations,
            cfg.max_delegations_per_run as usize,
        );
        redelegate_rest = redel_later;
        delegate_rest = deleg_later;
        for (src, dst, amount) in redel_now {
            msgs.push(
                StakingMsg::Redelegate {
                    src_validator: src,
                    dst_validator: dst,
                    amount: coin(amount.u128(), &cfg.underlying_denom),
                }
                .into(),
            );
        }
        for (validator, amount) in deleg_now {
            msgs.push(
                StakingMsg::Delegate {
                    validator,
                    amount: coin(amount.u128(), &cfg.underlying_denom),
                }
                .into(),
            );
        }

        // Phase D2: expedite funded redemptions.
        for request_id in plan.expedite_ids {
            msgs.push(
                MsgExpeditePendingSwapOutRequest {
                    authority: env.contract.address.to_string(),
                    request_id,
                }
                .into(),
            );
        }

        stats = CrankStats {
            tvv_before: tvv,
            total_shares,
            eligible_count: eligible_rooms.len() as u32,
            service_unbonded,
            expedited,
            settled: ret.settle,
            write_down: ret.write_down,
            rewards_deposited: rewards_dep,
            rebalanced: rebalanced_total,
        };
    }

    // Phase E: persist. The receipt invariant moves by what was minted in
    // (deployable, the same value the mint message and the deploy plan used) minus
    // what was settled out or written down.
    if deployable != burned {
        RECEIPT_MINTED.save(deps.storage, &(receipt_minted + deployable - burned))?;
    }

    // §9.10 snapshot: fold the window accumulators with this crank's exact
    // legs, then start a fresh window. tvv_after is exact by construction in
    // the single-tx engine: settlements and deploys are value-neutral, so only
    // the reward deposit (up) and write-down (down) move TVV this crank.
    let crank_claimed: Uint128 = rewards.iter().map(|(_, a)| *a).sum();
    let mut accum = EPOCH_ACCUM.may_load(deps.storage)?.unwrap_or_default();
    accum.rewards_claimed += crank_claimed;
    accum.unbonded_for_redemptions += stats.service_unbonded;
    accum.redemptions_expedited += stats.expedited;
    let prev = LAST_SNAPSHOT.may_load(deps.storage)?;
    let epoch_index = EPOCH_INDEX.may_load(deps.storage)?.unwrap_or(0) + 1;
    let started_at = prev.as_ref().map(|p| p.ended_at_seconds).unwrap_or(0);
    let now = env.block.time.seconds();
    let window = if started_at == 0 { 0 } else { now.saturating_sub(started_at) };
    let net_deposits = prev
        .as_ref()
        .map(|p| {
            let before = i128::try_from(stats.tvv_before.u128()).unwrap_or(i128::MAX);
            let after = i128::try_from(p.tvv_after.u128()).unwrap_or(i128::MAX);
            cosmwasm_std::Int128::new(before.saturating_sub(after))
        })
        .unwrap_or_else(cosmwasm_std::Int128::zero);
    LAST_SNAPSHOT.save(
        deps.storage,
        &EpochSnapshot {
            epoch_index,
            started_at_seconds: started_at,
            ended_at_seconds: now,
            end_height: env.block.height,
            tvv_before: stats.tvv_before,
            tvv_after: (stats.tvv_before + stats.rewards_deposited)
                .saturating_sub(stats.write_down),
            total_shares: stats.total_shares,
            rewards_claimed: accum.rewards_claimed,
            commission_received: accum.commission_received,
            tips_received: accum.tips_received,
            rewards_deposited: stats.rewards_deposited,
            settled: stats.settled,
            write_down: stats.write_down,
            deployed: deployable,
            rebalanced: stats.rebalanced,
            unbonded_for_redemptions: accum.unbonded_for_redemptions,
            redemptions_expedited: accum.redemptions_expedited,
            validators_purged: accum.validators_purged,
            eligible_count: stats.eligible_count,
            aum_fee_estimate: fee_reserve(stats.tvv_before, cfg.aum_fee_bps, window),
            net_deposits,
        },
    )?;
    EPOCH_INDEX.save(deps.storage, &epoch_index)?;
    EPOCH_ACCUM.save(deps.storage, &Default::default())?;
    PENDING_REDELEGATIONS.save(deps.storage, &redelegate_rest)?;
    PENDING_DELEGATIONS.save(deps.storage, &delegate_rest)?;
    if redelegate_rest.is_empty() && delegate_rest.is_empty() {
        epoch.last_run = env.block.time;
        epoch.phase = EpochPhase::Idle;
        // Epoch rollover: per-epoch uptime accumulators start fresh (§10.4).
        epoch_rollover(deps.storage)?;
    } else {
        epoch.phase = EpochPhase::Releasing;
    }
    EPOCH.save(deps.storage, &epoch)?;

    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "run_epoch"))
}

/// Split the crank's rebalance moves under a shared budget (0 = unlimited):
/// redelegations execute first; delegations run only in cranks with budget to
/// spare after them.
#[allow(clippy::type_complexity)]
fn chunk_moves(
    mut redelegations: Vec<(String, String, Uint128)>,
    mut delegations: Vec<(String, Uint128)>,
    max: usize,
) -> (
    Vec<(String, String, Uint128)>,
    Vec<(String, String, Uint128)>,
    Vec<(String, Uint128)>,
    Vec<(String, Uint128)>,
) {
    if max == 0 {
        return (redelegations, vec![], delegations, vec![]);
    }
    let redel_rest = if redelegations.len() > max {
        redelegations.split_off(max)
    } else {
        vec![]
    };
    let budget = max - redelegations.len();
    let (deleg_now, deleg_rest) = if !redel_rest.is_empty() || budget == 0 {
        (vec![], delegations)
    } else if delegations.len() > budget {
        let rest = delegations.split_off(budget);
        (delegations, rest)
    } else {
        (delegations, vec![])
    };
    (redelegations, redel_rest, deleg_now, deleg_rest)
}

/// Continuation crank: execute the next chunk of pending rebalance moves
/// (redelegations first, then fresh delegations). Completes the epoch
/// (advances last_run) once both queues drain. If a move is invalid and this
/// reverts forever, the admin escape hatch is ClearPendingDelegations, which
/// drops both queues: dropped redelegations simply leave stake where it is.
fn continue_epoch(
    deps: DepsMut,
    env: Env,
    cfg: &Config,
    pending_redel: Vec<(String, String, Uint128)>,
    pending_deleg: Vec<(String, Uint128)>,
) -> Result<Response, ContractError> {
    let (redel_now, redel_rest, deleg_now, deleg_rest) = chunk_moves(
        pending_redel,
        pending_deleg,
        cfg.max_delegations_per_run as usize,
    );
    let mut msgs: Vec<CosmosMsg> = vec![];
    for (src, dst, amount) in redel_now {
        msgs.push(
            StakingMsg::Redelegate {
                src_validator: src,
                dst_validator: dst,
                amount: coin(amount.u128(), &cfg.underlying_denom),
            }
            .into(),
        );
    }
    for (validator, amount) in deleg_now {
        msgs.push(
            StakingMsg::Delegate {
                validator,
                amount: coin(amount.u128(), &cfg.underlying_denom),
            }
            .into(),
        );
    }
    PENDING_REDELEGATIONS.save(deps.storage, &redel_rest)?;
    PENDING_DELEGATIONS.save(deps.storage, &deleg_rest)?;
    if redel_rest.is_empty() && deleg_rest.is_empty() {
        let mut epoch = EPOCH.load(deps.storage)?;
        epoch.last_run = env.block.time;
        epoch.phase = EpochPhase::Idle;
        EPOCH.save(deps.storage, &epoch)?;
        epoch_rollover(deps.storage)?;
    }
    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "run_epoch_continue"))
}

/// Message-sequence lock for `run_epoch` (IMPLEMENTATION-STATUS §4): the epoch's
/// safety story depends on ORDER — the return settlement runs unpaused BEFORE the
/// pause window, the reward deposit happens strictly INSIDE pause/unpause, the
/// receipt burn (transfer-then-burn) runs after unpause, and the fresh deploy +
/// delegations come last. These tests execute the real `run_epoch` against a fully
/// mocked querier and assert the emitted message list, so a refactor cannot
/// silently reorder legs.
#[cfg(test)]
mod sequence_tests {
    use super::*;
    use cosmwasm_std::testing::{message_info, mock_env};
    use cosmwasm_std::{
        Addr, Binary, Coin as CwCoin, ContractResult, DecCoin, Decimal256, FullDelegation,
        SystemResult, Timestamp, Validator as CwValidator,
    };
    use provwasm_common::MockableQuerier;
    use provwasm_mocks::{mock_provenance_dependencies, MockProvenanceQuerier};
    use provwasm_std::types::cosmos::auth::v1beta1::BaseAccount;
    use provwasm_std::types::cosmos::slashing::v1beta1::{
        Params as SlashingParams, QueryParamsResponse as SlashingParamsResponse,
    };
    use provwasm_std::types::cosmos::staking::v1beta1::{
        BondStatus, Pool, QueryDelegatorUnbondingDelegationsResponse, QueryPoolResponse,
        QueryRedelegationsResponse, QueryValidatorsResponse, Validator as PValidator,
    };
    use provwasm_std::types::provenance::marker::v1::QueryMarkerResponse;
    use provwasm_std::types::provlabs::vault::v1::{
        AccountBalance, QueryVaultPendingSwapOutsResponse, QueryVaultResponse, VaultAccount,
    };
    use provwasm_std::types::cosmos::base::v1beta1::Coin as PbCoin;

    use crate::msg::InstantiateMsg;
    use crate::state::{ValidatorRecord, VALIDATORS};
    use crate::vault_ext::{ACCEPT_ASSET_TYPE_URL, UPDATE_VAULT_NAV_TYPE_URL};

    const VALOPER: &str = "tpvaloper1seq0000000000000000000000000000000000";

    /// Register a protobuf-encoded response for a gRPC query path, wrapped in
    /// the ABCI ResponseQuery envelope the generated queriers decode.
    fn grpc<R: prost::Message>(q: &mut MockProvenanceQuerier, path: &str, resp: &R) {
        let bytes = provwasm_std::types::tendermint::abci::ResponseQuery {
            value: resp.encode_to_vec(),
            ..Default::default()
        }
        .encode_to_vec();
        q.register_custom_query(
            path.to_string(),
            Box::new(move |_| SystemResult::Ok(ContractResult::Ok(Binary::from(bytes.clone())))),
        );
    }

    /// Collapse a CosmosMsg to a short label for sequence assertions.
    fn kind(msg: &CosmosMsg) -> &'static str {
        match msg {
            CosmosMsg::Distribution(DistributionMsg::WithdrawDelegatorReward { .. }) => "claim",
            CosmosMsg::Staking(StakingMsg::Undelegate { .. }) => "undelegate",
            CosmosMsg::Staking(StakingMsg::Redelegate { .. }) => "redelegate",
            CosmosMsg::Staking(StakingMsg::Delegate { .. }) => "delegate",
            CosmosMsg::Any(any) => match any.type_url.as_str() {
                "/provenance.exchange.v1.MsgCreatePaymentRequest" => "create_payment",
                ACCEPT_ASSET_TYPE_URL => "accept_asset",
                UPDATE_VAULT_NAV_TYPE_URL => "update_nav",
                "/provlabs.vault.v1.MsgPauseVaultRequest" => "pause",
                "/provlabs.vault.v1.MsgDepositPrincipalFundsRequest" => "deposit_principal",
                "/provlabs.vault.v1.MsgUnpauseVaultRequest" => "unpause",
                "/provlabs.vault.v1.MsgExpeditePendingSwapOutRequest" => "expedite",
                "/provenance.marker.v1.MsgTransferRequest" => "transfer_receipt",
                "/provenance.marker.v1.MsgBurnRequest" => "burn_receipt",
                "/provenance.marker.v1.MsgMintRequest" => "mint_receipt",
                other => panic!("unexpected Any message in epoch crank: {other}"),
            },
            other => panic!("unexpected message variant in epoch crank: {other:?}"),
        }
    }

    /// Stand up mocked deps + env with the full query surface run_epoch touches.
    /// `contract_liquid` is the contract's nhash bank balance (matured returns +
    /// swept rewards); `vault_liquid` the principal marker's liquid nhash;
    /// `reward` the claimable rewards on the enrolled validator.
    fn setup(
        contract_liquid: u128,
        vault_liquid: u128,
        reward: u128,
    ) -> (
        cosmwasm_std::OwnedDeps<
            cosmwasm_std::testing::MockStorage,
            cosmwasm_std::testing::MockApi,
            MockProvenanceQuerier,
        >,
        Env,
    ) {
        let mut deps = mock_provenance_dependencies();
        let env = mock_env();
        let contract = env.contract.address.to_string();
        let admin = deps.api.addr_make("admin");
        let vault = deps.api.addr_make("vault");
        let marker = deps.api.addr_make("receipt-marker");

        crate::contract::instantiate(
            deps.as_mut(),
            env.clone(),
            message_info(&admin, &[]),
            InstantiateMsg {
                admin: admin.to_string(),
                vault_address: vault.to_string(),
                underlying_denom: "nhash".to_string(),
                receipt_denom: "nvhash.staked".to_string(),
                max_delegations_per_run: 0,
                aum_fee_bps: 0,
                performance_threshold_bps: 0,
                min_capture_interval_secs: 0,
                max_concentration_multiple_bps: None,
                min_bonded_cap_bps: None,
                max_bonded_cap_bps: None,
                concentration_safety_offset_bps: None,
                commission_bps: Some(0),
                jail_unbond_delay_secs: None,
            },
        )
        .unwrap();

        // One enrolled, bonded, eligible validator holding the program's stake.
        VALIDATORS
            .save(
                &mut deps.storage,
                VALOPER,
                &ValidatorRecord {
                    operator: Addr::unchecked("op"),
                    enrolled_at: Timestamp::from_seconds(1),
                    uptime_sum_bps: 10_000,
                    uptime_count: 1,
                    commission_accrued: Uint128::zero(),
                    commission_paid: Uint128::zero(),
                    commission_due: Uint128::zero(),
                    commission_billed: Uint128::zero(),
                    tip_epoch: Uint128::zero(),
                },
            )
            .unwrap();
        // 1_500 receipt outstanding vs 1_000 still staked: 500 matured back.
        RECEIPT_MINTED
            .save(&mut deps.storage, &Uint128::new(1_500))
            .unwrap();

        // --- native queries: bank, staking delegations, distribution rewards ---
        deps.querier
            .mock_querier
            .bank
            .update_balance(&contract, vec![CwCoin::new(contract_liquid, "nhash")]);
        let zero = CwCoin::new(0u128, "nhash");
        deps.querier.mock_querier.staking.update(
            "nhash",
            &[CwValidator::create(
                VALOPER.to_string(),
                cosmwasm_std::Decimal::zero(),
                cosmwasm_std::Decimal::one(),
                cosmwasm_std::Decimal::one(),
            )],
            &[FullDelegation::create(
                Addr::unchecked(&contract),
                VALOPER.to_string(),
                CwCoin::new(1_000u128, "nhash"),
                zero.clone(),
                vec![],
            )],
        );
        if reward > 0 {
            deps.querier
                .mock_querier
                .distribution
                .set_validators(&contract, [VALOPER]);
            deps.querier.mock_querier.distribution.set_rewards(
                VALOPER,
                &contract,
                vec![DecCoin::new(
                    Decimal256::from_atomics(reward, 0).unwrap(),
                    "nhash",
                )],
            );
        }

        // --- gRPC queries ---
        let q = &mut deps.querier;
        grpc(
            q,
            "/cosmos.staking.v1beta1.Query/Validators",
            &QueryValidatorsResponse {
                validators: vec![PValidator {
                    operator_address: VALOPER.to_string(),
                    jailed: false,
                    status: BondStatus::Bonded as i32,
                    tokens: "1000".to_string(),
                    ..Default::default()
                }],
                pagination: None,
            },
        );
        grpc(
            q,
            "/cosmos.staking.v1beta1.Query/Pool",
            &QueryPoolResponse {
                pool: Some(Pool {
                    not_bonded_tokens: "0".to_string(),
                    bonded_tokens: "1000000".to_string(),
                }),
            },
        );
        grpc(
            q,
            "/cosmos.slashing.v1beta1.Query/Params",
            &SlashingParamsResponse {
                params: Some(SlashingParams {
                    signed_blocks_window: 100,
                    ..Default::default()
                }),
            },
        );
        grpc(
            q,
            "/cosmos.staking.v1beta1.Query/DelegatorUnbondingDelegations",
            &QueryDelegatorUnbondingDelegationsResponse {
                unbonding_responses: vec![],
                pagination: None,
            },
        );
        grpc(
            q,
            "/cosmos.staking.v1beta1.Query/Redelegations",
            &QueryRedelegationsResponse {
                redelegation_responses: vec![],
                pagination: None,
            },
        );
        grpc(
            q,
            "/provlabs.vault.v1.Query/VaultPendingSwapOuts",
            &QueryVaultPendingSwapOutsResponse {
                pending_swap_outs: vec![],
                pagination: None,
            },
        );
        grpc(
            q,
            "/provlabs.vault.v1.Query/Vault",
            &QueryVaultResponse {
                vault: Some(VaultAccount {
                    total_shares: Some(PbCoin {
                        denom: "nvhash".to_string(),
                        amount: "20000000000".to_string(),
                    }),
                    ..Default::default()
                }),
                principal: Some(AccountBalance {
                    address: String::new(),
                    coins: vec![PbCoin {
                        denom: "nhash".to_string(),
                        amount: vault_liquid.to_string(),
                    }],
                }),
                reserves: None,
                total_vault_value: Some(PbCoin {
                    denom: "nhash".to_string(),
                    amount: (vault_liquid + 1_500).to_string(),
                }),
                ..Default::default()
            },
        );
        grpc(
            q,
            "/provenance.marker.v1.Query/Marker",
            &QueryMarkerResponse {
                marker: Some(provwasm_std::shim::Any {
                    type_url: "/provenance.marker.v1.MarkerAccount".to_string(),
                    value: MarkerAccount {
                        base_account: Some(BaseAccount {
                            address: marker.to_string(),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }
                    .encode_to_vec(),
                }),
            },
        );

        (deps, env)
    }

    fn decode_any<M: prost::Message + Default>(msg: &CosmosMsg, expect_kind: &str) -> M {
        assert_eq!(kind(msg), expect_kind);
        let CosmosMsg::Any(any) = msg else { unreachable!() };
        M::decode(any.value.as_slice()).unwrap()
    }

    /// Reward-deposit path: liquid (800) exceeds matured (500), so the crank
    /// settles the return, deposits the 300 surplus inside the pause window,
    /// burns the returned receipt, then mints and deploys the vault surplus.
    /// Locks: settlement BEFORE pause; deposit strictly INSIDE pause/unpause;
    /// transfer-then-burn AFTER unpause; deploy and delegations LAST.
    #[test]
    fn run_epoch_orders_settle_pause_deposit_burn_deploy() {
        let (mut deps, env) = setup(800, 10_000, 100);
        let res = run_epoch(deps.as_mut(), env).unwrap();
        let kinds: Vec<&str> = res.messages.iter().map(|m| kind(&m.msg)).collect();
        assert_eq!(
            kinds,
            vec![
                "claim",             // Phase A: withdraw rewards
                "create_payment",    // return settlement (unpaused)
                "accept_asset",
                "pause",             // Phase C: pause window opens
                "deposit_principal", // the NAV step, inside the window
                "unpause",           // window closes
                "transfer_receipt",  // burn leg: receipt into the marker account
                "burn_receipt",
                "mint_receipt",      // deploy settlement
                "create_payment",
                "accept_asset",
                "delegate",          // fresh stake last
            ],
            "run_epoch message order changed — the pause-window and settlement \
             safety story depends on this exact sequence"
        );
        // The deposit inside the window is exactly liquid - settle = 300.
        let dep: MsgDepositPrincipalFundsRequest = decode_any(&res.messages[4].msg, "deposit_principal");
        assert_eq!(dep.amount.unwrap().amount, "300");
        // Burn is exactly the matured receipt.
        let burn: MsgBurnRequest = decode_any(&res.messages[7].msg, "burn_receipt");
        assert_eq!(burn.amount.unwrap().amount, "500");
        // Receipt counter: 1500 outstanding + 9950 deployed - 500 burned.
        let minted: MsgMintRequest = decode_any(&res.messages[8].msg, "mint_receipt");
        assert_eq!(minted.amount.unwrap().amount, "9950");
        assert_eq!(
            RECEIPT_MINTED.load(&deps.storage).unwrap(),
            Uint128::new(1_500 + 9_950 - 500)
        );
    }

    /// Write-down path: liquid (300) under-covers matured (500), so the 200
    /// shortfall is a slash loss recognized THIS crank via the NAV guardrail
    /// sandwich, and with no surplus there is no pause window at all. Locks the
    /// sandwich order (mark to zero -> settle out -> restore 1:1) and that the
    /// burn covers settle + write_down.
    #[test]
    fn run_epoch_orders_write_down_sandwich_without_pause() {
        let (mut deps, env) = setup(300, 0, 0);
        let res = run_epoch(deps.as_mut(), env).unwrap();
        let kinds: Vec<&str> = res.messages.iter().map(|m| kind(&m.msg)).collect();
        assert_eq!(
            kinds,
            vec![
                "create_payment",   // return settlement for the backed 300
                "accept_asset",
                "update_nav",       // sandwich: mark receipt to 0 for 200 units
                "create_payment",   // zero-priced settlement extracts the receipt
                "accept_asset",
                "update_nav",       // restore the exact 1:1 entry
                "transfer_receipt",
                "burn_receipt",     // settle + write_down burned together
            ],
            "write-down sandwich order changed — a fractional markdown or a \
             reordered restore poisons future 1:1 settlement legs"
        );
        // Sandwich prices: first update_nav marks 200 units at price 0, the
        // second restores 1 nhash per 1 unit.
        let mark: crate::vault_ext::MsgUpdateVaultNavRequest = decode_any(&res.messages[2].msg, "update_nav");
        assert_eq!(mark.price.unwrap().amount, "0");
        assert_eq!(mark.volume, "200");
        let restore: crate::vault_ext::MsgUpdateVaultNavRequest = decode_any(&res.messages[5].msg, "update_nav");
        assert_eq!(restore.price.unwrap().amount, "1");
        assert_eq!(restore.volume, "1");
        // No pause window anywhere: the write-down path deposits nothing.
        assert!(!kinds.iter().any(|k| *k == "pause" || *k == "unpause"));
        let burn: MsgBurnRequest = decode_any(&res.messages[7].msg, "burn_receipt");
        assert_eq!(burn.amount.unwrap().amount, "500");
        assert_eq!(RECEIPT_MINTED.load(&deps.storage).unwrap(), Uint128::new(1_000));
    }
}
