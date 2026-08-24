use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Uint128;

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub vault_address: String,
    pub underlying_denom: String,
    pub receipt_denom: String,
    #[serde(default)]
    pub max_delegations_per_run: u32,
    #[serde(default)]
    pub aum_fee_bps: u64,
    /// Uptime eligibility threshold in bps (0 = uptime gating disabled).
    #[serde(default)]
    pub performance_threshold_bps: u64,
    /// Min seconds between accepted uptime captures (0 = every call accepted).
    #[serde(default)]
    pub min_capture_interval_secs: u64,
    /// Concentration-cap mirrors; None = Provenance defaults (5.5x, 5%, 33%, 5% safety offset).
    pub max_concentration_multiple_bps: Option<u64>,
    pub min_bonded_cap_bps: Option<u64>,
    pub max_bonded_cap_bps: Option<u64>,
    pub concentration_safety_offset_bps: Option<u64>,
    /// Program commission rate in bps of rewards on program delegations. None = 10% default.
    pub commission_bps: Option<u64>,
    /// Cooldown between jail report and purge. None = 8h default.
    pub jail_unbond_delay_secs: Option<u64>,
    /// Safety margin over the pending-redemption need in bps, bounded 0..=1000. None = 50.
    pub redemption_margin_bps: Option<u64>,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Admin-gated: pause the managed vault (manual override / emergency stop).
    PauseVault { reason: String },
    /// Admin-gated: unpause the managed vault.
    UnpauseVault {},
    /// Admin-gated: update program configuration. Only supplied fields change.
    UpdateConfig {
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
    },
    /// Admin-gated: emergency stop/resume for the fund-moving permissionless cranks
    /// (RunEpoch, ServiceRedemptions). Does not touch the vault's own pause state.
    SetHalted { halted: bool },
    /// Admin-gated: abort a stuck epoch continuation by dropping the persisted delegation
    /// targets; the withdrawn nhash settles at the next epoch, so TVV is preserved.
    ClearPendingDelegations {},
    /// Enroll a validator in the program; the caller must be the valoper's operator
    /// account and the validator must exist on chain.
    RegisterParticipation { valoper: String },
    /// Operator or admin: withdraw a validator; its program stake is unbonded at the
    /// next epoch and redeployed.
    UnregisterParticipation { valoper: String },
    /// Permissionless: report a jailed validator, starting the jail_unbond_delay cooldown;
    /// a report on an unjailed validator clears instead. Moves no funds.
    ReportJailedValidator { valoper: String },
    /// Permissionless (halt-gated): after the cooldown, move stake off a still-jailed
    /// validator (redelegate to an eligible claimant's headroom, else unbond all).
    PurgeJailedValidator {
        valoper: String,
        claimant_valoper: Option<String>,
    },
    /// Anyone (nhash attached): pay program commission for an enrolled validator.
    /// Non-refundable; overpayment prepays future accrual; swept into vault principal next epoch.
    PayCommission { valoper: String },
    /// Anyone (nhash attached): pay a tip for an enrolled validator. Credits the current
    /// epoch's tip (the primary priority key, reset each epoch); non-refundable.
    PayTip { valoper: String },
    /// Permissionless: fold each enrolled validator's signed-blocks ratio into its per-epoch
    /// uptime accumulator. Interval-gated; early calls are accepted no-ops.
    CaptureUptimeSignal {},
    /// Permissionless: withdraw accrued staking rewards for every delegated validator.
    /// Call in a tx before RunEpoch so the current epoch's deposit includes them.
    ClaimRewards {},
    /// Permissionless (halt-gated): unbond to cover queued swap-outs and expedite funded
    /// ones; expedites are gated on principal-marker liquidity only.
    ServiceRedemptions {},
    /// Permissionless (min-interval and halt guarded): the full epoch crank.
    /// Bypasses the interval guard only to drain a pending continuation.
    RunEpoch {},
}

/// Empty migration message; migration only re-stamps the cw2 version record.
#[cw_serde]
pub struct MigrateMsg {}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ConfigResponse)]
    Config {},
    #[returns(EpochStatusResponse)]
    EpochStatus {},
    /// Enrolled validators with live eligibility read from current chain state, sorted by
    /// program priority (tip desc, uptime desc, enrollment age), highest first.
    #[returns(ValidatorsResponse)]
    Validators {},
    /// Open jail reports: validators observed jailed and the time a purge becomes allowed.
    #[returns(JailReportsResponse)]
    JailReports {},
    /// The most recent epoch's value decomposition; None before the first epoch crank.
    #[returns(EpochSnapshotResponse)]
    EpochSnapshot {},
    /// Realized APR over the last epoch window with the gross-to-net breakdown.
    /// None before the first epoch crank.
    #[returns(AprResponse)]
    Apr {},
    /// The receipt-conservation invariant's legs in one consistent state read.
    /// Read-only, permissionless, bounded by the validator ceiling.
    #[returns(ReceiptAccountingResponse)]
    ReceiptAccounting {},
}

