//! Validator enrollment, uptime eligibility and concentration headroom.
//! Enrollment is operator-proven via bech32 key payloads; eligibility is never
//! stored, only assessed from live chain state.

use std::collections::BTreeMap;
use std::str::FromStr;

use bech32::{Bech32, Hrp};
use cosmwasm_std::{
    Deps, DepsMut, Env, MessageInfo, Response, StdError, StdResult, Storage, Uint128,
};
use prost::Message;
use provwasm_std::types::cosmos::base::query::v1beta1::PageRequest;
use provwasm_std::types::cosmos::crypto::ed25519::PubKey as Ed25519PubKey;
use provwasm_std::types::cosmos::slashing::v1beta1::SlashingQuerier;
use provwasm_std::types::cosmos::staking::v1beta1::{BondStatus, StakingQuerier, Validator};
use sha2::{Digest, Sha256};

use crate::plan::{commission_on, max_bond_adjusted, uptime_ratio_bps};
use crate::state::{Config, ValidatorRecord, CONFIG, JAIL_REPORTS, LAST_CAPTURE, VALIDATORS};
use crate::ContractError;

/// Enrollment cap, matching the Provenance active-set ceiling. Per-crank work
/// scales with enrollment, so gas-profile the crank at this bound before launch.
pub const MAX_VALIDATORS: u32 = 100;

const PAGE_LIMIT: u64 = 100;
const ED25519_PUBKEY_TYPE_URL: &str = "/cosmos.crypto.ed25519.PubKey";

/// Rejects non-valoper bech32 (an account address here would brick the delegate leg).
pub fn validate_valoper(valoper: &str) -> Result<(), ContractError> {
    if !valoper.contains("valoper1") {
        return Err(ContractError::InvalidValoper {
            valoper: valoper.to_string(),
        });
    }
    Ok(())
}

/// Proves the caller controls the validator: operator account and valoper share
/// the same bech32 key payload, only the HRP differs.
pub fn is_operator(sender: &str, valoper: &str) -> bool {
    match (bech32::decode(sender), bech32::decode(valoper)) {
        (Ok((_, s)), Ok((_, v))) => !s.is_empty() && s == v,
        _ => false,
    }
}

/// Enrolled validators in deterministic (lexicographic) order.
pub fn enrolled(storage: &dyn Storage) -> StdResult<Vec<(String, ValidatorRecord)>> {
    VALIDATORS
        .range(storage, None, None, cosmwasm_std::Order::Ascending)
        .collect()
}

pub fn register(
    deps: DepsMut,
    env: Env,
    info: &MessageInfo,
    valoper: String,
) -> Result<Response, ContractError> {
    validate_valoper(&valoper)?;
    if !is_operator(info.sender.as_str(), &valoper) {
        return Err(ContractError::NotOperator { valoper });
    }
    if VALIDATORS.has(deps.storage, &valoper) {
        return Err(ContractError::AlreadyEnrolled { valoper });
    }
    let count = enrolled(deps.storage)?.len() as u32;
    if count >= MAX_VALIDATORS {
        return Err(ContractError::TooManyValidators {
            max: MAX_VALIDATORS,
        });
    }
    // gRPC not-found is an opaque generic error, so any query failure maps to not-found.
    let sq = StakingQuerier::new(&deps.querier);
    if sq.validator(valoper.clone()).is_err() {
        return Err(ContractError::ValidatorNotFound { valoper });
    }
    VALIDATORS.save(
        deps.storage,
        &valoper,
        &ValidatorRecord {
            operator: info.sender.clone(),
            enrolled_at: env.block.time,
            uptime_sum_bps: 0,
            uptime_count: 0,
            commission_accrued: Uint128::zero(),
            commission_paid: Uint128::zero(),
            commission_due: Uint128::zero(),
            commission_billed: Uint128::zero(),
            tip_epoch: Uint128::zero(),
        },
    )?;
    Ok(Response::new()
        .add_attribute("action", "register_participation")
        .add_attribute("valoper", valoper))
}

