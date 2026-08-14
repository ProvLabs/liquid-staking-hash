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
    /// Concentration-cap mirrors; None = Provenance defaults (5.5x, 5%, 33%)
    /// and a 5% safety offset below the per-validator max bond.
    pub max_concentration_multiple_bps: Option<u64>,
    pub min_bonded_cap_bps: Option<u64>,
    pub max_bonded_cap_bps: Option<u64>,
    pub concentration_safety_offset_bps: Option<u64>,
    /// Program commission rate in bps of rewards earned on program delegations.
    /// None = the 10% default (DEFAULT_COMMISSION_BPS).
    pub commission_bps: Option<u64>,
    /// Cooldown between jail report and purge (RC1 §9.8). None = 8h default.
    pub jail_unbond_delay_secs: Option<u64>,
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
    },
    /// Admin-gated: emergency stop / resume for the fund-moving permissionless
    /// cranks (RunEpoch including continuations, ServiceRedemptions). Does not
    /// touch the vault's own pause state.
    SetHalted { halted: bool },
    /// Admin-gated: abort a stuck epoch continuation by dropping the persisted
    /// delegation targets and returning to Idle. Safe: the withdrawn nhash stays
    /// in the contract balance and the next epoch's return settlement swaps the
    /// matching receipt back out and burns it (TVV preserved).
    ClearPendingDelegations {},
    /// Validator-operator: enroll a validator in the program (RC1 §11.2). The
    /// caller must be the valoper's operator account (same key payload); the
    /// validator must exist on chain. Starts with no captured uptime; eligibility
    /// is evaluated from live chain state at each epoch.
    RegisterParticipation { valoper: String },
    /// Operator or admin: withdraw a validator from the program. Existing program
    /// stake on it is unbonded at the next epoch and redeployed.
    UnregisterParticipation { valoper: String },
    /// Permissionless (RC1 §9.8 phase 1): flag that a validator the program has
    /// stake on is jailed. Verified against live chain state: if jailed, the
    /// first report starts the jail_unbond_delay cooldown (later reports while
    /// still jailed are no-ops); if NOT jailed, any existing report is cleared.
    /// Moves no funds.
    ReportJailedValidator { valoper: String },
    /// Permissionless (RC1 §9.8 phase 2, halt-gated): after the cooldown, move
    /// the program's stake off a STILL-jailed validator. With an eligible
    /// `claimant_valoper` (caller must be its enrolled operator): redelegate up
    /// to the claimant's concentration headroom, unbond the remainder. Without
    /// one (e.g. a depositor calling): unbond the full program delegation.
    /// Rejected (report cleared) if the validator unjailed in the interim.
    /// Idempotent once the stake has moved.
    PurgeJailedValidator {
        valoper: String,
        claimant_valoper: Option<String>,
    },
    /// Anyone (nhash attached): pay program commission on behalf of an enrolled
    /// validator (RC1 §10.1). Credits the validator's cumulative paid total;
    /// overpayment prepays future accrual; non-refundable. Funds are held by
    /// the contract and swept into vault principal (raising NAV) at the next
    /// epoch's deposit leg.
    PayCommission { valoper: String },
    /// Anyone (nhash attached): pay a TIP for an enrolled validator
    /// (RC1 §10.2). Credits the CURRENT epoch's tip (the primary priority key;
    /// resets at every epoch completion). Non-refundable; funds sweep into
    /// vault principal at the next epoch's deposit leg.
    PayTip { valoper: String },
    /// Permissionless: fold every enrolled validator's current signed-blocks
    /// ratio (slashing SigningInfo) into its per-epoch uptime accumulator
    /// (RC1 §10.4). Interval-gated by min_capture_interval_secs; early calls are
    /// accepted no-ops. Never required: plan time falls back to a direct read.
    CaptureUptimeSignal {},
    /// Permissionless: withdraw accrued staking rewards for every delegated
    /// validator that has any (phase A alone). Keeper cadence note: rewards
    /// claimed inside RunEpoch itself land in the contract balance AFTER that
    /// crank's state reads, so they are deposited into the vault at the NEXT
    /// epoch. Call ClaimRewards in a prior tx (any time before RunEpoch) so the
    /// current epoch's deposit includes them.
    ClaimRewards {},
    /// Permissionless (halt-gated): unbond to cover queued swap-outs and expedite
    /// funded ones (phases B + D2 alone). Expedites are gated on principal-marker
    /// liquidity only.
    ServiceRedemptions {},
    /// Permissionless (min-interval and halt guarded): the full epoch crank.
    /// Bypasses the interval guard only to drain a pending continuation.
    RunEpoch {},
}

/// Migration message. Empty: no state transformation is needed, so migration
/// only re-stamps the cw2 version record.
#[cw_serde]
pub struct MigrateMsg {}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ConfigResponse)]
    Config {},
    #[returns(EpochStatusResponse)]
    EpochStatus {},
    /// Enrolled validators with a live eligibility assessment (uptime, jailed,
    /// tombstoned, commission standing, concentration headroom) read from
    /// current chain state. Sorted by program priority, highest first (TIP
    /// desc, then uptime desc, then enrollment age) — the reverse of the
    /// redemption drain order (RC1 §10.2).
    #[returns(ValidatorsResponse)]
    Validators {},
    /// Open jail reports (RC1 §9.8): validators observed jailed and the time a
    /// purge becomes allowed. Keeper-facing.
    #[returns(JailReportsResponse)]
    JailReports {},
    /// The most recent epoch's value decomposition (RC1 §9.10). Only the last
    /// snapshot is retained; None before the first epoch crank.
    #[returns(EpochSnapshotResponse)]
    EpochSnapshot {},
    /// Realized APR over the last epoch window with the gross-to-net breakdown
    /// (rewards, +commission, +TIP, -AUM estimate, -slash write-down), per
    /// RC1 §9.10 / R2 transparency. None before the first epoch crank.
    #[returns(AprResponse)]
    Apr {},
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
    /// Effective uptime in bps (accumulator mean if any captures, else the live
    /// signing-info read). None when uptime cannot be determined (validator or
    /// signing info missing, non-ed25519 consensus key).
    pub uptime_bps: Option<u64>,
    pub jailed: bool,
    pub tombstoned: bool,
    /// TIP credited for the current epoch (primary priority key).
    pub tip_epoch: Uint128,
    /// Cumulative program commission accrued / paid, and the grace boundary the
    /// paid total must currently meet (RC1 §10.1).
    pub commission_accrued: Uint128,
    pub commission_paid: Uint128,
    pub commission_due: Uint128,
    /// True when commission_paid < commission_due: past the one-epoch grace,
    /// which alone makes the validator ineligible until brought current.
    pub in_arrears: bool,
    /// Live eligibility: enrolled, bonded, not jailed/tombstoned, uptime meets
    /// the configured threshold, commission current.
    pub eligible: bool,
    /// nhash of new delegation this validator could still legally receive under
    /// the concentration cap minus the safety offset (0 when ineligible).
    pub headroom: Uint128,
}
