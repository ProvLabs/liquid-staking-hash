#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{
    to_json_binary, Binary, CosmosMsg, Deps, DepsMut, Env, MessageInfo, Response, StdResult,
    Uint128,
};
use cw2::set_contract_version;
use provwasm_std::types::provlabs::vault::v1::{MsgPauseVaultRequest, MsgUnpauseVaultRequest};

use crate::msg::{
    ConfigResponse, EpochStatusResponse, ExecuteMsg, InstantiateMsg, MigrateMsg, PendingDelegation,
    QueryMsg, ValidatorStatus, ValidatorsResponse,
};
use crate::state::{
    Config, EpochPhase, EpochState, CONFIG, EPOCH, HALTED, PENDING_DELEGATIONS, RECEIPT_MINTED,
};
use crate::validators;
use crate::ContractError;

pub const CONTRACT_NAME: &str = "crates.io:nvhash-staking";
pub const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Provenance staking-restriction defaults ([VERIFY] live values; admin-updatable).
pub const DEFAULT_MAX_CONCENTRATION_MULTIPLE_BPS: u64 = 55_000; // 5.5x
pub const DEFAULT_MIN_BONDED_CAP_BPS: u64 = 500; // 5%
pub const DEFAULT_MAX_BONDED_CAP_BPS: u64 = 3_300; // 33%
/// Default safety margin below the per-validator max bond.
pub const DEFAULT_CONCENTRATION_SAFETY_OFFSET_BPS: u64 = 500; // 5% of max bond
/// Default program commission: 10% of rewards on program delegations.
pub const DEFAULT_COMMISSION_BPS: u64 = 1_000;
/// Default jail-purge cooldown before stake may move off a jailed validator.
pub const DEFAULT_JAIL_UNBOND_DELAY_SECS: u64 = 28_800;
/// Default redemption safety margin; state.rs's serde default returns the same 50.
pub const DEFAULT_REDEMPTION_MARGIN_BPS: u64 = 50;

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    let config = Config {
        admin: deps.api.addr_validate(&msg.admin)?,
        vault_address: deps.api.addr_validate(&msg.vault_address)?,
        underlying_denom: msg.underlying_denom,
        receipt_denom: msg.receipt_denom,
        max_delegations_per_run: msg.max_delegations_per_run,
        aum_fee_bps: msg.aum_fee_bps,
        performance_threshold_bps: msg.performance_threshold_bps,
        min_capture_interval_secs: msg.min_capture_interval_secs,
        max_concentration_multiple_bps: msg
            .max_concentration_multiple_bps
            .unwrap_or(DEFAULT_MAX_CONCENTRATION_MULTIPLE_BPS),
        min_bonded_cap_bps: msg.min_bonded_cap_bps.unwrap_or(DEFAULT_MIN_BONDED_CAP_BPS),
        max_bonded_cap_bps: msg.max_bonded_cap_bps.unwrap_or(DEFAULT_MAX_BONDED_CAP_BPS),
        concentration_safety_offset_bps: msg
            .concentration_safety_offset_bps
            .unwrap_or(DEFAULT_CONCENTRATION_SAFETY_OFFSET_BPS),
        commission_bps: msg.commission_bps.unwrap_or(DEFAULT_COMMISSION_BPS),
        jail_unbond_delay_secs: msg
            .jail_unbond_delay_secs
            .unwrap_or(DEFAULT_JAIL_UNBOND_DELAY_SECS),
        redemption_margin_bps: msg
            .redemption_margin_bps
            .unwrap_or(DEFAULT_REDEMPTION_MARGIN_BPS),
    };
    config.validate()?;
    CONFIG.save(deps.storage, &config)?;
    EPOCH.save(deps.storage, &EpochState::default())?;
    RECEIPT_MINTED.save(deps.storage, &Uint128::zero())?;
    PENDING_DELEGATIONS.save(deps.storage, &vec![])?;
    crate::state::PENDING_REDELEGATIONS.save(deps.storage, &vec![])?;
    HALTED.save(deps.storage, &false)?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