/// The single attached coin in the underlying denom; rejects anything else.
fn attached_underlying(info: &MessageInfo, denom: &str) -> Result<Uint128, ContractError> {
    let amount = cw_utils::must_pay(info, denom)
        .map_err(|e| ContractError::Std(cosmwasm_std::StdError::generic_err(e.to_string())))?;
    Ok(amount)
}

/// Permissionless commission payment on a validator's behalf; non-refundable,
/// swept into vault principal at the next epoch's deposit leg.
pub fn pay_commission(
    deps: DepsMut,
    info: &MessageInfo,
    valoper: String,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let amount = attached_underlying(info, &cfg.underlying_denom)?;
    let mut record = VALIDATORS
        .may_load(deps.storage, &valoper)?
        .ok_or_else(|| ContractError::NotEnrolled {
            valoper: valoper.clone(),
        })?;
    record.commission_paid += amount;
    VALIDATORS.save(deps.storage, &valoper, &record)?;
    crate::state::update_accum(deps.storage, |a| a.commission_received += amount)?;
    Ok(Response::new()
        .add_attribute("action", "pay_commission")
        .add_attribute("valoper", valoper)
        .add_attribute("amount", amount.to_string())
        .add_attribute(
            "outstanding",
            record
                .commission_accrued
                .saturating_sub(record.commission_paid)
                .to_string(),
        ))
}

/// Permissionless tip on a validator's behalf; credits the current epoch's tip
/// (the primary priority key), reset at every epoch completion.
pub fn pay_tip(
    deps: DepsMut,
    info: &MessageInfo,
    valoper: String,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let amount = attached_underlying(info, &cfg.underlying_denom)?;
    let mut record = VALIDATORS
        .may_load(deps.storage, &valoper)?
        .ok_or_else(|| ContractError::NotEnrolled {
            valoper: valoper.clone(),
        })?;
    record.tip_epoch += amount;
    VALIDATORS.save(deps.storage, &valoper, &record)?;
    crate::state::update_accum(deps.storage, |a| a.tips_received += amount)?;
    Ok(Response::new()
        .add_attribute("action", "pay_tip")
        .add_attribute("valoper", valoper)
        .add_attribute("tip_epoch", record.tip_epoch.to_string()))
}

/// Whether the validator carries a meaningful liveness signal:
/// missed_blocks_counter only advances while bonded and resets on jail, so a
/// jailed/unbonded validator's SigningInfo reads as a vacuous 100%.
pub fn has_liveness_signal(validator: &Validator) -> bool {
    !validator.jailed && validator.status == BondStatus::Bonded as i32
}

/// Live jail state: (jailed, unbonding_height), the jail-episode fingerprint
/// (see JailObservation). A validator missing from staking is treated as not
/// jailed: there is nothing to purge from it.
fn jail_state_on_chain(deps: Deps, valoper: &str) -> (bool, i64) {
    StakingQuerier::new(&deps.querier)
        .validator(valoper.to_string())
        .ok()
        .and_then(|resp| resp.validator)
        .map(|v| (v.jailed, v.unbonding_height))
        .unwrap_or((false, 0))
}

/// The program's live delegation to a validator, in the underlying denom.
fn program_stake_on(
    deps: Deps,
    env: &Env,
    cfg: &crate::state::Config,
    valoper: &str,
) -> StdResult<Uint128> {
    Ok(deps
        .querier
        .query_delegation(env.contract.address.to_string(), valoper.to_string())?
        .map(|d| {
            if d.amount.denom == cfg.underlying_denom {
                d.amount.amount
            } else {
                Uint128::zero()
            }
        })
        .unwrap_or_default())
}