#[cw_serde]
pub struct ConfigResponse {
    pub admin: String,
    pub vault_address: String,
    pub underlying_denom: String,
    pub receipt_denom: String,
    pub max_delegations_per_run: u32,
    pub aum_fee_bps: u64,
    pub performance_threshold_bps: u64,
    pub min_capture_interval_secs: u64,
    pub max_concentration_multiple_bps: u64,
    pub min_bonded_cap_bps: u64,
    pub max_bonded_cap_bps: u64,
    pub concentration_safety_offset_bps: u64,
    pub commission_bps: u64,
    pub jail_unbond_delay_secs: u64,
    pub redemption_margin_bps: u64,
}

/// The receipt-conservation invariant's legs from one consistent state read;
/// all amounts are base units of the denom noted per field.
#[cw_serde]
pub struct ReceiptAccountingResponse {
    /// The contract's own minted counter (receipt base units).
    pub receipt_minted: cosmwasm_std::Uint128,
    /// Bank total supply of the receipt denom.
    pub receipt_bank_supply: cosmwasm_std::Uint128,
    /// Sum of live program delegations (nhash base units).
    pub staked: cosmwasm_std::Uint128,
    /// In-flight unbonding across program validators (nhash base units).
    pub unbonding: cosmwasm_std::Uint128,
    /// Earmarked PENDING_DELEGATIONS total (nhash base units).
    pub pending_deployment: cosmwasm_std::Uint128,
    /// minted - staked - unbonding - pending, saturating at zero (matured-but-unsettled residual).
    pub matured_unsettled: cosmwasm_std::Uint128,
}

#[cw_serde]
pub struct EpochSnapshotResponse {
    pub snapshot: Option<crate::state::EpochSnapshot>,
}

#[cw_serde]
pub struct AprResponse {
    pub epoch_index: u64,
    /// Seconds between the previous and last snapshot (the measurement window).
    pub window_seconds: u64,
    pub tvv_before: Uint128,
    /// Window inflow components.
    pub rewards_claimed: Uint128,
    pub commission_received: Uint128,
    pub tips_received: Uint128,
    /// Window drags: the AUM estimate and slash losses recognized this epoch.
    pub aum_fee_estimate: Uint128,
    pub write_down: Uint128,
    /// (rewards + commission + tips) annualized against tvv_before, in bps.
    pub gross_apr_bps: u64,
    /// Gross inflow minus drags (floored at zero) annualized, in bps.
    pub net_apr_bps: u64,
}

#[cw_serde]
pub struct JailReportsResponse {
    pub reports: Vec<JailReport>,
}

#[cw_serde]
pub struct JailReport {
    pub valoper: String,
    pub reported_at_seconds: u64,
    /// reported_at + jail_unbond_delay: the earliest a purge may execute.
    pub purge_ready_at_seconds: u64,
}

#[cw_serde]
pub struct EpochStatusResponse {
    pub phase: String,
    pub halted: bool,
    pub last_run_seconds: u64,
    pub receipt_minted: Uint128,
    pub pending_delegations: Vec<PendingDelegation>,
    /// Uniform-slot rebalance moves awaiting continuation cranks.
    #[serde(default)]
    pub pending_redelegations: Vec<PendingRedelegation>,
}

#[cw_serde]
pub struct PendingRedelegation {
    pub src: String,
    pub dst: String,
    pub amount: Uint128,
}

#[cw_serde]
pub struct PendingDelegation {
    pub valoper: String,
    pub amount: Uint128,
}

#[cw_serde]
pub struct ValidatorsResponse {
    pub validators: Vec<ValidatorStatus>,
}

#[cw_serde]
pub struct ValidatorStatus {
    pub valoper: String,
    pub operator: String,
    pub enrolled_at_seconds: u64,
    /// Captures folded into the current epoch's accumulator.
    pub uptime_capture_count: u32,
    /// Effective uptime in bps (accumulator mean, else live signing-info read); None when
    /// uptime cannot be determined.
    pub uptime_bps: Option<u64>,
    pub jailed: bool,
    pub tombstoned: bool,
    /// TIP credited for the current epoch (primary priority key).
    pub tip_epoch: Uint128,
    /// Cumulative commission accrued/paid, and the grace boundary the paid total must meet.
    pub commission_accrued: Uint128,
    pub commission_paid: Uint128,
    pub commission_due: Uint128,
    /// True when commission_paid < commission_due; alone makes the validator ineligible.
    pub in_arrears: bool,
    /// Live eligibility: enrolled, bonded, not jailed/tombstoned, uptime and commission current.
    pub eligible: bool,
    /// New-delegation headroom in nhash under the concentration cap minus the safety
    /// offset (0 when ineligible).
    pub headroom: Uint128,
}
