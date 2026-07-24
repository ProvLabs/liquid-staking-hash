// M6.1 derived portfolio metrics: a pure BigInt fold over the indexed event
// history producing cost basis, realized gain, effective yield, and the
// accrual series (app-spec §14.11 average cost, §14.12 effective yield).
//
// Amount discipline (app-spec §5.8): every amount stays bigint, scale-then-
// floor, decimal strings only at the boundary; heights/bps cross into the JSON
// number domain through the loud safe-integer guards in derive.ts ([R7a]).
// Two average-cost pools (held, escrow) plus a running realized gain; escrow
// re-prices at payout NAV, so it stays yield-bearing until the payout event.
// The fold never throws on bad history: an impossible move flips the result
// to `inconsistent` and nulls the derived figures; it throws only on
// programmer errors (an unsafe int reaching the number domain).

import type {
  AccrualMarker,
  AccrualPoint,
  EffectiveYieldPoint,
  PortfolioHistoryState,
  PortfolioMetrics,
} from "@nvhash/api-types";
import { toSafeInt, toSafeSignedInt, type TransactionFacts } from "./derive.ts";

export const MARKER_CAP = 200;
/** Accrual series cap: the web zod bound would null the whole read past this,
 * so trim earlier history server-side and flag it (keep the most recent). */
export const MAX_ACCRUAL_POINTS = 2000;
const SECONDS_PER_YEAR = 31_536_000n;

/** Minimal epoch-step input (the endpoint task maps epoch_snapshots + the
 * snapshot's stored height into this). */
export interface EpochStepFact {
  readonly epochIndex: bigint;
  readonly endedAtSeconds: bigint;
  readonly tvvAfter: bigint;
  readonly totalShares: bigint;
  readonly netAprBps: number | null;
  readonly endHeight: bigint;
}

function secondsOf(d: Date): bigint {
  return BigInt(Math.floor(d.getTime() / 1000));
}

function isoFromSeconds(seconds: bigint): string {
  return new Date(toSafeInt(seconds, "epoch ended_at_seconds") * 1000).toISOString();
}

/** floor(shares * tvv / totalShares) in nhash; null when the epoch has no NAV. */
function valueAt(shares: bigint, epoch: EpochStepFact | null): bigint | null {
  if (epoch === null || epoch.totalShares <= 0n) return null;
  return (shares * epoch.tvvAfter) / epoch.totalShares;
}