/// Permissionless jail-report phase 1: record the first jail observation, starting
/// the jail_unbond_delay cooldown. Idempotent: repeats keep the original timestamp;
/// observing an unjailed validator clears any report.
pub fn report_jailed(deps: DepsMut, env: &Env, valoper: String) -> Result<Response, ContractError> {
    validate_valoper(&valoper)?;
    let resp = Response::new()
        .add_attribute("action", "report_jailed_validator")
        .add_attribute("valoper", valoper.clone());
    let (jailed, unbonding_height) = jail_state_on_chain(deps.as_ref(), &valoper);
    if jailed {
        // No live program delegation: nothing to purge; a report would only go stale.
        let cfg = CONFIG.load(deps.storage)?;
        if program_stake_on(deps.as_ref(), env, &cfg, &valoper)?.is_zero() {
            return Ok(resp.add_attribute("result", "no_program_stake"));
        }
        if let Some(existing) = JAIL_REPORTS.may_load(deps.storage, &valoper)? {
            if existing.unbonding_height == unbonding_height {
                // Same episode: keep the original timestamp so spam cannot extend the window.
                return Ok(resp.add_attribute("result", "already_reported"));
            }
            // Earlier-episode report: restart the cycle, never inherit elapsed cooldown.
        }
        JAIL_REPORTS.save(
            deps.storage,
            &valoper,
            &crate::state::JailObservation {
                reported_at: env.block.time,
                unbonding_height,
            },
        )?;
        Ok(resp
            .add_attribute("result", "reported")
            .add_attribute("reported_at", env.block.time.seconds().to_string()))
    } else {
        let had = JAIL_REPORTS.has(deps.storage, &valoper);
        JAIL_REPORTS.remove(deps.storage, &valoper);
        Ok(resp.add_attribute("result", if had { "cleared" } else { "not_jailed" }))
    }
}

