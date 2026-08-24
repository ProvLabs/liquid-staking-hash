use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Int128, Timestamp, Uint128};
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Config {
    /// x/group (or single) address authorized for admin actions.
    pub admin: Addr,
    /// The vault this contract is the asset manager for.
    pub vault_address: Addr,
    /// The staked asset AND the vault's underlying: nhash (Design C).
    pub underlying_denom: String,
    /// Restricted marker denom for deployed principal; a vault held asset NAV'd 1:1 to nhash.
    pub receipt_denom: String,
    /// Max delegations per crank (0 = unlimited); the remainder drains via PENDING_DELEGATIONS.
    pub max_delegations_per_run: u32,
    /// Admin-synced mirror of the vault's AUM fee rate in bps (not queryable in provwasm-std 2.8.0).
    pub aum_fee_bps: u64,
    /// Uptime eligibility threshold in bps of signed blocks (0 disables gating).
    pub performance_threshold_bps: u64,
    /// Min seconds between accepted CaptureUptimeSignal calls (0 = all); bounds sampling skew.
    pub min_capture_interval_secs: u64,
    /// Chain staking-cap mirrors ([VERIFY] live values):
    /// maxValPct = clamp(multiple / active_count, min_cap, max_cap), all in bps.
    pub max_concentration_multiple_bps: u64,
    pub min_bonded_cap_bps: u64,
    pub max_bonded_cap_bps: u64,
    /// Safety margin below the protocol concentration cap, in bps of the per-validator max bond.
    pub concentration_safety_offset_bps: u64,
    /// Program commission in bps of staking rewards; 0 disables accrual.
    #[serde(default)]
    pub commission_bps: u64,
    /// Cooldown between ReportJailedValidator and PurgeJailedValidator (two-observation guard).
    #[serde(default)]
    pub jail_unbond_delay_secs: u64,
    /// Margin over the pending-redemption need in bps, bounded 0..=1000.
    #[serde(default = "default_redemption_margin_bps")]
    pub redemption_margin_bps: u64,
}

/// Serde default for pre-existing state; a bare zero default would silently remove the margin.
pub fn default_redemption_margin_bps() -> u64 {
    50
}

impl Config {
    /// Bound every admin-suppliable value into its valid range (SECURITY.md);
    /// enforced at instantiate and after every UpdateConfig merge.
    pub fn validate(&self) -> Result<(), crate::ContractError> {
        let invalid = |reason: &str| crate::ContractError::InvalidConfig {
            reason: reason.to_string(),
        };
        validate_denom(&self.underlying_denom, "underlying_denom")?;
        validate_denom(&self.receipt_denom, "receipt_denom")?;
        if self.underlying_denom == self.receipt_denom {
            return Err(invalid("underlying_denom and receipt_denom must differ"));
        }
        if self.aum_fee_bps > 10_000 {
            return Err(invalid("aum_fee_bps must be <= 10000"));
        }
        if self.performance_threshold_bps > 10_000 {
            return Err(invalid(
                "performance_threshold_bps must be <= 10000 (0 disables gating)",
            ));
        }
        if self.commission_bps > 10_000 {
            return Err(invalid("commission_bps must be <= 10000"));
        }
        if self.max_concentration_multiple_bps == 0 {
            return Err(invalid(
                "max_concentration_multiple_bps must be > 0 (10000 = 1x)",
            ));
        }
        if self.max_bonded_cap_bps == 0 || self.max_bonded_cap_bps > 10_000 {
            return Err(invalid("max_bonded_cap_bps must be in 1..=10000"));
        }
        if self.min_bonded_cap_bps > self.max_bonded_cap_bps {
            return Err(invalid("min_bonded_cap_bps must be <= max_bonded_cap_bps"));
        }
        // 10000 bps would zero every deploy target; disabling deploys is SetHalted's job.
        if self.concentration_safety_offset_bps >= 10_000 {
            return Err(invalid("concentration_safety_offset_bps must be < 10000"));
        }
        // Above 1000 the margin becomes a liquidity brake rather than a drift cover.
        if self.redemption_margin_bps > 1_000 {
            return Err(invalid("redemption_margin_bps must be <= 1000"));
        }
        Ok(())
    }
}

