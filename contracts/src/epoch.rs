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

/// Deploy-leg liquid buffer floor in bps of vault liquid; the primary buffer is plan::fee_reserve.
pub const DEPLOY_BUFFER_BPS: u128 = 50;

/// x/exchange payment external ids; created and accepted in one tx, so reusable every epoch.
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

/// Total in-flight unbonding principal, plus validators already at MAX_UNBOND_ENTRIES
/// (another Undelegate against them reverts the crank). Paginated: a truncated read
/// re-unbonds principal already returning.
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
        key = resp.pagination.and_then(|p| p.next_key).unwrap_or_default();
        if key.is_empty() {
            break;
        }
    }
    Ok((total, at_capacity))
}

/// Rebalance constraints from in-flight redelegations: validators that may not be
/// redelegated FROM, and `(src, dst)` routes that cannot carry another entry.
pub type RedelegationConstraints = (BTreeSet<String>, BTreeSet<(String, String)>);

/// Active redelegations reduced to rebalance constraints: in-flight destinations
/// cannot be redelegated FROM (no transitive redelegation), and full routes carry
/// no more entries. Paginated: a truncated read emits moves the chain rejects.
pub fn redelegation_state(deps: Deps, env: &Env) -> StdResult<RedelegationConstraints> {
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
        key = resp.pagination.and_then(|p| p.next_key).unwrap_or_default();
        if key.is_empty() {
            break;
        }
    }
    Ok((blocked_sources, blocked_pairs))
}

/// (liquid nhash in the vault's principal marker, total vault value, total shares);
/// the marker-held receipt values into TVV via the vault's internal NAV at its seeded 1:1.
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
    let tvv = resp.total_vault_value.map(|c| c.amount).unwrap_or_default();
    let shares = resp
        .vault
        .and_then(|v| v.total_shares)
        .map(|c| c.amount)
        .unwrap_or_default();
    // An absent coin in the SDK response means a zero balance, not malformed data.
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
    // An absent assets coin means zero payout, not malformed data (see vault_snapshot).
    Ok(Uint128::from_str(&amt).unwrap_or_default())
}

/// Pending swap-outs with estimated payout needs (every redemption is nhash). Paginated:
/// a truncated read under-reserves and lets later requests mature unfunded.
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
        key = resp.pagination.and_then(|p| p.next_key).unwrap_or_default();
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

/// Claimable rewards per validator in the underlying denom, floored; equals what
/// WithdrawDelegatorReward pays this block, so it is the program-commission accrual base.
pub fn rewards_by_validator(
    deps: Deps,
    env: &Env,
    denom: &str,
) -> StdResult<Vec<(String, Uint128)>> {
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
    Ok(enrolled(deps.storage)?
        .into_iter()
        .map(|(v, _)| v)
        .collect())
}

/// Phase A alone: withdraw rewards from every delegated validator and accrue program
/// commission. Keepers call this in a tx before RunEpoch; rewards claimed inside
/// RunEpoch land after its state reads and deposit at the next epoch.
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

/// Phases B + D2 alone: unbond in drain-priority order to cover queued swap-outs,
/// and expedite requests already funded by the principal marker. Contract liquid
/// counts toward coverage, never expedites; continuation-earmarked nhash is excluded.
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
            cfg.redemption_margin_bps,
        );
        (plan, rewards)
    };

    // Undelegate auto-withdraws pending rewards: accrue commission now or they escape the base.
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

/// One settlement with the vault, in emission order: `[create_payment, accept_asset]`.
/// Both are built from one set of arguments because the vault settles only when the
/// pending payment matches the approval's terms exactly.
fn settlement_msgs(
    env: &Env,
    cfg: &Config,
    source_amount: Vec<ProstCoin>,
    target_amount: Vec<ProstCoin>,
    external_id: &str,
) -> [CosmosMsg; 2] {
    let create = MsgCreatePaymentRequest {
        payment: Some(Payment {
            source: env.contract.address.to_string(),
            source_amount: source_amount.clone(),
            target: cfg.vault_address.to_string(),
            target_amount: target_amount.clone(),
            external_id: external_id.to_string(),
        }),
    }
    .into();
    let accept = accept_asset_msg(
        env.contract.address.as_str(),
        cfg.vault_address.as_str(),
        env.contract.address.as_str(),
        source_amount,
        target_amount,
        external_id,
    );
    [create, accept]
}

/// Restate the receipt's internal NAV entry at par 1:1. A draining settlement removes
/// the entry and a settlement without one is rejected; a par restate is legal on a
/// live vault in every reachable state.
fn nav_assert_msg(env: &Env, cfg: &Config) -> CosmosMsg {
    update_vault_nav_msg(
        env.contract.address.as_str(),
        cfg.vault_address.as_str(),
        &cfg.receipt_denom,
        &cfg.underlying_denom,
        1,
        1,
        "nvhash-nav-assert",
    )
}