/// Permissionless, halt-gated purge phase 2: requires jailed at report AND still
/// jailed after the cooldown (two-observation sustained-downtime guard). With an
/// eligible caller-operated claimant: redelegate up to headroom, unbond the rest.
pub fn purge_jailed(
    deps: DepsMut,
    env: &Env,
    info: &MessageInfo,
    valoper: String,
    claimant_valoper: Option<String>,
) -> Result<Response, ContractError> {
    crate::epoch::assert_not_halted(deps.as_ref())?;
    validate_valoper(&valoper)?;
    let cfg = CONFIG.load(deps.storage)?;

    // Storage-level gates first: a report must exist and its cooldown must have elapsed.
    let report = JAIL_REPORTS
        .may_load(deps.storage, &valoper)?
        .ok_or_else(|| ContractError::JailReportMissing {
            valoper: valoper.clone(),
        })?;
    let ready = report
        .reported_at
        .seconds()
        .saturating_add(cfg.jail_unbond_delay_secs);
    if env.block.time.seconds() < ready {
        return Err(ContractError::JailCooldownActive { ready });
    }
    // Claimant must be enrolled with the caller as operator; live eligibility checked below.
    if let Some(cv) = &claimant_valoper {
        validate_valoper(cv)?;
        if *cv == valoper {
            return Err(ContractError::ClaimantNotEligible {
                valoper: cv.clone(),
            });
        }
        let rec =
            VALIDATORS
                .may_load(deps.storage, cv)?
                .ok_or_else(|| ContractError::NotEnrolled {
                    valoper: cv.clone(),
                })?;
        if info.sender != rec.operator {
            return Err(ContractError::NotOperator {
                valoper: cv.clone(),
            });
        }
    }

    // Second observation: still jailed NOW, or the report is void.
    let (jailed, unbonding_height) = jail_state_on_chain(deps.as_ref(), &valoper);
    if !jailed {
        JAIL_REPORTS.remove(deps.storage, &valoper);
        return Err(ContractError::NotJailed { valoper });
    }
    // Episode mismatch = stale report (unobserved unjail/re-jail): restart the
    // cycle, never purge on the old timestamp (two-observation guard).
    if unbonding_height != report.unbonding_height {
        JAIL_REPORTS.save(
            deps.storage,
            &valoper,
            &crate::state::JailObservation {
                reported_at: env.block.time,
                unbonding_height,
            },
        )?;
        return Err(ContractError::JailCooldownActive {
            ready: env
                .block
                .time
                .seconds()
                .saturating_add(cfg.jail_unbond_delay_secs),
        });
    }

    // Zero stake = already purged: idempotent no-op, first caller won.
    let staked = program_stake_on(deps.as_ref(), env, &cfg, &valoper)?;
    if staked.is_zero() {
        return Ok(Response::new()
            .add_attribute("action", "purge_jailed_validator")
            .add_attribute("valoper", valoper)
            .add_attribute("result", "nothing_to_move"));
    }

    let (_, at_capacity) = crate::epoch::unbonding_state(deps.as_ref(), env)?;
    let unbond_blocked = at_capacity.contains(&valoper);

    let mut msgs: Vec<cosmwasm_std::CosmosMsg> = vec![];
    let mut redelegated = Uint128::zero();
    let mut unbonded = Uint128::zero();
    let mut deferred = Uint128::zero();

    match &claimant_valoper {
        Some(cv) => {
            // Claimant must assess fully eligible (spec strict reading); headroom bounds the gain.
            let assessment = assess_validators(deps.as_ref(), &cfg)?
                .into_iter()
                .find(|a| a.valoper == *cv)
                .ok_or_else(|| ContractError::NotEnrolled {
                    valoper: cv.clone(),
                })?;
            if !assessment.eligible {
                return Err(ContractError::ClaimantNotEligible {
                    valoper: cv.clone(),
                });
            }
            redelegated = staked.min(assessment.headroom);
            if !redelegated.is_zero() {
                msgs.push(
                    cosmwasm_std::StakingMsg::Redelegate {
                        src_validator: valoper.clone(),
                        dst_validator: cv.clone(),
                        amount: cosmwasm_std::coin(redelegated.u128(), &cfg.underlying_denom),
                    }
                    .into(),
                );
            }
            let rest = staked - redelegated;
            if !rest.is_zero() {
                if unbond_blocked {
                    // MaxEntries blocks the unbond leg; remainder stays staked for a later purge.
                    deferred = rest;
                } else {
                    unbonded = rest;
                }
            }
        }
        None => {
            if unbond_blocked {
                return Err(ContractError::UnbondEntriesFull { valoper });
            }
            unbonded = staked;
        }
    }
    if !unbonded.is_zero() {
        msgs.push(
            cosmwasm_std::StakingMsg::Undelegate {
                validator: valoper.clone(),
                amount: cosmwasm_std::coin(unbonded.u128(), &cfg.underlying_denom),
            }
            .into(),
        );
    }

    // Clear only when fully handled: a re-jail needs a fresh two-observation
    // cycle; a deferred remainder keeps the report so no new cooldown is needed.
    if deferred.is_zero() {
        JAIL_REPORTS.remove(deps.storage, &valoper);
    }

    // Moving the delegation auto-withdraws pending rewards; fold into claimed-rewards analytics.
    let pending_rewards = deps
        .querier
        .query_delegation_rewards(env.contract.address.to_string(), &valoper)?
        .into_iter()
        .find(|c| c.denom == cfg.underlying_denom)
        .map(|c| Uint128::try_from(c.amount.to_uint_floor()).unwrap_or_default())
        .unwrap_or_default();
    crate::state::update_accum(deps.storage, |a| {
        a.rewards_claimed += pending_rewards;
        a.validators_purged += 1;
    })?;

    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "purge_jailed_validator")
        .add_attribute("valoper", valoper)
        .add_attribute(
            "claimant",
            claimant_valoper.unwrap_or_else(|| "none".to_string()),
        )
        .add_attribute("redelegated", redelegated.to_string())
        .add_attribute("unbonded", unbonded.to_string())
        .add_attribute("deferred", deferred.to_string()))
}

/// Accrue program commission from per-validator claimed rewards; called at
/// every reward-withdrawing point. Unenrolled validators accrue nothing.
pub fn accrue_commission(
    storage: &mut dyn Storage,
    rewards: &[(String, Uint128)],
    commission_bps: u64,
) -> StdResult<()> {
    if commission_bps == 0 {
        return Ok(());
    }
    for (valoper, amount) in rewards {
        let charge = commission_on(*amount, commission_bps);
        if charge.is_zero() {
            continue;
        }
        if let Some(mut record) = VALIDATORS.may_load(storage, valoper)? {
            record.commission_accrued += charge;
            VALIDATORS.save(storage, valoper, &record)?;
        }
    }
    Ok(())
}