/// Cosmos SDK denom shape: 3..=128 chars, leading alphabetic,
/// then alphanumerics and '/', ':', '.', '_', '-'.
fn validate_denom(denom: &str, field: &str) -> Result<(), crate::ContractError> {
    let mut chars = denom.chars();
    let head_ok = chars.next().is_some_and(|c| c.is_ascii_alphabetic());
    let tail_ok =
        chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | ':' | '.' | '_' | '-'));
    if denom.len() < 3 || denom.len() > 128 || !head_ok || !tail_ok {
        return Err(crate::ContractError::InvalidConfig {
            reason: format!("{field} is not a valid denom: {denom:?}"),
        });
    }
    Ok(())
}

pub const CONFIG: Item<Config> = Item::new("config");

/// An enrolled validator; eligibility is evaluated against live chain
/// state at plan time. Unregistering deletes the record including any unpaid
/// commission (accepted gap; exposure is bounded at ~2 epochs of commission).
#[cw_serde]
pub struct ValidatorRecord {
    /// Enrolling operator account (bech32-verified against the valoper payload).
    pub operator: Addr,
    pub enrolled_at: Timestamp,
    /// Per-epoch uptime accumulator: sum of captured ratios in bps; reset each epoch.
    pub uptime_sum_bps: u64,
    pub uptime_count: u32,
    /// Cumulative commission accrued (nhash): rewards x commission_bps at each claim.
    #[serde(default)]
    pub commission_accrued: Uint128,
    /// Cumulative commission paid in via PayCommission (any payer).
    #[serde(default)]
    pub commission_paid: Uint128,
    /// Grace boundary: accrual through the epoch before last; in arrears while paid < due.
    #[serde(default)]
    pub commission_due: Uint128,
    /// Accrual snapshot at the last epoch completion; becomes `commission_due` at the next.
    #[serde(default)]
    pub commission_billed: Uint128,
    /// TIP paid for the CURRENT epoch: priority key, non-refundable, reset each epoch.
    #[serde(default)]
    pub tip_epoch: Uint128,
}

/// Enrolled validators keyed by valoper; lexicographic key order is the
/// deterministic planning order.
pub const VALIDATORS: Map<&str, ValidatorRecord> = Map::new("validators");

/// Timestamp of the last accepted CaptureUptimeSignal (interval gate).
pub const LAST_CAPTURE: Item<Timestamp> = Item::new("last_capture");

/// A recorded observation of a jailed validator.
#[cw_serde]
pub struct JailObservation {
    /// First jailed observation of this episode; starts the jail_unbond_delay cooldown.
    pub reported_at: Timestamp,
    /// Jail-episode fingerprint (`unbonding_height` at observation); a purge-time
    /// mismatch proves a stale report, blocking cooldown bypass on a re-jail.
    pub unbonding_height: i64,
}

/// Jail reports keyed by valoper; cleared on observed unjail and after purge, so a
/// re-jail needs a fresh two-observation cycle. Only kept for validators with live
/// program stake; independent of enrollment.
pub const JAIL_REPORTS: Map<&str, JailObservation> = Map::new("jail_reports");

/// Admin emergency stop for the fund-moving permissionless cranks; registration,
/// capture and ClaimRewards stay live, ClearPendingDelegations remains the hatch.
pub const HALTED: Item<bool> = Item::new("halted");

#[cw_serde]
pub enum EpochPhase {
    Idle,
    /// Withdrawn principal not yet fully delegated; continuation cranks are draining it.
    Releasing,
}

#[cw_serde]
pub struct EpochState {
    pub phase: EpochPhase,
    pub last_run: Timestamp,
}