fn pause_msg(env: &Env, cfg: &Config, reason: &str) -> CosmosMsg {
    MsgPauseVaultRequest {
        authority: env.contract.address.to_string(),
        vault_address: cfg.vault_address.to_string(),
        reason: reason.to_string(),
    }
    .into()
}

fn unpause_msg(env: &Env, cfg: &Config) -> CosmosMsg {
    MsgUnpauseVaultRequest {
        authority: env.contract.address.to_string(),
        vault_address: cfg.vault_address.to_string(),
    }
    .into()
}

/// The full epoch crank, one transaction end to end: any failure reverts messages and
/// state together, so no half-settled payment, stuck pause, or desynced receipt counter.
pub fn run_epoch(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    assert_not_halted(deps.as_ref())?;
    let cfg = CONFIG.load(deps.storage)?;

    // Continuation: drain the next gas chunk; bypasses the rollover gate (epoch in progress).
    let pending_redel = PENDING_REDELEGATIONS
        .may_load(deps.storage)?
        .unwrap_or_default();
    let pending_targets = PENDING_DELEGATIONS
        .may_load(deps.storage)?
        .unwrap_or_default();
    if !pending_redel.is_empty() || !pending_targets.is_empty() {
        return continue_epoch(deps, env, &cfg, pending_redel, pending_targets);
    }

    let mut epoch = EPOCH.load(deps.storage)?;
    let receipt_minted = RECEIPT_MINTED.load(deps.storage)?;

    // Calendar-month rollover gate, deterministic in consensus block time: no caller
    // can pick the epoch's duration or double-run it.
    if crate::month::year_month(env.block.time) <= crate::month::year_month(epoch.last_run) {
        let next = crate::month::first_of_next_month_secs(epoch.last_run);
        return Err(ContractError::TooSoon { next });
    }

    // Phase A basis; commission accrual mutates storage, so it precedes the planning block.
    let rewards = rewards_by_validator(deps.as_ref(), &env, &cfg.underlying_denom)?;
    accrue_commission(deps.storage, &rewards, cfg.commission_bps)?;

    let mut msgs: Vec<CosmosMsg> = vec![];
    let redelegate_rest: Vec<(String, String, Uint128)>;
    let delegate_rest: Vec<(String, Uint128)>;
    let burned: Uint128;
    // Hoisted so Phase E's receipt-counter delta reuses the exact value the mint message used.
    let deployable: Uint128;
    // Snapshot measurements, taken from the same values the messages were built from.
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

        // Eligibility and concentration headroom per enrolled validator. Assessments
        // arrive priority-sorted; rebalance seats take that order, drain is its reverse.
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

        // Contract liquid = rewards swept by earlier cranks + matured unbondings.
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
        let need = redemption_need(&pending, cfg.redemption_margin_bps);

        // Deploy budget reserves the service leg's `need`: redemption funds are never staked away.
        let budget = if eligible_rooms.is_empty() {
            Uint128::zero()
        } else {
            // Two nominal epochs of AUM-fee accrual; cadence is calendar-month.
            let horizon = crate::month::NOMINAL_EPOCH_SECS.saturating_mul(2);
            let buffer = fee_reserve(tvv, cfg.aum_fee_bps, horizon)
                .max(vault_liquid.multiply_ratio(DEPLOY_BUFFER_BPS, 10_000u128));
            vault_liquid.saturating_sub(need + buffer)
        };

        // Marker liquid once this run's moves land; assuming the full budget flows out
        // is the conservative side of F1 for gating expedites.
        let marker_after = (vault_liquid + liquid).saturating_sub(budget);

        // Phase B: service redemptions, unbonding only the increment in drain-priority order.
        let dels_for_service = order_for_drain(dels.clone(), &ranks);
        let plan = plan_service(
            &pending,
            vault_liquid + liquid,
            marker_after,
            unbonding,
            &dels_for_service,
            &at_capacity,
            cfg.redemption_margin_bps,
        );
        let service_unbonded: Uint128 = plan.undelegations.iter().map(|(_, a)| *a).sum();
        let expedited = plan.expedite_ids.len() as u32;
        // Post-unbond stake view for the rebalance; undelegates execute before redelegations.
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

        // Uniform-slot rebalance: non-eligible stake is redirected, never unbonded;
        // the cap-blocked residual stays liquid.
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
            .map(|(v, s)| DelegationView {
                valoper: v.clone(),
                staked: *s,
            })
            .collect();
        let rebalance =
            crate::plan::plan_rebalance(&seats, &others, budget, &blocked_sources, &blocked_pairs);
        deployable = budget.saturating_sub(rebalance.undeployable);
        let rebalanced_total: Uint128 = rebalance.redelegations.iter().map(|(_, _, a)| *a).sum();

        // Return plan: settle the backed portion, write down the slashed portion.
        let ret = plan_return(receipt_minted, staked, unbonding, liquid);
        let rewards_dep = liquid.saturating_sub(ret.settle);

        // Return settlement (unpaused): `settle` nhash for `settle` receipt at par.
        // This leg can drain the NAV entry, so the deploy leg carries its own restate.
        if !ret.settle.is_zero() {
            msgs.push(nav_assert_msg(&env, &cfg));
            msgs.extend(settlement_msgs(
                &env,
                &cfg,
                vec![prost_coin(&cfg.underlying_denom, ret.settle)],
                vec![prost_coin(&cfg.receipt_denom, ret.settle)],
                RETURN_PAYMENT_ID,
            ));
        }

        // Slash write-down: the vault rejects WithdrawPrincipalFunds of a non-accepted
        // denom, so the markdown runs as a NAV guardrail sandwich (mark to 0, settle
        // write_down out zero-priced, restore 1:1) under the contract's NAV authority.
        // Repricing a held asset requires a paused vault; settling requires a live one,
        // hence the pause brackets. A fractional markdown would poison later legs: the
        // settlement guardrail is exact cross-multiplication against the entry.
        let writing_down = !ret.write_down.is_zero();
        if writing_down {
            msgs.push(pause_msg(&env, &cfg, "nvhash-writedown"));
            msgs.push(update_vault_nav_msg(
                env.contract.address.as_str(),
                cfg.vault_address.as_str(),
                &cfg.receipt_denom,
                &cfg.underlying_denom,
                0,
                ret.write_down.u128(),
                "nvhash-writedown",
            ));
            msgs.push(unpause_msg(&env, &cfg));
            msgs.extend(settlement_msgs(
                &env,
                &cfg,
                vec![],
                vec![prost_coin(&cfg.receipt_denom, ret.write_down)],
                WRITEDOWN_PAYMENT_ID,
            ));
        }

        // Phase C pause window: carries the 1:1 restore and/or the reward deposit.
        // Today exactly one occurs (test: write_down_and_reward_deposit_are_mutually_exclusive).
        if writing_down || !rewards_dep.is_zero() {
            msgs.push(pause_msg(&env, &cfg, "epoch"));
            if writing_down {
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
            // The NAV step-up: pure value in, no counter-leg.
            if !rewards_dep.is_zero() {
                msgs.push(
                    MsgDepositPrincipalFundsRequest {
                        authority: env.contract.address.to_string(),
                        vault_address: cfg.vault_address.to_string(),
                        amount: Some(prost_coin(&cfg.underlying_denom, rewards_dep)),
                    }
                    .into(),
                );
            }
            msgs.push(unpause_msg(&env, &cfg));
        }

        // Burn returned + written-down receipt. Marker burn only burns marker-account
        // holdings, so transfer in first; needs Transfer access on the restricted marker.
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

        // Deploy (unpaused): mint receipt, swap into the marker for the surplus nhash, delegate.
        if !deployable.is_zero() {
            msgs.push(
                MsgMintRequest {
                    amount: Some(prost_coin(&cfg.receipt_denom, deployable)),
                    administrator: env.contract.address.to_string(),
                    recipient: env.contract.address.to_string(),
                }
                .into(),
            );
            msgs.push(nav_assert_msg(&env, &cfg));
            msgs.extend(settlement_msgs(
                &env,
                &cfg,
                vec![prost_coin(&cfg.receipt_denom, deployable)],
                vec![prost_coin(&cfg.underlying_denom, deployable)],
                DEPLOY_PAYMENT_ID,
            ));
        }

        // Phase D1: rebalance moves under the per-crank gas budget; remainders carry
        // to continuation cranks.
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

    // Phase E: persist. The receipt invariant moves by minted (deployable) minus burned.
    if deployable != burned {
        RECEIPT_MINTED.save(deps.storage, &(receipt_minted + deployable - burned))?;
    }

    // Snapshot: fold window accumulators, start a fresh window. tvv_after is exact:
    // only the reward deposit (up) and write-down (down) move TVV this crank.
    let crank_claimed: Uint128 = rewards.iter().map(|(_, a)| *a).sum();
    let mut accum = EPOCH_ACCUM.may_load(deps.storage)?.unwrap_or_default();
    accum.rewards_claimed += crank_claimed;
    accum.unbonded_for_redemptions += stats.service_unbonded;
    accum.redemptions_expedited += stats.expedited;
    let prev = LAST_SNAPSHOT.may_load(deps.storage)?;
    let epoch_index = EPOCH_INDEX.may_load(deps.storage)?.unwrap_or(0) + 1;
    let started_at = prev.as_ref().map(|p| p.ended_at_seconds).unwrap_or(0);
    let now = env.block.time.seconds();
    let window = if started_at == 0 {
        0
    } else {
        now.saturating_sub(started_at)
    };
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
        // Epoch rollover: per-epoch uptime accumulators start fresh.
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

/// Continuation crank: execute the next chunk of pending moves; completes the epoch
/// once both queues drain. ClearPendingDelegations is the admin escape hatch if a
/// move reverts forever (dropped moves just leave stake where it is).
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

/// Message-sequence lock for `run_epoch`: the epoch's safety story depends on order,
/// so these tests run the real crank against a mocked querier and assert the emitted
/// message list; a refactor cannot silently reorder legs.
#[cfg(test)]
mod sequence_tests;