/// Handles `MsgMigrateContract` (wasmd verified the admin). Rejects a foreign cw2 name
/// or a newer stored version; equal is idempotent. Re-stamps cw2 and touches no other
/// state; a future layout change must handle the `Releasing` phase explicitly.
#[cfg_attr(not(feature = "library"), entry_point)]
pub fn migrate(deps: DepsMut, _env: Env, _msg: MigrateMsg) -> Result<Response, ContractError> {
    let stored = cw2::get_contract_version(deps.storage)?;
    if stored.contract != CONTRACT_NAME {
        return Err(ContractError::InvalidMigration {
            stored: stored.contract,
            expected: CONTRACT_NAME.to_string(),
        });
    }
    let stored_version = semver::Version::parse(&stored.version).map_err(|_| {
        ContractError::InvalidMigrationVersion {
            version: stored.version.clone(),
        }
    })?;
    let code_version = semver::Version::parse(CONTRACT_VERSION).map_err(|_| {
        ContractError::InvalidMigrationVersion {
            version: CONTRACT_VERSION.to_string(),
        }
    })?;
    if stored_version > code_version {
        return Err(ContractError::MigrationDowngrade {
            stored: stored.version,
            current: CONTRACT_VERSION.to_string(),
        });
    }
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    Ok(Response::new()
        .add_attribute("action", "migrate")
        .add_attribute("from_version", stored.version)
        .add_attribute("to_version", CONTRACT_VERSION))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::PauseVault { reason } => exec_pause(deps.as_ref(), env, &info, reason),
        ExecuteMsg::UnpauseVault {} => exec_unpause(deps.as_ref(), env, &info),
        ExecuteMsg::UpdateConfig {
            max_delegations_per_run,
            aum_fee_bps,
            performance_threshold_bps,
            min_capture_interval_secs,
            max_concentration_multiple_bps,
            min_bonded_cap_bps,
            max_bonded_cap_bps,
            concentration_safety_offset_bps,
            commission_bps,
            jail_unbond_delay_secs,
            redemption_margin_bps,
        } => exec_update_config(
            deps,
            &info,
            max_delegations_per_run,
            aum_fee_bps,
            performance_threshold_bps,
            min_capture_interval_secs,
            max_concentration_multiple_bps,
            min_bonded_cap_bps,
            max_bonded_cap_bps,
            concentration_safety_offset_bps,
            commission_bps,
            jail_unbond_delay_secs,
            redemption_margin_bps,
        ),
        ExecuteMsg::SetHalted { halted } => exec_set_halted(deps, &info, halted),
        ExecuteMsg::ClearPendingDelegations {} => exec_clear_pending_delegations(deps, &info),
        ExecuteMsg::RegisterParticipation { valoper } => {
            validators::register(deps, env, &info, valoper)
        }
        ExecuteMsg::UnregisterParticipation { valoper } => {
            validators::unregister(deps, &info, valoper)
        }
        ExecuteMsg::ReportJailedValidator { valoper } => {
            validators::report_jailed(deps, &env, valoper)
        }
        ExecuteMsg::PurgeJailedValidator {
            valoper,
            claimant_valoper,
        } => validators::purge_jailed(deps, &env, &info, valoper, claimant_valoper),
        ExecuteMsg::PayCommission { valoper } => validators::pay_commission(deps, &info, valoper),
        ExecuteMsg::PayTip { valoper } => validators::pay_tip(deps, &info, valoper),
        ExecuteMsg::CaptureUptimeSignal {} => validators::capture_uptime(deps, &env),
        ExecuteMsg::ClaimRewards {} => crate::epoch::claim_rewards(deps, &env),
        ExecuteMsg::ServiceRedemptions {} => crate::epoch::service_redemptions(deps, &env),
        ExecuteMsg::RunEpoch {} => crate::epoch::run_epoch(deps, env),
    }
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::ReceiptAccounting {} => {
            // The receipt-conservation invariant's legs in one consistent state read (D29).
            let cfg = CONFIG.load(deps.storage)?;
            let receipt_minted = RECEIPT_MINTED.load(deps.storage)?;
            let receipt_bank_supply = deps.querier.query_supply(&cfg.receipt_denom)?.amount;
            let staked: Uint128 = deps
                .querier
                .query_all_delegations(env.contract.address.clone())?
                .into_iter()
                .filter(|d| d.amount.denom == cfg.underlying_denom)
                .fold(Uint128::zero(), |sum, d| sum + d.amount.amount);
            let (unbonding, _at_capacity) = crate::epoch::unbonding_state(deps, &env)?;
            let pending_deployment: Uint128 = PENDING_DELEGATIONS
                .load(deps.storage)?
                .iter()
                .fold(Uint128::zero(), |sum, (_, a)| sum + *a);
            let matured_unsettled = receipt_minted
                .saturating_sub(staked)
                .saturating_sub(unbonding)
                .saturating_sub(pending_deployment);
            to_json_binary(&crate::msg::ReceiptAccountingResponse {
                receipt_minted,
                receipt_bank_supply,
                staked,
                unbonding,
                pending_deployment,
                matured_unsettled,
            })
        }
        QueryMsg::Config {} => {
            let c = CONFIG.load(deps.storage)?;
            to_json_binary(&ConfigResponse {
                admin: c.admin.to_string(),
                vault_address: c.vault_address.to_string(),
                underlying_denom: c.underlying_denom,
                receipt_denom: c.receipt_denom,
                max_delegations_per_run: c.max_delegations_per_run,
                aum_fee_bps: c.aum_fee_bps,
                performance_threshold_bps: c.performance_threshold_bps,
                min_capture_interval_secs: c.min_capture_interval_secs,
                max_concentration_multiple_bps: c.max_concentration_multiple_bps,
                min_bonded_cap_bps: c.min_bonded_cap_bps,
                max_bonded_cap_bps: c.max_bonded_cap_bps,
                concentration_safety_offset_bps: c.concentration_safety_offset_bps,
                commission_bps: c.commission_bps,
                jail_unbond_delay_secs: c.jail_unbond_delay_secs,
                redemption_margin_bps: c.redemption_margin_bps,
            })
        }
        QueryMsg::EpochStatus {} => {
            let e = EPOCH.load(deps.storage)?;
            let receipt_minted = RECEIPT_MINTED.load(deps.storage)?;
            let pending = PENDING_DELEGATIONS.load(deps.storage)?;
            let halted = HALTED.may_load(deps.storage)?.unwrap_or(false);
            let pending_redel = crate::state::PENDING_REDELEGATIONS
                .may_load(deps.storage)?
                .unwrap_or_default();
            to_json_binary(&EpochStatusResponse {
                phase: format!("{:?}", e.phase),
                halted,
                last_run_seconds: e.last_run.seconds(),
                receipt_minted,
                pending_delegations: pending
                    .into_iter()
                    .map(|(valoper, amount)| PendingDelegation { valoper, amount })
                    .collect(),
                pending_redelegations: pending_redel
                    .into_iter()
                    .map(|(src, dst, amount)| crate::msg::PendingRedelegation { src, dst, amount })
                    .collect(),
            })
        }
        QueryMsg::Validators {} => {
            let cfg = CONFIG.load(deps.storage)?;
            let statuses: Vec<ValidatorStatus> = validators::assess_validators(deps, &cfg)?
                .into_iter()
                .map(|a| ValidatorStatus {
                    valoper: a.valoper,
                    operator: a.record.operator.to_string(),
                    enrolled_at_seconds: a.record.enrolled_at.seconds(),
                    uptime_capture_count: a.record.uptime_count,
                    uptime_bps: a.uptime_bps,
                    jailed: a.jailed,
                    tombstoned: a.tombstoned,
                    tip_epoch: a.record.tip_epoch,
                    commission_accrued: a.record.commission_accrued,
                    commission_paid: a.record.commission_paid,
                    commission_due: a.record.commission_due,
                    in_arrears: a.in_arrears,
                    eligible: a.eligible,
                    headroom: a.headroom,
                })
                .collect();
            to_json_binary(&ValidatorsResponse {
                validators: statuses,
            })
        }
        QueryMsg::JailReports {} => {
            let cfg = CONFIG.load(deps.storage)?;
            let reports: Vec<crate::msg::JailReport> = crate::state::JAIL_REPORTS
                .range(deps.storage, None, None, cosmwasm_std::Order::Ascending)
                .map(|item| {
                    item.map(|(valoper, obs)| crate::msg::JailReport {
                        valoper,
                        reported_at_seconds: obs.reported_at.seconds(),
                        purge_ready_at_seconds: obs
                            .reported_at
                            .seconds()
                            .saturating_add(cfg.jail_unbond_delay_secs),
                    })
                })
                .collect::<StdResult<_>>()?;
            to_json_binary(&crate::msg::JailReportsResponse { reports })
        }
        QueryMsg::EpochSnapshot {} => to_json_binary(&crate::msg::EpochSnapshotResponse {
            snapshot: crate::state::LAST_SNAPSHOT.may_load(deps.storage)?,
        }),
        QueryMsg::Apr {} => {
            let s = crate::state::LAST_SNAPSHOT.may_load(deps.storage)?;
            let resp = match s {
                None => crate::msg::AprResponse {
                    epoch_index: 0,
                    window_seconds: 0,
                    tvv_before: Uint128::zero(),
                    rewards_claimed: Uint128::zero(),
                    commission_received: Uint128::zero(),
                    tips_received: Uint128::zero(),
                    aum_fee_estimate: Uint128::zero(),
                    write_down: Uint128::zero(),
                    gross_apr_bps: 0,
                    net_apr_bps: 0,
                },
                Some(s) => {
                    let window = s.ended_at_seconds.saturating_sub(s.started_at_seconds);
                    let gross = s.rewards_claimed + s.commission_received + s.tips_received;
                    let net = gross.saturating_sub(s.aum_fee_estimate + s.write_down);
                    crate::msg::AprResponse {
                        epoch_index: s.epoch_index,
                        window_seconds: window,
                        tvv_before: s.tvv_before,
                        rewards_claimed: s.rewards_claimed,
                        commission_received: s.commission_received,
                        tips_received: s.tips_received,
                        aum_fee_estimate: s.aum_fee_estimate,
                        write_down: s.write_down,
                        gross_apr_bps: crate::plan::annualized_bps(gross, s.tvv_before, window),
                        net_apr_bps: crate::plan::annualized_bps(net, s.tvv_before, window),
                    }
                }
            };
            to_json_binary(&resp)
        }
    }
}

