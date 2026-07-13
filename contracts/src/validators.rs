//! Validator enrollment, on-chain uptime eligibility and concentration headroom
//! (RC1 §9.7, §10.3, §10.4, §11.2, adapted to the Design C Phase 1 engine).
//!
//! Enrollment is operator-initiated (`RegisterParticipation`); the caller must be
//! the valoper's operator account, proven by comparing bech32 key payloads.
//! Eligibility is never stored: it is assessed from live chain state (staking
//! validator set, slashing SigningInfo) at plan/query time, so there is no
//! oracle and nothing to go stale.

use std::collections::BTreeMap;
use std::str::FromStr;

use bech32::{Bech32, Hrp};
use cosmwasm_std::{Deps, DepsMut, Env, MessageInfo, Response, StdError, StdResult, Storage, Uint128};
use prost::Message;
use provwasm_std::types::cosmos::base::query::v1beta1::PageRequest;
use provwasm_std::types::cosmos::crypto::ed25519::PubKey as Ed25519PubKey;
use provwasm_std::types::cosmos::slashing::v1beta1::SlashingQuerier;
use provwasm_std::types::cosmos::staking::v1beta1::{BondStatus, StakingQuerier, Validator};
use sha2::{Digest, Sha256};

use crate::plan::{commission_on, max_bond_adjusted, uptime_ratio_bps};
use crate::state::{Config, ValidatorRecord, CONFIG, JAIL_REPORTS, LAST_CAPTURE, VALIDATORS};
use crate::ContractError;

/// Hard cap on the enrolled validator set, matching the Provenance active-set
/// ceiling (100 validators). Rebalance moves are gas-chunked across
/// continuation cranks (max_delegations_per_run); the fixed per-crank work
/// (claims + assessments) scales with enrollment, so gas-profile the crank at
/// this bound before launch (spec §14 checklist).
pub const MAX_VALIDATORS: u32 = 100;

const PAGE_LIMIT: u64 = 100;
const ED25519_PUBKEY_TYPE_URL: &str = "/cosmos.crypto.ed25519.PubKey";

/// Provenance valoper HRPs end in "valoper" (pbvaloper1..., tpvaloper1...).
/// An account address here would brick the delegate leg, so reject early.
pub fn validate_valoper(valoper: &str) -> Result<(), ContractError> {
    if !valoper.contains("valoper1") {
        return Err(ContractError::InvalidValoper {
            valoper: valoper.to_string(),
        });
    }
    Ok(())
}

/// A validator's operator account and its valoper address share the same key
/// payload; only the bech32 HRP differs. Comparing decoded payloads proves the
/// caller controls the validator without any extra state.
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
    // Must exist on chain. A gRPC not-found comes back as an opaque generic
    // error, so any failure here is reported as not-found (the valoper is in
    // the message either way).
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

/// The single attached coin in the program's underlying denom, rejecting
/// anything else. Used by the PayCommission/PayTip fund intake.
fn attached_underlying(info: &MessageInfo, denom: &str) -> Result<Uint128, ContractError> {
    let amount = cw_utils::must_pay(info, denom)
        .map_err(|e| ContractError::Std(cosmwasm_std::StdError::generic_err(e.to_string())))?;
    Ok(amount)
}

/// Anyone may pay program commission on a validator's behalf (decided
/// 2026-07-09): paying only ever helps the validator, and funds are
/// non-refundable. Held in the contract balance and swept into vault principal
/// at the next epoch's deposit leg.
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

/// Anyone may TIP on a validator's behalf. Credits the current epoch's tip
/// (the primary priority key, §10.2); resets at every epoch completion.
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

/// Whether a validator currently produces a MEANINGFUL liveness signal
/// (RC1 §10.3/§10.4 fix, 2026-07-09): the slashing module's
/// missed_blocks_counter only advances for validators in the active (bonded)
/// set and RESETS to zero on a downtime jail, so the SigningInfo of a jailed
/// or unbonded validator reads as a vacuous perfect ratio. Captures must not
/// aggregate those samples, and the plan-time direct read must report no
/// signal rather than a confident 100%.
pub fn has_liveness_signal(validator: &Validator) -> bool {
    !validator.jailed && validator.status == BondStatus::Bonded as i32
}

