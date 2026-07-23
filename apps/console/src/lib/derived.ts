// Derived metrics (spec §9.5). BigInt arithmetic; division via explicit scale-then-floor.
import { config } from "@/config";
import { toBig } from "@/lib/format";
import type {
  AprResponse,
  DeploymentSplit,
  EpochSnapshot,
  PendingSwapOut,
  VaultInfo,
} from "@/lib/types";

const DENOM = 10n ** BigInt(config.denomExponent);
const SHARE = 10n ** BigInt(config.shareExponent);
const MARGIN = BigInt(10000 + config.redemptionMarginBps); // 10050

/** §9.5.1 NAV = HASH per whole nvHASH = tvv * 10^(share_exp - denom_exp) / total_shares. */
export function navPerShare(tvv: bigint, totalShares: bigint): number {
  if (totalShares <= 0n) return 1; // neutral before any mint
  const scaleUp = 10n ** BigInt(config.shareExponent - config.denomExponent); // 1e6
  // scale to 1e4 for 4-decimal display precision
  const scaled = (tvv * scaleUp * 10000n) / totalShares;
  return Number(scaled) / 10000;
}

/** §9.5.2 APR display rule: window < 1 day annualizes to garbage -> render n/a. */
export function aprDisplayable(apr: AprResponse | null): boolean {
  return !!apr && apr.window_seconds >= 86400;
}

/**
 * Next-run eligibility timestamp: the first second of the calendar month AFTER
 * `last_run` (UTC). Mirrors the contract's `RunEpoch` gate — eligible once
 * block time is in a strictly later civil month than `last_run` (§14.12,
 * liquid-staking-spec §9) — and equals the `too soon { next }` instant the
 * contract reports. The cadence is no longer a config interval.
 */
export function nextRunAt(lastRunSecs: number): number {
  const d = new Date(lastRunSecs * 1000);
  // Date.UTC rolls month 12 (December, index 11 + 1) into the next January.
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
}

export interface InvariantCheck {
  matched: boolean;
  delta: bigint; // receipt_minted - (delegated + unbonding + undeployed remainder)
}
/** §9.5.4 receipt invariant. In-flight legs legitimately skew it -> warning, not error. */
export function receiptInvariant(
  receiptMinted: bigint,
  split: DeploymentSplit,
): InvariantCheck {
  const backing = toBig(split.delegated) + toBig(split.unbonding) + toBig(split.pending);
  return { matched: backing >= receiptMinted, delta: receiptMinted - backing };
}

/** §9.5.5 epoch identity: tvv_after == tvv_before + rewards_deposited - write_down. */
export function epochIdentity(s: EpochSnapshot): boolean {
  const expected = toBig(s.tvv_before) + toBig(s.rewards_deposited) - toBig(s.write_down);
  return expected === toBig(s.tvv_after);
}

export interface Reserve {
  need: bigint; // Σ estimate * 1.005
  liquid: bigint;
  funded: Set<number>; // ids fully allocated in queue order
}
/** §9.5.6 funded/unfunded allocation across the queue in order. Display mirror of plan_service. */
export function computeReserve(queue: PendingSwapOut[], liquidNhash: bigint): Reserve {
  let need = 0n;
  let remaining = liquidNhash;
  const funded = new Set<number>();
  for (const r of queue) {
    const req = (toBig(r.estimate_nhash) * MARGIN) / 10000n;
    need += req;
    if (remaining >= req) {
      remaining -= req;
      funded.add(r.id);
    }
  }
  return { need, liquid: liquidNhash, funded };
}

/** §9.5.7 uptime display fraction (0..1) vs threshold. */
export function uptimePct(bps: number | null): number | null {
  return bps === null ? null : bps / 100;
}

export { DENOM, SHARE };

/** Convenience: NAV from vault (preferred) else snapshot. Some vault builds do not expose
 *  total_vault_value (§14.2); in that case fall back to the contract snapshot's tvv_after. */
export function navFromSources(vault: VaultInfo | null, snap: EpochSnapshot | null): number {
  if (vault && toBig(vault.total_vault_value) > 0n && toBig(vault.total_shares) > 0n)
    return navPerShare(toBig(vault.total_vault_value), toBig(vault.total_shares));
  if (snap) return navPerShare(toBig(snap.tvv_after), toBig(snap.total_shares));
  return 1;
}

/** TVV in nhash: vault value if exposed, else the snapshot's tvv_after (§14.2 fallback). */
export function tvvFromSources(vault: VaultInfo | null, snap: EpochSnapshot | null): bigint {
  if (vault && toBig(vault.total_vault_value) > 0n) return toBig(vault.total_vault_value);
  if (snap) return toBig(snap.tvv_after);
  return 0n;
}
