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
    /// Restricted marker denom representing deployed (staked) principal. A held
    /// asset in the vault (not an accepted denom), valued via the vault's internal
    /// NAV table at 1:1 to nhash, moved via exchange settlements.
    pub receipt_denom: String,
    /// Max validators to delegate to per crank (0 = unlimited). Bounds per-tx gas;
    /// the remainder is persisted to PENDING_DELEGATIONS and drained by
    /// continuation cranks.
    pub max_delegations_per_run: u32,
    /// Mirror of the vault's AUM fee rate in bps. provwasm-std 2.8.0 cannot query
    /// the vault's fee fields, so the admin keeps this in sync; the deploy leg
    /// reserves the fee that will accrue on TVV before roughly the next two epochs.
    pub aum_fee_bps: u64,
    /// Uptime eligibility threshold in bps of signed blocks over the slashing
    /// window (e.g. 9800 = 98%). 0 disables uptime gating (every enrolled,
    /// unjailed validator is eligible). Should be set >= the chain's
    /// min_signed_per_window (0.95) to be meaningful.
    pub performance_threshold_bps: u64,
    /// Minimum seconds between accepted CaptureUptimeSignal calls. Bounds capture
    /// cadence so no party can over-sample a favorable instant to skew the
    /// per-epoch uptime average. 0 = every call accepted.
    pub min_capture_interval_secs: u64,
    /// Provenance concentration-cap parameters (mirrors of the chain's staking
    /// restriction options; [VERIFY] live values on the deployed chain).
    /// maxValPct = clamp(multiple / active_count, min_cap, max_cap), all in bps
    /// of 1.0 (55_000 = 5.5x multiple, 500 = 5%, 3300 = 33%).
    pub max_concentration_multiple_bps: u64,
    pub min_bonded_cap_bps: u64,
    pub max_bonded_cap_bps: u64,
    /// Safety margin below the protocol concentration cap, in bps of the
    /// per-validator max bond. Keeps a batch of delegations (or other delegators
    /// acting in nearby blocks) from tripping the protocol threshold mid-epoch.
    pub concentration_safety_offset_bps: u64,
    /// Program commission rate in bps of the staking rewards earned on program
    /// delegations (RC1 §10.1). Accrued per validator at every reward claim;
    /// paid out-of-pocket by operators via PayCommission. 0 disables accrual.
    #[serde(default)]
    pub commission_bps: u64,
    /// Cooldown between ReportJailedValidator and PurgeJailedValidator
    /// (RC1 §9.8 two-observation guard, default 8h). The validator must be
    /// jailed at BOTH observations, so a brief downtime blip never strands
    /// stake for the unbonding period.
    #[serde(default)]
    pub jail_unbond_delay_secs: u64,
}

impl Config {
    /// Bound every admin-suppliable value into its valid range (SECURITY.md:
    /// inputs are validated at the message boundary, not where they are used).
    /// Enforced at instantiate and after every UpdateConfig merge, so no
    /// out-of-range value can ever be stored.
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
            return Err(invalid(
                "min_bonded_cap_bps must be <= max_bonded_cap_bps",
            ));
        }
        // An offset of 10000 bps (100% of max bond) would silently zero every
        // deploy target; disabling deploys is SetHalted's job, not a config
        // value that looks like a margin.
        if self.concentration_safety_offset_bps >= 10_000 {
            return Err(invalid(
                "concentration_safety_offset_bps must be < 10000",
            ));
        }
        Ok(())
    }
}

/// Cosmos SDK denom shape: 3..=128 chars, leading alphabetic, then
/// alphanumerics and '/', ':', '.', '_', '-'. Rejecting malformed denoms here
/// keeps every downstream bank/marker/exchange message well-formed.
fn validate_denom(denom: &str, field: &str) -> Result<(), crate::ContractError> {
    let mut chars = denom.chars();
    let head_ok = chars.next().is_some_and(|c| c.is_ascii_alphabetic());
    let tail_ok = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | ':' | '.' | '_' | '-'));
    if denom.len() < 3 || denom.len() > 128 || !head_ok || !tail_ok {
        return Err(crate::ContractError::InvalidConfig {
            reason: format!("{field} is not a valid denom: {denom:?}"),
        });
    }
    Ok(())
}

pub const CONFIG: Item<Config> = Item::new("config");

/// An enrolled validator (RC1 §11.2 RegisterParticipation). Enrollment is
/// operator-initiated; eligibility (uptime threshold, not jailed/tombstoned,
/// commission current) is evaluated against live chain state at plan time.
///
/// Unregistering deletes the record, INCLUDING any unpaid commission (accepted
/// gap, decided 2026-07-09): the deterrent is losing the enrollment and having
/// program stake drained; exposure is bounded at ~2 epochs of commission.
#[cw_serde]
pub struct ValidatorRecord {
    /// The operator account that enrolled the validator (bech32-verified against
    /// the valoper payload). May unregister; receives no funds in this phase.
    pub operator: Addr,
    pub enrolled_at: Timestamp,
    /// Per-epoch uptime accumulator (RC1 §10.4): sum of captured signed-blocks
    /// ratios in bps and the capture count. Reset at epoch completion. Effective
    /// uptime = sum/count when count > 0, else a direct plan-time read.
    pub uptime_sum_bps: u64,
    pub uptime_count: u32,
    /// Cumulative program commission accrued (nhash), charged at every reward
    /// claim as rewards x commission_bps (RC1 §10.1).
    #[serde(default)]
    pub commission_accrued: Uint128,
    /// Cumulative commission paid in via PayCommission (any payer).
    #[serde(default)]
    pub commission_paid: Uint128,
    /// The grace boundary: cumulative accrual through the epoch BEFORE the last
    /// completed one. In arrears (ineligible) while paid < due; paying mid-epoch
    /// restores eligibility at the next plan (RC1 §10.1 one-epoch grace).
    #[serde(default)]
    pub commission_due: Uint128,
    /// Cumulative accrual snapshot taken at the last epoch completion; becomes
    /// `commission_due` at the next one.
    #[serde(default)]
    pub commission_billed: Uint128,
    /// TIP paid in for the CURRENT epoch (RC1 §10.2). Primary priority key,
    /// non-cumulative: reset to zero at every epoch completion. Non-refundable.
    #[serde(default)]
    pub tip_epoch: Uint128,
}