pub fn unregister(
    deps: DepsMut,
    info: &MessageInfo,
    valoper: String,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let record = VALIDATORS
        .may_load(deps.storage, &valoper)?
        .ok_or_else(|| ContractError::NotEnrolled {
            valoper: valoper.clone(),
        })?;
    if info.sender != record.operator && info.sender != cfg.admin {
        return Err(ContractError::Unauthorized {});
    }
    VALIDATORS.remove(deps.storage, &valoper);
    Ok(Response::new()
        .add_attribute("action", "unregister_participation")
        .add_attribute("valoper", valoper))
}

/// Permissionless uptime capture: fold each validator's signed-blocks ratio into
/// its per-epoch accumulator. Interval-gated; early calls are accepted no-ops.
pub fn capture_uptime(deps: DepsMut, env: &Env) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let last = LAST_CAPTURE.may_load(deps.storage)?;
    if let Some(last) = last {
        let next = last.seconds().saturating_add(cfg.min_capture_interval_secs);
        if env.block.time.seconds() < next {
            return Ok(Response::new()
                .add_attribute("action", "capture_uptime_signal")
                .add_attribute("result", "skipped_interval"));
        }
    }
    let vals = enrolled(deps.storage)?;
    if vals.is_empty() {
        return Ok(Response::new()
            .add_attribute("action", "capture_uptime_signal")
            .add_attribute("result", "no_validators"));
    }
    let window = signed_blocks_window(deps.as_ref())?;
    let sq = StakingQuerier::new(&deps.querier);
    let mut captured = 0u32;
    let mut skipped = 0u32;
    for (valoper, mut record) in vals {
        let validator = sq
            .validator(valoper.clone())
            .ok()
            .and_then(|resp| resp.validator);
        // Jailed/unbonded counters would fold a vacuous 100% sample (see has_liveness_signal).
        let ratio = match validator {
            Some(v) if has_liveness_signal(&v) => direct_uptime(deps.as_ref(), &v, window)
                .and_then(|(ratio, tombstoned)| (!tombstoned).then_some(ratio)),
            Some(_) => {
                skipped += 1;
                None
            }
            None => None,
        };
        if let Some(ratio) = ratio {
            record.uptime_sum_bps = record.uptime_sum_bps.saturating_add(ratio);
            record.uptime_count = record.uptime_count.saturating_add(1);
            VALIDATORS.save(deps.storage, &valoper, &record)?;
            captured += 1;
        }
    }
    LAST_CAPTURE.save(deps.storage, &env.block.time)?;
    Ok(Response::new()
        .add_attribute("action", "capture_uptime_signal")
        .add_attribute("captured", captured.to_string())
        .add_attribute("skipped_no_signal", skipped.to_string()))
}

/// Epoch rollover: reset uptime accumulators and the per-epoch tip; advance the
/// commission grace boundary. Afterward `paid < due` means the one-epoch grace
/// is blown and the validator assesses ineligible until brought current.
pub fn epoch_rollover(storage: &mut dyn Storage) -> StdResult<()> {
    for (valoper, mut record) in enrolled(storage)? {
        record.uptime_sum_bps = 0;
        record.uptime_count = 0;
        record.tip_epoch = Uint128::zero();
        record.commission_due = record.commission_billed;
        record.commission_billed = record.commission_accrued;
        VALIDATORS.save(storage, &valoper, &record)?;
    }
    Ok(())
}

/// Live assessment of one enrolled validator, used by both the epoch planner and
/// the Validators query.
pub struct Assessment {
    pub valoper: String,
    pub record: ValidatorRecord,
    pub bonded: bool,
    pub jailed: bool,
    pub tombstoned: bool,
    /// Effective uptime: accumulator mean if captures exist, else the live read; None if unknown.
    pub uptime_bps: Option<u64>,
    /// Past the one-epoch commission grace (paid < due); alone disqualifies.
    pub in_arrears: bool,
    pub eligible: bool,
    /// New-delegation headroom under the offset-adjusted concentration cap; zero when ineligible.
    pub headroom: Uint128,
}