impl Default for EpochState {
    fn default() -> Self {
        EpochState {
            phase: EpochPhase::Idle,
            last_run: Timestamp::from_seconds(0),
        }
    }
}

pub const EPOCH: Item<EpochState> = Item::new("epoch");

/// nhash represented by minted receipt tokens (== principal deployed out of the vault).
pub const RECEIPT_MINTED: Item<Uint128> = Item::new("receipt_minted");

/// Withdrawn-but-not-yet-delegated targets carried across chunked cranks; empty = no continuation.
pub const PENDING_DELEGATIONS: Item<Vec<(String, Uint128)>> = Item::new("pending_delegations");

/// Rebalance moves (src, dst, amount) carried across continuation cranks;
/// drained before PENDING_DELEGATIONS, dropped by ClearPendingDelegations.
pub const PENDING_REDELEGATIONS: Item<Vec<(String, String, Uint128)>> =
    Item::new("pending_redelegations");

/// Value-flow accumulators for the current epoch window; folded into
/// the EpochSnapshot at the next main crank, then reset.
#[cw_serde]
#[derive(Default)]
pub struct EpochAccum {
    pub rewards_claimed: Uint128,
    pub commission_received: Uint128,
    pub tips_received: Uint128,
    pub unbonded_for_redemptions: Uint128,
    pub redemptions_expedited: u32,
    pub validators_purged: u32,
}

pub const EPOCH_ACCUM: Item<EpochAccum> = Item::new("epoch_accum");

/// Mutate the current epoch's accumulators (absent = default zeroes).
pub fn update_accum<F>(storage: &mut dyn cosmwasm_std::Storage, f: F) -> cosmwasm_std::StdResult<()>
where
    F: FnOnce(&mut EpochAccum),
{
    let mut acc = EPOCH_ACCUM.may_load(storage)?.unwrap_or_default();
    f(&mut acc);
    EPOCH_ACCUM.save(storage, &acc)
}

/// Monotonic epoch counter, incremented at each main crank.
pub const EPOCH_INDEX: Item<u64> = Item::new("epoch_index");

/// The single most recent epoch value decomposition: overwritten every
/// epoch, never a history. `tvv_after = tvv_before + rewards_deposited - write_down`
/// by construction; its `tvv_after` seeds the next epoch's `net_deposits`.
#[cw_serde]
pub struct EpochSnapshot {
    pub epoch_index: u64,
    /// Previous snapshot's end (0 for the first epoch: derived rates guard on it).
    pub started_at_seconds: u64,
    pub ended_at_seconds: u64,
    pub end_height: u64,
    pub tvv_before: Uint128,
    /// Expected post-crank TVV: before + rewards_deposited - write_down.
    pub tvv_after: Uint128,
    pub total_shares: Uint128,
    /// Window inflows (accumulated since the previous snapshot, incl. this crank).
    pub rewards_claimed: Uint128,
    pub commission_received: Uint128,
    pub tips_received: Uint128,
    /// This crank's actual NAV step (liquid swept into principal).
    pub rewards_deposited: Uint128,
    /// This crank's value-neutral return settlement and slash recognition.
    pub settled: Uint128,
    pub write_down: Uint128,
    /// This crank's fresh deployment (receipt minted and delegated).
    pub deployed: Uint128,
    /// Stake redirected by the uniform-slot rebalance; value-neutral.
    #[serde(default)]
    pub rebalanced: Uint128,
    pub unbonded_for_redemptions: Uint128,
    pub redemptions_expedited: u32,
    pub validators_purged: u32,
    pub eligible_count: u32,
    /// AUM drag over the window, estimated from the admin's aum_fee_bps mirror.
    pub aum_fee_estimate: Uint128,
    /// User swap flow since the previous epoch: tvv_before - previous tvv_after (negative = net redemptions).
    pub net_deposits: Int128,
}

pub const LAST_SNAPSHOT: Item<EpochSnapshot> = Item::new("last_snapshot");