pub fn assert_admin(deps: Deps, info: &MessageInfo) -> Result<(), ContractError> {
    let c = CONFIG.load(deps.storage)?;
    if info.sender != c.admin {
        return Err(ContractError::Unauthorized {});
    }
    Ok(())
}

fn exec_pause(
    deps: Deps,
    env: Env,
    info: &MessageInfo,
    reason: String,
) -> Result<Response, ContractError> {
    assert_admin(deps, info)?;
    let c = CONFIG.load(deps.storage)?;
    let msg: CosmosMsg = MsgPauseVaultRequest {
        authority: env.contract.address.to_string(),
        vault_address: c.vault_address.to_string(),
        reason,
    }
    .into();
    Ok(Response::new()
        .add_message(msg)
        .add_attribute("action", "pause_vault"))
}

fn exec_unpause(deps: Deps, env: Env, info: &MessageInfo) -> Result<Response, ContractError> {
    assert_admin(deps, info)?;
    let c = CONFIG.load(deps.storage)?;
    let msg: CosmosMsg = MsgUnpauseVaultRequest {
        authority: env.contract.address.to_string(),
        vault_address: c.vault_address.to_string(),
    }
    .into();
    Ok(Response::new()
        .add_message(msg)
        .add_attribute("action", "unpause_vault"))
}