/// Assess every enrolled validator against live chain state: one bonded-set sweep,
/// one pool read, one slashing-params read, one SigningInfo read per enrolled validator.
pub fn assess_validators(deps: Deps, cfg: &Config) -> StdResult<Vec<Assessment>> {
    let vals = enrolled(deps.storage)?;
    if vals.is_empty() {
        return Ok(vec![]);
    }
    let sq = StakingQuerier::new(&deps.querier);
    let (bonded_map, active_count) = bonded_validators(deps)?;
    let total_bonded = sq.pool()?.pool.map(|p| p.bonded_tokens).unwrap_or_default();
    let total_bonded = Uint128::from_str(&total_bonded).unwrap_or_default();
    let max_bond = max_bond_adjusted(
        total_bonded,
        active_count,
        cfg.max_concentration_multiple_bps,
        cfg.min_bonded_cap_bps,
        cfg.max_bonded_cap_bps,
        cfg.concentration_safety_offset_bps,
    );
    let window = signed_blocks_window(deps)?;

    let mut out = vec![];
    for (valoper, record) in vals {
        // Fall back to an individual read so non-bonded validators still report accurate flags.
        let (validator, bonded) = match bonded_map.get(&valoper) {
            Some(v) => (Some(v.clone()), true),
            None => (
                sq.validator(valoper.clone())
                    .ok()
                    .and_then(|resp| resp.validator),
                false,
            ),
        };
        // Report no signal rather than a frozen counter's vacuous 100% (see has_liveness_signal).
        let (jailed, tokens, direct) = match &validator {
            Some(v) => (
                v.jailed,
                Uint128::from_str(&v.tokens).unwrap_or_default(),
                if has_liveness_signal(v) {
                    direct_uptime(deps, v, window)
                } else {
                    None
                },
            ),
            None => (false, Uint128::zero(), None),
        };
        let tombstoned = direct.map(|(_, t)| t).unwrap_or(false);
        let uptime_bps = if record.uptime_count > 0 {
            Some(record.uptime_sum_bps / record.uptime_count as u64)
        } else {
            direct.map(|(ratio, _)| ratio)
        };
        let meets_threshold = cfg.performance_threshold_bps == 0
            || uptime_bps.is_some_and(|u| u >= cfg.performance_threshold_bps);
        let in_arrears = record.commission_paid < record.commission_due;
        let eligible = validator.is_some()
            && bonded
            && !jailed
            && !tombstoned
            && meets_threshold
            && !in_arrears;
        let headroom = if eligible {
            max_bond.saturating_sub(tokens)
        } else {
            Uint128::zero()
        };
        out.push(Assessment {
            valoper,
            record,
            bonded,
            jailed,
            tombstoned,
            uptime_bps,
            in_arrears,
            eligible,
            headroom,
        });
    }
    sort_by_priority(&mut out);
    Ok(out)
}

/// Program priority order, highest first: epoch tip desc, then effective uptime
/// desc, then the stable tie-break (earliest enrollment, then valoper). The
/// redemption drain order is its reverse (see drain_ranks).
pub fn sort_by_priority(assessments: &mut [Assessment]) {
    assessments.sort_by(|a, b| {
        b.record
            .tip_epoch
            .cmp(&a.record.tip_epoch)
            .then(b.uptime_bps.unwrap_or(0).cmp(&a.uptime_bps.unwrap_or(0)))
            .then(a.record.enrolled_at.cmp(&b.record.enrolled_at))
            .then(a.valoper.cmp(&b.valoper))
    });
}

/// Map valoper -> drain rank; lower ranks unbond first for redemption liquidity.
/// Unenrolled (absent, caller treats as rank 0) drain first, then ineligible, then
/// eligible; lowest priority first within a class. Input must be priority-sorted.
pub fn drain_ranks(assessments: &[Assessment]) -> BTreeMap<String, usize> {
    let n = assessments.len();
    assessments
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let class = if a.eligible { n } else { 0 };
            // i == 0 is the highest priority: it drains last within its class.
            (a.valoper.clone(), class + (n - i))
        })
        .collect()
}