/// The validator's live jail state: (jailed, unbonding_height). The height is
/// the jail-episode fingerprint stored with a report (see JailObservation).
/// A validator missing from the staking module is treated as not jailed
/// (there is nothing to purge from it; any delegation to it would already be
/// gone).
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

/// RC1 §9.8 phase 1 (permissionless): record the first observation of a jailed
/// validator, starting the jail_unbond_delay cooldown. Idempotent: repeat
/// reports while still jailed keep the ORIGINAL timestamp (so spam cannot
/// push the purge window out); an observation of an unjailed validator clears
/// any report (the validator recovered and keeps its stake).
pub fn report_jailed(
    deps: DepsMut,
    env: &Env,
    valoper: String,
) -> Result<Response, ContractError> {
    validate_valoper(&valoper)?;
    let resp = Response::new()
        .add_attribute("action", "report_jailed_validator")
        .add_attribute("valoper", valoper.clone());
    let (jailed, unbonding_height) = jail_state_on_chain(deps.as_ref(), &valoper);
    if jailed {
        // Reports exist to move program stake; a validator the program has no
        // live delegation on has nothing to purge, so recording it would only
        // seed a stale report for a later episode.
        let cfg = CONFIG.load(deps.storage)?;
        if program_stake_on(deps.as_ref(), env, &cfg, &valoper)?.is_zero() {
            return Ok(resp.add_attribute("result", "no_program_stake"));
        }
        if let Some(existing) = JAIL_REPORTS.may_load(deps.storage, &valoper)? {
            if existing.unbonding_height == unbonding_height {
                // Same episode: keep the ORIGINAL timestamp so spam cannot
                // push the purge window out.
                return Ok(resp.add_attribute("result", "already_reported"));
            }
            // A report from an earlier jail episode: restart the cycle on the
            // current one rather than inheriting the elapsed cooldown.
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

/// RC1 §9.8 phase 2 (permissionless, halt-gated): move the program's stake off
/// a validator that was jailed at the report AND is still jailed after the
/// cooldown (the two-observation sustained-downtime guard). With an eligible
/// claimant whose enrolled operator is the caller: redelegate up to the
/// claimant's concentration headroom and unbond the excess. Without one:
/// unbond everything. The unbonded stake matures back to the pool and
/// redeploys at a later epoch.
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

    // Storage-level gates first (cheap, unit-testable): a report must exist
    // and its cooldown must have elapsed.
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
    // Claimant authorization (storage-level): must be enrolled and the caller
    // must be its operator. Eligibility is checked against live state below.
    if let Some(cv) = &claimant_valoper {
        validate_valoper(cv)?;
        if *cv == valoper {
            return Err(ContractError::ClaimantNotEligible { valoper: cv.clone() });
        }
        let rec = VALIDATORS
            .may_load(deps.storage, cv)?
            .ok_or_else(|| ContractError::NotEnrolled { valoper: cv.clone() })?;
        if info.sender != rec.operator {
            return Err(ContractError::NotOperator { valoper: cv.clone() });
        }
    }

    // Second observation: still jailed NOW, or the report is void.
    let (jailed, unbonding_height) = jail_state_on_chain(deps.as_ref(), &valoper);
    if !jailed {
        JAIL_REPORTS.remove(deps.storage, &valoper);
        return Err(ContractError::NotJailed { valoper });
    }
    // Same jail EPISODE as the report, or the report is stale: the validator
    // unjailed and was jailed again without an intervening observation, so
    // the sustained-downtime guard has not actually run. Restart the cycle on
    // the current episode instead of purging against the old timestamp.
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

    // The program's live delegation. Zero = already purged: idempotent no-op,
    // first caller won.
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
            // Live claimant check: eligible per the full assessment (bonded,
            // unjailed, uptime, commission current) — the spec-recommended
            // strict reading — with concentration headroom bounding the gain.
            let assessment = assess_validators(deps.as_ref(), &cfg)?
                .into_iter()
                .find(|a| a.valoper == *cv)
                .ok_or_else(|| ContractError::NotEnrolled { valoper: cv.clone() })?;
            if !assessment.eligible {
                return Err(ContractError::ClaimantNotEligible { valoper: cv.clone() });
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
                    // The cap-excess cannot unbond right now (MaxEntries): the
                    // redelegation still proceeds; the remainder stays staked
                    // and a later purge (report retained) finishes the job.
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

    // Clear the report once the full delegation is handled, so a later
    // RE-jail always requires a fresh two-observation cycle. A deferred
    // remainder keeps the report (the validator is still jailed and a later
    // purge should not need a new cooldown).
    if deferred.is_zero() {
        JAIL_REPORTS.remove(deps.storage, &valoper);
    }

    // Moving the delegation auto-withdraws its pending rewards; fold them into
    // the epoch's claimed-rewards analytics (RC1 §9.10) and count the purge.
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

/// Accrue program commission for enrolled validators from a per-validator
/// claimed-rewards list (RC1 §10.1). Called at every point the contract
/// knowingly triggers a reward withdrawal, so no claimed reward escapes the
/// charge. Rewards on unenrolled validators accrue nothing.
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

/// Permissionless uptime capture (RC1 §10.4): fold every enrolled validator's
/// current signed-blocks ratio into its per-epoch accumulator. Interval-gated;
/// early calls are accepted no-ops so redundant keepers are harmless.
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
        // Only bonded, unjailed validators carry a liveness signal; a jailed
        // or unbonded validator's counter is frozen/reset and would fold a
        // vacuous 100% sample into the epoch mean (see has_liveness_signal).
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

/// Epoch rollover, applied at every epoch completion:
/// - uptime accumulators reset (RC1 §10.4)
/// - the per-epoch TIP resets (non-cumulative, §10.2)
/// - the commission grace boundary advances (§10.1): what was billed at the
///   previous completion becomes due now; the current cumulative accrual
///   becomes the next boundary. `paid < due` afterward means the validator
///   blew the one-epoch grace and assesses ineligible until brought current.
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
    /// Effective uptime: accumulator mean when captures exist, else the live
    /// signing-info read. None when it cannot be determined.
    pub uptime_bps: Option<u64>,
    /// Past the one-epoch commission grace (paid < due); alone disqualifies.
    pub in_arrears: bool,
    pub eligible: bool,
    /// New-delegation headroom under the concentration cap minus the safety
    /// offset. Zero when ineligible.
    pub headroom: Uint128,
}

/// Assess every enrolled validator against live chain state (RC1 §10.3 + §9.7):
/// one paginated sweep of the bonded set (active count + per-validator tokens),
/// one pool read (total bonded), one slashing-params read, then one SigningInfo
/// read per enrolled validator.
pub fn assess_validators(deps: Deps, cfg: &Config) -> StdResult<Vec<Assessment>> {
    let vals = enrolled(deps.storage)?;
    if vals.is_empty() {
        return Ok(vec![]);
    }
    let sq = StakingQuerier::new(&deps.querier);
    let (bonded_map, active_count) = bonded_validators(deps)?;
    let total_bonded = sq
        .pool()?
        .pool
        .map(|p| p.bonded_tokens)
        .unwrap_or_default();
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
        // Bonded sweep first; fall back to an individual read so jailed (not
        // bonded) validators still report accurate flags in queries.
        let (validator, bonded) = match bonded_map.get(&valoper) {
            Some(v) => (Some(v.clone()), true),
            None => (
                sq.validator(valoper.clone())
                    .ok()
                    .and_then(|resp| resp.validator),
                false,
            ),
        };
        // The direct read is only meaningful for a bonded, unjailed validator
        // (see has_liveness_signal); otherwise report no signal rather than
        // the vacuous 100% a frozen counter produces. Eligibility is
        // unaffected: jailed/unbonded already hard-fail below.
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

/// Program priority order, highest first (RC1 §10.2 two-key sort): TIP for the
/// current epoch descending, then effective uptime descending, then the stable
/// tie-break (earliest enrollment, then valoper). Deploy targets receive
/// largest-remainder units in this order; the redemption drain order is its
/// reverse (see drain_ranks).
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

/// Map valoper -> drain rank; LOWER ranks are unbonded first when raising
/// redemption liquidity (RC1 §8/§10.2). Unenrolled validators are absent
/// (rank 0 by convention at the caller): they drain before everything.
/// Enrolled-but-ineligible validators drain before eligible ones; within each
/// class, lowest priority drains first. Input must be priority-sorted
/// (assess_validators output).
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
        key = resp
            .pagination
            .and_then(|p| p.next_key)
            .unwrap_or_default();
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

/// Live signed-blocks ratio (bps) and tombstoned flag for a validator, via its
/// consensus address. None when the consensus key is not ed25519 or the signing
/// info is unavailable.
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

/// valoper -> consensus address: decode the ed25519 consensus pubkey, take
/// sha256(key)[..20], bech32-encode with the chain's valcons HRP (derived from
/// the valoper HRP). [VERIFY] key-rotation handling on the deployed chain; a
/// rotated key changes the cons address and this derivation follows the staking
/// record automatically.
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
mod tests {
    use super::*;

    #[test]
    fn is_operator_compares_key_payloads_across_hrps() {
        // Same 20-byte payload under account and valoper HRPs.
        let payload = [7u8; 20];
        let acct = bech32::encode::<Bech32>(Hrp::parse("tp").unwrap(), &payload).unwrap();
        let valoper =
            bech32::encode::<Bech32>(Hrp::parse("tpvaloper").unwrap(), &payload).unwrap();
        let other =
            bech32::encode::<Bech32>(Hrp::parse("tpvaloper").unwrap(), &[8u8; 20]).unwrap();
        assert!(is_operator(&acct, &valoper));
        assert!(!is_operator(&acct, &other));
        assert!(!is_operator("garbage", &valoper));
        assert!(!is_operator(&acct, "garbage"));
    }

    #[test]
    fn validate_valoper_requires_valoper_hrp() {
        assert!(validate_valoper("tpvaloper1abc").is_ok());
        assert!(matches!(
            validate_valoper("tp1abc"),
            Err(ContractError::InvalidValoper { .. })
        ));
    }

    #[test]
    fn cons_address_derives_from_ed25519_key() {
        use provwasm_std::shim::Any;
        let key = vec![1u8; 32];
        let pk = Ed25519PubKey { key: key.clone() };
        let validator = Validator {
            operator_address: bech32::encode::<Bech32>(
                Hrp::parse("tpvaloper").unwrap(),
                &[7u8; 20],
            )
            .unwrap(),
            consensus_pubkey: Some(Any {
                type_url: ED25519_PUBKEY_TYPE_URL.to_string(),
                value: pk.encode_to_vec(),
            }),
            ..Default::default()
        };
        let cons = cons_address(&validator).unwrap();
        assert!(cons.starts_with("tpvalcons1"));
        let (hrp, data) = bech32::decode(&cons).unwrap();
        assert_eq!(hrp.as_str(), "tpvalcons");
        assert_eq!(data.len(), 20);
        assert_eq!(data, Sha256::digest(&key)[..20].to_vec());
    }

    fn rec(enrolled_at: u64) -> ValidatorRecord {
        ValidatorRecord {
            operator: cosmwasm_std::Addr::unchecked("op"),
            enrolled_at: cosmwasm_std::Timestamp::from_seconds(enrolled_at),
            uptime_sum_bps: 0,
            uptime_count: 0,
            commission_accrued: Uint128::zero(),
            commission_paid: Uint128::zero(),
            commission_due: Uint128::zero(),
            commission_billed: Uint128::zero(),
            tip_epoch: Uint128::zero(),
        }
    }

    fn assessment(valoper: &str, tip: u128, uptime: Option<u64>, enrolled_at: u64, eligible: bool) -> Assessment {
        let mut record = rec(enrolled_at);
        record.tip_epoch = Uint128::new(tip);
        Assessment {
            valoper: valoper.to_string(),
            record,
            bonded: true,
            jailed: false,
            tombstoned: false,
            uptime_bps: uptime,
            in_arrears: false,
            eligible,
            headroom: Uint128::zero(),
        }
    }

    #[test]
    fn priority_sorts_tip_then_uptime_then_enrollment() {
        let mut v = vec![
            assessment("valD", 0, Some(9900), 5, true),  // no tip, high uptime
            assessment("valA", 100, Some(9000), 9, true), // top tip wins outright
            assessment("valB", 0, Some(9900), 2, true),  // ties valD on uptime, older
            assessment("valC", 0, None, 1, true),        // unknown uptime sorts as 0
        ];
        sort_by_priority(&mut v);
        let order: Vec<&str> = v.iter().map(|a| a.valoper.as_str()).collect();
        assert_eq!(order, vec!["valA", "valB", "valD", "valC"]);
    }

    #[test]
    fn drain_ranks_put_ineligible_before_eligible_lowest_priority_first() {
        let mut v = vec![
            assessment("valA", 100, Some(9900), 1, true),
            assessment("valB", 50, Some(9900), 1, true),
            assessment("valC", 0, Some(9000), 1, false), // ineligible
        ];
        sort_by_priority(&mut v);
        let ranks = drain_ranks(&v);
        // Ineligible valC drains before both eligible; among eligible, the
        // lower-priority valB drains before valA.
        assert!(ranks["valC"] < ranks["valB"]);
        assert!(ranks["valB"] < ranks["valA"]);

        let dels = vec![
            crate::plan::DelegationView { valoper: "valA".into(), staked: Uint128::new(1) },
            crate::plan::DelegationView { valoper: "zz-unenrolled".into(), staked: Uint128::new(1) },
            crate::plan::DelegationView { valoper: "valB".into(), staked: Uint128::new(1) },
            crate::plan::DelegationView { valoper: "valC".into(), staked: Uint128::new(1) },
        ];
        let ordered: Vec<String> = order_for_drain(dels, &ranks)
            .into_iter()
            .map(|d| d.valoper)
            .collect();
        assert_eq!(ordered, vec!["zz-unenrolled", "valC", "valB", "valA"]);
    }

    #[test]
    fn rollover_resets_tip_and_advances_grace_boundary() {
        let mut deps = cosmwasm_std::testing::mock_dependencies();
        let mut r = rec(1);
        r.tip_epoch = Uint128::new(500);
        r.uptime_sum_bps = 20_000;
        r.uptime_count = 2;
        r.commission_accrued = Uint128::new(1_000);
        VALIDATORS.save(deps.as_mut().storage, "tpvaloper1x", &r).unwrap();

        // Completion of epoch N: billed snapshots the accrual; nothing due yet.
        epoch_rollover(deps.as_mut().storage).unwrap();
        let r = VALIDATORS.load(&deps.storage, "tpvaloper1x").unwrap();
        assert_eq!(r.tip_epoch, Uint128::zero());
        assert_eq!(r.uptime_count, 0);
        assert_eq!(r.commission_due, Uint128::zero());
        assert_eq!(r.commission_billed, Uint128::new(1_000));

        // Completion of epoch N+1: the epoch-N accrual comes due (grace over).
        epoch_rollover(deps.as_mut().storage).unwrap();
        let r = VALIDATORS.load(&deps.storage, "tpvaloper1x").unwrap();
        assert_eq!(r.commission_due, Uint128::new(1_000));
        assert!(r.commission_paid < r.commission_due); // would assess in arrears
    }

    #[test]
    fn accrue_commission_charges_enrolled_only() {
        let mut deps = cosmwasm_std::testing::mock_dependencies();
        VALIDATORS.save(deps.as_mut().storage, "tpvaloper1a", &rec(1)).unwrap();
        accrue_commission(
            deps.as_mut().storage,
            &[
                ("tpvaloper1a".to_string(), Uint128::new(1_000)),
                ("tpvaloper1ghost".to_string(), Uint128::new(1_000)),
            ],
            1_000,
        )
        .unwrap();
        let r = VALIDATORS.load(&deps.storage, "tpvaloper1a").unwrap();
        assert_eq!(r.commission_accrued, Uint128::new(100));
        assert!(!VALIDATORS.has(&deps.storage, "tpvaloper1ghost"));
    }

    #[test]
    fn liveness_signal_requires_bonded_and_unjailed() {
        // Only a bonded, unjailed validator carries a meaningful
        // signed-blocks signal; jailed/unbonded counters are frozen or reset
        // and read as a vacuous 100%.
        let mut v = Validator {
            status: BondStatus::Bonded as i32,
            jailed: false,
            ..Default::default()
        };
        assert!(has_liveness_signal(&v));
        v.jailed = true;
        assert!(!has_liveness_signal(&v));
        v.jailed = false;
        v.status = BondStatus::Unbonded as i32;
        assert!(!has_liveness_signal(&v));
        v.status = BondStatus::Unbonding as i32;
        assert!(!has_liveness_signal(&v));
        v.status = BondStatus::Unspecified as i32;
        assert!(!has_liveness_signal(&v));
    }

    #[test]
    fn cons_address_rejects_non_ed25519() {
        use provwasm_std::shim::Any;
        let validator = Validator {
            operator_address: "tpvaloper1x".to_string(),
            consensus_pubkey: Some(Any {
                type_url: "/cosmos.crypto.secp256k1.PubKey".to_string(),
                value: vec![],
            }),
            ..Default::default()
        };
        assert!(cons_address(&validator).is_err());
    }
}

/// Regression tests for the jail-episode fingerprint (PR #2 review): a report
/// recorded during one jail episode must not authorize a purge in a LATER
/// episode, and reports are only recorded where the program has stake.
#[cfg(test)]
mod jail_episode_tests {
    use super::*;
    use cosmwasm_std::testing::{message_info, mock_env};
    use cosmwasm_std::{
        Binary, Coin as CwCoin, ContractResult, Decimal, FullDelegation, SystemResult,
        Validator as CwValidator,
    };
    use prost::Message as _;
    use provwasm_common::MockableQuerier;
    use provwasm_mocks::{mock_provenance_dependencies, MockProvenanceQuerier};
    use provwasm_std::types::cosmos::staking::v1beta1::{
        QueryDelegatorUnbondingDelegationsResponse, QueryValidatorResponse,
        Validator as PValidator,
    };

    const VALOPER: &str = "tpvaloper1epi0000000000000000000000000000000000";

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

    /// (Re-)register the chain's view of the validator: jailed or not, and the
    /// unbonding_height that fingerprints the current jail episode.
    fn set_validator(q: &mut MockProvenanceQuerier, jailed: bool, unbonding_height: i64) {
        grpc(
            q,
            "/cosmos.staking.v1beta1.Query/Validator",
            &QueryValidatorResponse {
                validator: Some(PValidator {
                    operator_address: VALOPER.to_string(),
                    jailed,
                    tokens: "1000".to_string(),
                    unbonding_height,
                    ..Default::default()
                }),
            },
        );
    }

    fn setup(
        with_stake: bool,
    ) -> cosmwasm_std::OwnedDeps<
        cosmwasm_std::testing::MockStorage,
        cosmwasm_std::testing::MockApi,
        MockProvenanceQuerier,
    > {
        let mut deps = mock_provenance_dependencies();
        let env = mock_env();
        let admin = deps.api.addr_make("admin");
        let vault = deps.api.addr_make("vault");
        crate::contract::instantiate(
            deps.as_mut(),
            env.clone(),
            message_info(&admin, &[]),
            crate::msg::InstantiateMsg {
                admin: admin.to_string(),
                vault_address: vault.to_string(),
                underlying_denom: "nhash".to_string(),
                receipt_denom: "nvhash.staked".to_string(),
                min_run_interval_secs: 0,
                max_delegations_per_run: 0,
                aum_fee_bps: 0,
                performance_threshold_bps: 0,
                min_capture_interval_secs: 0,
                max_concentration_multiple_bps: None,
                min_bonded_cap_bps: None,
                max_bonded_cap_bps: None,
                concentration_safety_offset_bps: None,
                commission_bps: None,
                jail_unbond_delay_secs: None, // 8h default
            },
        )
        .unwrap();
        if with_stake {
            let zero = CwCoin::new(0u128, "nhash");
            deps.querier.mock_querier.staking.update(
                "nhash",
                &[CwValidator::create(
                    VALOPER.to_string(),
                    Decimal::zero(),
                    Decimal::one(),
                    Decimal::one(),
                )],
                &[FullDelegation::create(
                    env.contract.address.clone(),
                    VALOPER.to_string(),
                    CwCoin::new(1_000u128, "nhash"),
                    zero,
                    vec![],
                )],
            );
        }
        grpc(
            &mut deps.querier,
            "/cosmos.staking.v1beta1.Query/DelegatorUnbondingDelegations",
            &QueryDelegatorUnbondingDelegationsResponse {
                unbonding_responses: vec![],
                pagination: None,
            },
        );
        deps
    }

    #[test]
    fn stale_report_from_earlier_jail_episode_cannot_bypass_cooldown() {
        let mut deps = setup(true);
        let env0 = mock_env();
        let delay = crate::contract::DEFAULT_JAIL_UNBOND_DELAY_SECS;

        // Episode 1: jailed at unbonding_height 100; report recorded.
        set_validator(&mut deps.querier, true, 100);
        let res = report_jailed(deps.as_mut(), &env0, VALOPER.to_string()).unwrap();
        assert!(res.attributes.iter().any(|a| a.value == "reported"));
        // Idempotent within the episode: original timestamp kept.
        let res = report_jailed(deps.as_mut(), &env0, VALOPER.to_string()).unwrap();
        assert!(res.attributes.iter().any(|a| a.value == "already_reported"));

        // The validator unjails and is jailed AGAIN (episode 2, height 200)
        // with no observation in between. The old report's cooldown has fully
        // elapsed — the purge must still refuse and restart the cycle.
        let mut env1 = env0.clone();
        env1.block.time = env0.block.time.plus_seconds(delay + 1_000);
        set_validator(&mut deps.querier, true, 200);
        let info = message_info(&deps.api.addr_make("keeper"), &[]);
        let err =
            purge_jailed(deps.as_mut(), &env1, &info, VALOPER.to_string(), None).unwrap_err();
        match err {
            ContractError::JailCooldownActive { ready } => {
                assert_eq!(ready, env1.block.time.seconds() + delay, "cooldown must restart NOW");
            }
            other => panic!("expected restarted cooldown, got {other:?}"),
        }
        // The report was refreshed onto episode 2.
        let obs = JAIL_REPORTS.load(&deps.storage, VALOPER).unwrap();
        assert_eq!(obs.unbonding_height, 200);
        assert_eq!(obs.reported_at, env1.block.time);

        // Same episode after the restarted cooldown: the purge proceeds and
        // unbonds the full program delegation.
        let mut env2 = env1.clone();
        env2.block.time = env1.block.time.plus_seconds(delay + 1);
        let res = purge_jailed(deps.as_mut(), &env2, &info, VALOPER.to_string(), None).unwrap();
        assert!(matches!(
            &res.messages[0].msg,
            cosmwasm_std::CosmosMsg::Staking(cosmwasm_std::StakingMsg::Undelegate { validator, amount })
                if validator == VALOPER && amount.amount.u128() == 1_000
        ));
        assert!(!JAIL_REPORTS.has(&deps.storage, VALOPER));
    }

    #[test]
    fn report_is_recorded_only_where_the_program_has_stake() {
        let mut deps = setup(false);
        set_validator(&mut deps.querier, true, 100);
        let res = report_jailed(deps.as_mut(), &mock_env(), VALOPER.to_string()).unwrap();
        assert!(res.attributes.iter().any(|a| a.value == "no_program_stake"));
        assert!(!JAIL_REPORTS.has(&deps.storage, VALOPER));
    }
}