export function derivePortfolioMetrics(
  address: string,
  txsAsc: readonly TransactionFacts[],
  epochsAsc: readonly EpochStepFact[],
  markerCap: number = MARKER_CAP,
): PortfolioMetrics {
  // --- pool fold (event order) + inconsistency detection --------------------
  let heldShares = 0n;
  let heldBasis = 0n;
  let escrowShares = 0n;
  let escrowBasis = 0n;
  let realized = 0n;
  let transferCount = 0;
  let inconsistent = false;

  for (const t of txsAsc) {
    if (t.kind === "swap_in") {
      if (t.shares < 0n || t.nhash < 0n) {
        inconsistent = true;
        break;
      }
      heldShares += t.shares;
      heldBasis += t.nhash;
    } else if (t.kind === "swap_out_request") {
      if (t.shares < 0n || heldShares <= 0n || t.shares > heldShares) {
        inconsistent = true;
        break;
      }
      const moved = (heldBasis * t.shares) / heldShares;
      heldShares -= t.shares;
      heldBasis -= moved;
      escrowShares += t.shares;
      escrowBasis += moved;
    } else if (t.kind === "redemption_payout") {
      if (t.shares < 0n || escrowShares <= 0n || t.shares > escrowShares) {
        inconsistent = true;
        break;
      }
      const removed = (escrowBasis * t.shares) / escrowShares;
      escrowShares -= t.shares;
      escrowBasis -= removed;
      realized += t.nhash - removed;
    } else if (t.kind === "redemption_refund") {
      if (t.shares < 0n || escrowShares <= 0n || t.shares > escrowShares) {
        inconsistent = true;
        break;
      }
      const returned = (escrowBasis * t.shares) / escrowShares;
      escrowShares -= t.shares;
      escrowBasis -= returned;
      heldShares += t.shares;
      heldBasis += returned;
    } else {
      transferCount += 1; // transfer_in / transfer_out carry no basis
    }
  }

  if (inconsistent) {
    return {
      address,
      history_state: "inconsistent",
      indexed_share_balance: heldShares.toString(),
      escrowed_share_balance: escrowShares.toString(),
      cost_basis_nhash: null,
      escrowed_basis_nhash: null,
      realized_gain_nhash: null,
      effective_apr_bps: null,
      yield_by_epoch: [],
      accrual: [],
      accrual_truncated: false,
      accrual_markers: [],
      markers_truncated: false,
    };
  }

  const historyState: PortfolioHistoryState = transferCount > 0 ? "has_transfers" : "complete";

  // --- markers (most recent markerCap events) -------------------------------
  const markers: AccrualMarker[] = txsAsc.map((t) => ({
    time: t.blockTime.toISOString(),
    txhash: t.txhash,
    kind: t.kind,
    shares: t.shares.toString(),
    nhash: t.nhash.toString(),
  }));
  const markersTruncated = markers.length > markerCap;
  const accrualMarkers = markersTruncated ? markers.slice(markers.length - markerCap) : markers;

  // --- timeline walk: accrual, yield, effective APR -------------------------
  const firstDeposit = txsAsc.find((t) => t.kind === "swap_in") ?? null;
  const yieldByEpoch: EffectiveYieldPoint[] = [];
  const accrual: AccrualPoint[] = [];

  if (firstDeposit === null || epochsAsc.length === 0) {
    return {
      address,
      history_state: historyState,
      indexed_share_balance: heldShares.toString(),
      escrowed_share_balance: escrowShares.toString(),
      cost_basis_nhash: heldBasis.toString(),
      escrowed_basis_nhash: escrowBasis.toString(),
      realized_gain_nhash: realized.toString(),
      effective_apr_bps: null,
      yield_by_epoch: [],
      accrual: [],
      accrual_truncated: false,
      accrual_markers: accrualMarkers,
      markers_truncated: markersTruncated,
    };
  }

  const firstDepositSeconds = secondsOf(firstDeposit.blockTime);
  const lastStepSeconds = epochsAsc[epochsAsc.length - 1]!.endedAtSeconds;

  // Running position and NAV replayed in timeline order (events before epochs
  // at an equal second). Pools only move on events; epochs only re-price.
  let hp = 0n;
  let hb = 0n;
  let ep = 0n;
  let eb = 0n;
  let currentNav: EpochStepFact | null = null;
  let depositSeen = false;
  let gainTotal = 0n;

  // Effective-APR TWAB denominator: sum(value_i * dt_i) over sub-intervals
  // bounded by every event and epoch step in [firstDeposit, lastStep].
  let denom = 0n;
  let integrating = false;
  let prevBreak = 0n;
  let segShares = 0n;
  let segNav: EpochStepFact | null = null;

  const closeInterval = (until: bigint): void => {
    if (!integrating) return;
    const end = until < lastStepSeconds ? until : lastStepSeconds;
    if (end > prevBreak) {
      const v = valueAt(segShares, segNav);
      if (v !== null) denom += v * (end - prevBreak);
      prevBreak = end;
    }
  };

  let i = 0;
  let j = 0;
  while (i < txsAsc.length || j < epochsAsc.length) {
    const t = i < txsAsc.length ? txsAsc[i]! : null;
    const e = j < epochsAsc.length ? epochsAsc[j]! : null;
    // Event before epoch when times tie (a same-second deposit counts as held
    // going into the settlement).
    const takeEvent = e === null || (t !== null && secondsOf(t.blockTime) <= e.endedAtSeconds);

    if (takeEvent && t !== null) {
      const at = secondsOf(t.blockTime);
      closeInterval(at);
      // apply pool effect (history is consistent here)
      if (t.kind === "swap_in") {
        hp += t.shares;
        hb += t.nhash;
        depositSeen = true;
      } else if (t.kind === "swap_out_request") {
        const moved = (hb * t.shares) / hp;
        hp -= t.shares;
        hb -= moved;
        ep += t.shares;
        eb += moved;
      } else if (t.kind === "redemption_payout") {
        const removed = (eb * t.shares) / ep;
        ep -= t.shares;
        eb -= removed;
      } else if (t.kind === "redemption_refund") {
        const returned = (eb * t.shares) / ep;
        ep -= t.shares;
        eb -= returned;
        hp += t.shares;
        hb += returned;
      }
      if (depositSeen && currentNav !== null && at >= firstDepositSeconds) {
        accrual.push({
          time: t.blockTime.toISOString(),
          height: toSafeInt(t.height, "event height"),
          value_nhash: valueAt(hp + ep, currentNav)!.toString(),
        });
      }
      if (!integrating && t.kind === "swap_in") {
        integrating = true;
        prevBreak = at;
      }
      segShares = hp + ep;
      segNav = currentNav;
      i += 1;
      continue;
    }

    // epoch step
    if (e !== null) {
      closeInterval(e.endedAtSeconds);
      const p = j > 0 ? epochsAsc[j - 1]! : null;
      const shares = hp + ep;
      let personal: number | null = null;
      const pBearing = p !== null && p.totalShares > 0n;
      const eBearing = e.totalShares > 0n;
      if (pBearing && eBearing && shares > 0n && p!.endedAtSeconds >= firstDepositSeconds) {
        const dur = e.endedAtSeconds - p!.endedAtSeconds;
        const vp = valueAt(shares, p)!;
        const ve = valueAt(shares, e)!;
        if (dur > 0n && vp > 0n) {
          personal = toSafeSignedInt(
            ((ve - vp) * 10_000n * SECONDS_PER_YEAR) / (vp * dur),
            "personal_apr_bps",
          );
        }
      }
      if (e.endedAtSeconds >= firstDepositSeconds) {
        yieldByEpoch.push({
          epoch_index: toSafeInt(e.epochIndex, "epoch_index"),
          ended_at: isoFromSeconds(e.endedAtSeconds),
          personal_apr_bps: personal,
          net_apr_bps: e.netAprBps,
        });
      }
      // overall gain: repricing on the position for every step settled after
      // the first deposit (NAV_p was in force when the deposit entered).
      if (pBearing && eBearing && e.endedAtSeconds > firstDepositSeconds) {
        gainTotal += valueAt(shares, e)! - valueAt(shares, p)!;
      }
      if (eBearing) currentNav = e;
      if (currentNav !== null && e.endedAtSeconds >= firstDepositSeconds) {
        accrual.push({
          time: isoFromSeconds(e.endedAtSeconds),
          height: toSafeInt(e.endHeight, "epoch height"),
          value_nhash: valueAt(hp + ep, currentNav)!.toString(),
        });
      }
      segNav = currentNav;
      segShares = hp + ep;
      j += 1;
    }
  }

  const stepAfterDeposit = lastStepSeconds > firstDepositSeconds;
  const effectiveAprBps =
    stepAfterDeposit && denom > 0n
      ? toSafeSignedInt((gainTotal * 10_000n * SECONDS_PER_YEAR) / denom, "effective_apr_bps")
      : null;

  const accrualTruncated = accrual.length > MAX_ACCRUAL_POINTS;
  const accrualPoints = accrualTruncated
    ? accrual.slice(accrual.length - MAX_ACCRUAL_POINTS)
    : accrual;

  return {
    address,
    history_state: historyState,
    indexed_share_balance: heldShares.toString(),
    escrowed_share_balance: escrowShares.toString(),
    cost_basis_nhash: heldBasis.toString(),
    escrowed_basis_nhash: escrowBasis.toString(),
    realized_gain_nhash: realized.toString(),
    effective_apr_bps: effectiveAprBps,
    yield_by_epoch: yieldByEpoch,
    accrual: accrualPoints,
    accrual_truncated: accrualTruncated,
    accrual_markers: accrualMarkers,
    markers_truncated: markersTruncated,
  };
}