/// Enrolled validators keyed by valoper. Key order (lexicographic) is the
/// deterministic iteration order used for claim/deploy planning.
pub const VALIDATORS: Map<&str, ValidatorRecord> = Map::new("validators");

/// Timestamp of the last accepted CaptureUptimeSignal (interval gate).
pub const LAST_CAPTURE: Item<Timestamp> = Item::new("last_capture");

/// A recorded observation of a jailed validator (RC1 §9.8 phase 1).
#[cw_serde]
pub struct JailObservation {
    /// When the validator was first observed jailed in THIS jail episode.
    /// Starts the jail_unbond_delay cooldown.
    pub reported_at: Timestamp,
    /// Jail-episode fingerprint: the validator's `unbonding_height` at the
    /// observation. A validator must re-bond before it can be jailed again,
    /// and jailing stamps a fresh unbonding_height, so a mismatch at purge
    /// time proves the report belongs to an EARLIER episode — without this,
    /// a stale report would let anyone purge a freshly re-jailed validator
    /// immediately, bypassing the sustained-downtime cooldown.
    pub unbonding_height: i64,
}

/// Jail reports keyed by valoper. Cleared whenever the validator is observed
/// unjailed, and after a full purge (so a later re-jail always needs a fresh
/// two-observation cycle). Recorded only for validators the program has live
/// stake on (there is nothing to purge from the others). Independent of
/// enrollment.
pub const JAIL_REPORTS: Map<&str, JailObservation> = Map::new("jail_reports");

/// Admin emergency stop for the fund-moving permissionless cranks (RunEpoch and
/// ServiceRedemptions, including continuation cranks). Registration, capture and
/// ClaimRewards stay live; ClearPendingDelegations remains the recovery hatch.
pub const HALTED: Item<bool> = Item::new("halted");

#[cw_serde]
pub enum EpochPhase {
    Idle,
    /// A deploy leg withdrew principal but not all of it is delegated yet;
    /// continuation cranks are draining PENDING_DELEGATIONS.
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

/// nhash currently represented by minted receipt tokens (== principal deployed out
/// of the vault). Incremented when the deploy settlement mints receipt in,
/// decremented when the return settlement / write-down burns it.
pub const RECEIPT_MINTED: Item<Uint128> = Item::new("receipt_minted");

/// Delegation targets withdrawn-but-not-yet-delegated, carried across cranks when
/// the deploy loop is chunked. Empty = no epoch continuation pending.
pub const PENDING_DELEGATIONS: Item<Vec<(String, Uint128)>> = Item::new("pending_delegations");

/// Uniform-slot rebalance moves (src, dst, amount) not yet executed, carried
/// across continuation cranks under the same max_delegations_per_run budget
/// (RC1 §9.3 single-EPOCH convergence over gas-bounded cranks). Drained before
/// PENDING_DELEGATIONS; dropped (stake stays put, retried next epoch) by
/// ClearPendingDelegations.
pub const PENDING_REDELEGATIONS: Item<Vec<(String, String, Uint128)>> =
    Item::new("pending_redelegations");

/// Value-flow accumulators for the CURRENT epoch window (RC1 §9.10), bumped at
/// every relevant handler and folded into the EpochSnapshot at the next main
/// crank, then reset. Exact by construction: rewards are recorded at every
/// claim point (explicit claims plus undelegation auto-withdraws), and
/// commission/TIP at fund intake.
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

/// The single most recent epoch value decomposition (RC1 §9.10): overwritten
/// every epoch, never a growing history. Its `tvv_after` seeds the next
/// epoch's `net_deposits` derivation. Adapted to the single-tx engine:
/// `rewards_deposited` and `write_down` are the crank's exact values, so
/// `tvv_after = tvv_before + rewards_deposited - write_down` by construction
/// (settlement and deploy legs are value-neutral; AUM accrual is the only
/// drift). Commission/TIP funds sit in the contract (outside TVV) between
/// epochs, so the between-epoch TVV delta is purely user swap flow minus AUM:
/// `net_deposits = tvv_before(this) - tvv_after(previous)`.
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
    /// Stake redirected between validators by the uniform-slot rebalance
    /// (RC1 §9.3): value-neutral, kept productive throughout.
    #[serde(default)]
    pub rebalanced: Uint128,
    pub unbonded_for_redemptions: Uint128,
    pub redemptions_expedited: u32,
    pub validators_purged: u32,
    pub eligible_count: u32,
    /// The AUM drag over the window, estimated from the admin's aum_fee_bps
    /// mirror (provwasm-std 2.8.0 exposes no vault fee fields).
    pub aum_fee_estimate: Uint128,
    /// User swap flow since the previous epoch: tvv_before - previous
    /// tvv_after. Negative = net redemptions. Slightly understated by the
    /// window's AUM accrual.
    pub net_deposits: Int128,
}

pub const LAST_SNAPSHOT: Item<EpochSnapshot> = Item::new("last_snapshot");