#[allow(clippy::too_many_arguments)]
fn exec_update_config(
    deps: DepsMut,
    info: &MessageInfo,
    max_delegations_per_run: Option<u32>,
    aum_fee_bps: Option<u64>,
    performance_threshold_bps: Option<u64>,
    min_capture_interval_secs: Option<u64>,
    max_concentration_multiple_bps: Option<u64>,
    min_bonded_cap_bps: Option<u64>,
    max_bonded_cap_bps: Option<u64>,
    concentration_safety_offset_bps: Option<u64>,
    commission_bps: Option<u64>,
    jail_unbond_delay_secs: Option<u64>,
    redemption_margin_bps: Option<u64>,
) -> Result<Response, ContractError> {
    assert_admin(deps.as_ref(), info)?;
    CONFIG.update(deps.storage, |mut c| -> Result<_, ContractError> {
        if let Some(v) = max_delegations_per_run {
            c.max_delegations_per_run = v;
        }
        if let Some(v) = aum_fee_bps {
            c.aum_fee_bps = v;
        }
        if let Some(v) = performance_threshold_bps {
            c.performance_threshold_bps = v;
        }
        if let Some(v) = min_capture_interval_secs {
            c.min_capture_interval_secs = v;
        }
        if let Some(v) = max_concentration_multiple_bps {
            c.max_concentration_multiple_bps = v;
        }
        if let Some(v) = min_bonded_cap_bps {
            c.min_bonded_cap_bps = v;
        }
        if let Some(v) = max_bonded_cap_bps {
            c.max_bonded_cap_bps = v;
        }
        if let Some(v) = concentration_safety_offset_bps {
            c.concentration_safety_offset_bps = v;
        }
        if let Some(v) = commission_bps {
            c.commission_bps = v;
        }
        if let Some(v) = jail_unbond_delay_secs {
            c.jail_unbond_delay_secs = v;
        }
        if let Some(v) = redemption_margin_bps {
            c.redemption_margin_bps = v;
        }
        c.validate()?;
        Ok(c)
    })?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

fn exec_set_halted(
    deps: DepsMut,
    info: &MessageInfo,
    halted: bool,
) -> Result<Response, ContractError> {
    assert_admin(deps.as_ref(), info)?;
    HALTED.save(deps.storage, &halted)?;
    Ok(Response::new()
        .add_attribute("action", "set_halted")
        .add_attribute("halted", halted.to_string()))
}

fn exec_clear_pending_delegations(
    deps: DepsMut,
    info: &MessageInfo,
) -> Result<Response, ContractError> {
    assert_admin(deps.as_ref(), info)?;
    let pending = PENDING_DELEGATIONS.load(deps.storage)?;
    let dropped: Uint128 = pending
        .iter()
        .map(|(_, a)| *a)
        .fold(Uint128::zero(), |s, a| s + a);
    let dropped_redel: Uint128 = crate::state::PENDING_REDELEGATIONS
        .may_load(deps.storage)?
        .unwrap_or_default()
        .iter()
        .map(|(_, _, a)| *a)
        .fold(Uint128::zero(), |s, a| s + a);
    PENDING_DELEGATIONS.save(deps.storage, &vec![])?;
    crate::state::PENDING_REDELEGATIONS.save(deps.storage, &vec![])?;
    EPOCH.update(deps.storage, |mut e| -> Result<_, ContractError> {
        e.phase = EpochPhase::Idle;
        Ok(e)
    })?;
    Ok(Response::new()
        .add_attribute("action", "clear_pending_delegations")
        .add_attribute("dropped_nhash", dropped.to_string())
        .add_attribute("dropped_redelegations_nhash", dropped_redel.to_string()))
}

#[cfg(test)]
mod unit;