/// Order delegations for redemption drains using drain_ranks; unenrolled
/// validators (absent from the map) come first, ordered by valoper.
pub fn order_for_drain(
    mut dels: Vec<crate::plan::DelegationView>,
    ranks: &BTreeMap<String, usize>,
) -> Vec<crate::plan::DelegationView> {
    dels.sort_by(|a, b| {
        let ra = ranks.get(&a.valoper).copied().unwrap_or(0);
        let rb = ranks.get(&b.valoper).copied().unwrap_or(0);
        ra.cmp(&rb).then(a.valoper.cmp(&b.valoper))
    });
    dels
}

/// All bonded validators (paginated sweep): map valoper -> Validator plus the
/// active-set size the concentration cap divides by.
fn bonded_validators(deps: Deps) -> StdResult<(BTreeMap<String, Validator>, u64)> {
    let sq = StakingQuerier::new(&deps.querier);
    let mut map = BTreeMap::new();
    let mut key: Vec<u8> = vec![];
    loop {
        let resp = sq.validators(
            "BOND_STATUS_BONDED".to_string(),
            Some(PageRequest {
                key,
                offset: 0,
                limit: PAGE_LIMIT,
                count_total: false,
                reverse: false,
            }),
        )?;
        for v in resp.validators {
            map.insert(v.operator_address.clone(), v);
        }
        key = resp.pagination.and_then(|p| p.next_key).unwrap_or_default();
        if key.is_empty() {
            break;
        }
    }
    let count = map.len() as u64;
    Ok((map, count))
}

fn signed_blocks_window(deps: Deps) -> StdResult<i64> {
    let params = SlashingQuerier::new(&deps.querier).params()?;
    Ok(params.params.map(|p| p.signed_blocks_window).unwrap_or(0))
}

/// Live signed-blocks ratio (bps) and tombstoned flag via the consensus address.
/// None when the consensus key is not ed25519 or the signing info is unavailable.
fn direct_uptime(deps: Deps, validator: &Validator, window: i64) -> Option<(u64, bool)> {
    let cons = cons_address(validator).ok()?;
    let info = SlashingQuerier::new(&deps.querier)
        .signing_info(cons)
        .ok()?
        .val_signing_info?;
    Some((
        uptime_ratio_bps(window, info.missed_blocks_counter),
        info.tombstoned,
    ))
}

/// valoper -> consensus address: sha256(ed25519 pubkey)[..20], bech32-encoded
/// with the valcons HRP derived from the valoper HRP. [VERIFY] key-rotation
/// handling on the deployed chain; the derivation follows the staking record.
fn cons_address(validator: &Validator) -> StdResult<String> {
    let any = validator
        .consensus_pubkey
        .as_ref()
        .ok_or_else(|| StdError::generic_err("validator missing consensus pubkey"))?;
    if any.type_url != ED25519_PUBKEY_TYPE_URL {
        return Err(StdError::generic_err(format!(
            "unsupported consensus key type: {}",
            any.type_url
        )));
    }
    let pk = Ed25519PubKey::decode(any.value.as_slice())
        .map_err(|e| StdError::generic_err(format!("bad consensus pubkey: {e}")))?;
    let hash = Sha256::digest(&pk.key);
    let (hrp, _) = bech32::decode(&validator.operator_address)
        .map_err(|e| StdError::generic_err(format!("bad valoper bech32: {e}")))?;
    let cons_hrp = hrp.as_str().replace("valoper", "valcons");
    let cons_hrp = Hrp::parse(&cons_hrp)
        .map_err(|e| StdError::generic_err(format!("bad valcons hrp: {e}")))?;
    bech32::encode::<Bech32>(cons_hrp, &hash[..20])
        .map_err(|e| StdError::generic_err(format!("bech32 encode failed: {e}")))
}

#[cfg(test)]
mod tests;

/// Jail-episode fingerprint regressions: an earlier-episode report must not
/// authorize a purge, and reports are only recorded where the program has stake.
#[cfg(test)]
mod jail_episode_tests;
