// The §8.8 admin-analytics derivations — PURE folds over reader facts, a
// sibling of portfolio-metrics.ts rather than more of derive.ts (which is row
// mapping; this is aggregation with a privacy gate in it).
//
// TWO RULES GOVERN EVERY FUNCTION HERE.
//
// 1. NO ADDRESS REACHES THIS MODULE. The reader facts these fold over carry
//    heights, positions and counts — never an address — so no admin payload can
//    leak one even by mistake. That is a property of the FACT SHAPES, not of
//    the care taken here (plan invariant 12).
//
// 2. THE MINIMUM-GROUP-SIZE GATE IS APPLIED HERE, SERVER-SIDE, and its
//    threshold rides out in the payload as data. "Derivable from public data"
//    is not the same as "singles nobody out": a cohort of one, or a top-1
//    concentration share among three holders, names a holder by inference
//    without any address being returned. Below the gate the figure is `null`
//    with a flag saying WHY — never a number, and never a zero.

import {
  CONCENTRATION_BANDS,
  MIN_COHORT_SIZE,
  type AdminAdoptionPoint,
  type AdminConcentration,
  type AdminHealthPoint,
  type AdminRetentionCurve,
  type AdminRetentionPoint,
  type AdminUpkeepBucket,
  type AdminUpkeepDistribution,
  type AdminValidatorPoint,
} from "@nvhash/api-types";
import { toSafeInt } from "./derive.ts";

/** Per-epoch settlement facts the §8.8 panels fold over. */
export interface AdminEpochFacts {
  epochIndex: bigint;
  endedAtSeconds: bigint;
  endHeight: bigint;
  tvvAfter: bigint;
  netAprBps: number;
  netDeposits: bigint;
  validatorsPurged: number;
}

/**
 * One depositor's lifecycle, DELIBERATELY WITHOUT AN ADDRESS.
 *
 * Cohort membership and retention need only "when did this position start" and
 * "when did it end" — the identity is irrelevant to the arithmetic. Leaving the
 * address out of the fact shape means the retention panel structurally cannot
 * return one, rather than relying on every future edit to remember not to.
 */
export interface HolderLifecycleFacts {
  /** Height of the address's first `swap_in`. */
  firstDepositHeight: bigint;
  /** Height at which the held position first returned to zero, or null if it
   * never has (still holding). */
  exitHeight: bigint | null;
}

/** Per-epoch validator-set aggregates. */
export interface ValidatorEpochAggregateFacts {
  epochIndex: bigint;
  sampled: number;
  eligible: number;
  inArrears: number;
  tipPaying: number;
}

/** The retention horizons §8.8 charts, in epochs (plan §7.1 Q1). */
export const RETENTION_HORIZONS = [1, 3, 6, 12] as const;

// ── Program health ─────────────────────────────────────────────────────────

/** Map settlement facts to the health trend, ascending by epoch. */
export function toHealthPoints(epochs: readonly AdminEpochFacts[]): AdminHealthPoint[] {
  return epochs.map((e) => ({
    epoch_index: toSafeInt(e.epochIndex, "epochIndex"),
    ended_at: new Date(Number(e.endedAtSeconds) * 1000).toISOString(),
    tvv: e.tvvAfter.toString(),
    // `epoch_snapshots.netAprBps` is non-null by schema — a settled epoch
    // always has one, and it may legitimately be negative (a slash epoch). The
    // wire type is nullable for consumers that have no settled epoch at all.
    net_apr_bps: e.netAprBps,
    // SIGNED: a net-outflow epoch is a real state, not a floor-at-zero.
    net_deposits: e.netDeposits.toString(),
  }));
}

// ── Holder cohorts ─────────────────────────────────────────────────────────

/**
 * The epoch a height falls in: the first epoch whose `endHeight` is at or above
 * it. Returns null for a height past the last settled epoch — that deposit has
 * no cohort yet, which is honest, rather than being folded into the newest one.
 *
 * `epochsAsc` must be ascending by epoch index.
 */
export function epochAtHeight(
  epochsAsc: readonly AdminEpochFacts[],
  height: bigint,
): AdminEpochFacts | null {
  for (const epoch of epochsAsc) {
    if (height <= epoch.endHeight) return epoch;
  }
  return null;
}

/** New depositors per epoch — addresses whose FIRST `swap_in` fell in it. */
export function toAdoption(
  epochsAsc: readonly AdminEpochFacts[],
  lifecycles: readonly HolderLifecycleFacts[],
): AdminAdoptionPoint[] {
  const byEpoch = new Map<string, number>();
  for (const holder of lifecycles) {
    const epoch = epochAtHeight(epochsAsc, holder.firstDepositHeight);
    if (epoch === null) continue;
    const key = epoch.epochIndex.toString();
    byEpoch.set(key, (byEpoch.get(key) ?? 0) + 1);
  }
  return epochsAsc.map((e) => ({
    epoch_index: toSafeInt(e.epochIndex, "epochIndex"),
    ended_at: new Date(Number(e.endedAtSeconds) * 1000).toISOString(),
    // 0 is a FACT here, not a missing value: the epoch settled and nobody made
    // a first deposit in it. The null-not-zero rule is about unknowns.
    new_depositors: byEpoch.get(e.epochIndex.toString()) ?? 0,
  }));
}

/**
 * Retention curves by first-deposit epoch.
 *
 * "Retained at horizon k" means the position was still POSITIVE at the close of
 * epoch `cohort + k` — not "still transacting". The distinction matters: a
 * holder who deposits once and never touches it again is the ideal holder, and
 * an activity-based metric would count them as churned, which would be a lie
 * about the program dressed as a statistic.
 *
 * Two different reasons produce a null point, and they are distinguished:
 *   - the horizon has not elapsed yet → `retained_bps: null`, `below_minimum:
 *     false` (we will know later);
 *   - the cohort is below `MIN_COHORT_SIZE` → EVERY point null and
 *     `below_minimum: true` (we know, and are withholding it as a privacy gate).
 */
export function toRetentionCurves(
  epochsAsc: readonly AdminEpochFacts[],
  lifecycles: readonly HolderLifecycleFacts[],
  minCohortSize: number = MIN_COHORT_SIZE,
): AdminRetentionCurve[] {
  const indexOf = new Map<string, number>();
  for (const [i, epoch] of epochsAsc.entries()) indexOf.set(epoch.epochIndex.toString(), i);

  /** cohort epoch position → the cohort's lifecycles. */
  const cohorts = new Map<number, HolderLifecycleFacts[]>();
  for (const holder of lifecycles) {
    const epoch = epochAtHeight(epochsAsc, holder.firstDepositHeight);
    if (epoch === null) continue;
    const position = indexOf.get(epoch.epochIndex.toString());
    if (position === undefined) continue;
    const bucket = cohorts.get(position);
    if (bucket === undefined) cohorts.set(position, [holder]);
    else bucket.push(holder);
  }

  const curves: AdminRetentionCurve[] = [];
  for (const [position, members] of [...cohorts.entries()].sort((a, b) => a[0] - b[0])) {
    const cohortEpoch = epochsAsc[position]!;
    const belowMinimum = members.length < minCohortSize;
    const points: AdminRetentionPoint[] = RETENTION_HORIZONS.map((horizon) => {
      const target = epochsAsc[position + horizon];
      if (belowMinimum || target === undefined) {
        return { horizon, retained_bps: null };
      }
      const retained = members.filter(
        (m) => m.exitHeight === null || m.exitHeight > target.endHeight,
      ).length;
      // Integer bps by floor: the figure is a share, and rounding up would let
      // a partially-churned cohort read as fully retained.
      return { horizon, retained_bps: Math.floor((retained * 10_000) / members.length) };
    });
    curves.push({
      cohort_epoch: toSafeInt(cohortEpoch.epochIndex, "epochIndex"),
      cohort_size: members.length,
      points,
      below_minimum: belowMinimum,
    });
  }
  return curves;
}

/**
 * The concentration read's facts: the deepest band's positions, plus the
 * WHOLE-SET aggregates the bands are shares of.
 *
 * The aggregates are separate fields rather than something derivable from
 * `topDesc` on purpose. `topDesc` is capped at `CONCENTRATION_BAND_DEPTH`, so
 * summing or counting it answers a different question than the one the panel
 * asks — and answers it with a number that looks right. The reader produces all
 * three from ONE statement over the same holder set, so they cannot disagree.
 */
export interface HolderPositionFacts {
  /** Positive held positions, descending, capped at the deepest band. Values
   * only — the address is a GROUP BY key in SQL and is never selected. */
  topDesc: readonly bigint[];
  /** Every holder with a positive position, counted in SQL. Not `topDesc.length`. */
  holderCount: number;
  /** Sum of EVERY positive position — the denominator. Not `sum(topDesc)`. */
  totalPosition: bigint;
}

/**
 * TVL concentration as banded shares (plan §7.1 Q7) — no addresses, no absolute
 * amounts.
 *
 * Null below `minCohortSize` holders, and that gate is the whole point: among
 * three holders a top-1 share of 82% names one of them to anyone who can see
 * the chain, which is everyone.
 *
 * The denominator is `facts.totalPosition` — every positive position, not the
 * banded slice. Using the slice made each band a share of the top ten rather
 * than of the program, which reads as a plausible number and is wrong in the
 * direction that matters: it OVERSTATES concentration, and does so only once
 * the program outgrows the band depth.
 */
export function toConcentration(
  facts: HolderPositionFacts,
  minCohortSize: number = MIN_COHORT_SIZE,
): AdminConcentration | null {
  if (facts.holderCount < minCohortSize) return null;
  if (facts.totalPosition <= 0n) return null;
  const shareBps = (n: number): number => {
    const top = facts.topDesc.slice(0, n).reduce((sum, value) => sum + value, 0n);
    return toSafeInt((top * 10_000n) / facts.totalPosition, "concentrationBps");
  };
  // Band depths come from the shared list, so the field names and the read's
  // cap cannot drift apart: `CONCENTRATION_BAND_DEPTH` is that list's maximum.
  const [top1, top5, top10] = CONCENTRATION_BANDS;
  return {
    top1_bps: shareBps(top1),
    top5_bps: shareBps(top5),
    top10_bps: shareBps(top10),
    holder_count: facts.holderCount,
  };
}

// ── Validator cohorts ──────────────────────────────────────────────────────

/** Join the per-epoch validator aggregates to their settlement timestamps. */
export function toValidatorPoints(
  epochsAsc: readonly AdminEpochFacts[],
  aggregates: readonly ValidatorEpochAggregateFacts[],
): AdminValidatorPoint[] {
  const byEpoch = new Map(aggregates.map((a) => [a.epochIndex.toString(), a]));
  return epochsAsc.map((e) => {
    const agg = byEpoch.get(e.epochIndex.toString());
    return {
      epoch_index: toSafeInt(e.epochIndex, "epochIndex"),
      ended_at: new Date(Number(e.endedAtSeconds) * 1000).toISOString(),
      sampled: agg?.sampled ?? 0,
      eligible: agg?.eligible ?? 0,
      in_arrears: agg?.inArrears ?? 0,
      tip_paying: agg?.tipPaying ?? 0,
      purged: e.validatorsPurged,
    };
  });
}

// ── Upkeep timeliness ──────────────────────────────────────────────────────

/**
 * Bucket edges in seconds, shared by both distributions so the panel can put
 * them side by side. Open-ended at the top: a very late crank must land
 * somewhere truthful rather than being clamped into the last closed bucket.
 */
export const UPKEEP_BUCKET_EDGES = [
  0, 3_600, 21_600, 86_400, 259_200, 604_800, 1_209_600, 2_592_000,
] as const;

/** Start of the civil month AFTER `seconds`, UTC — when the next epoch becomes
 * eligible (liquid-staking-spec §9: `civil_month(block.time) > civil_month(last_run)`). */
export function nextMonthStartSeconds(seconds: number): number {
  const at = new Date(seconds * 1000);
  return Math.floor(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1, 0, 0, 0, 0) / 1000);
}

/**
 * Seconds between each epoch becoming ELIGIBLE and the permissionless crank
 * actually running it. The FIRST epoch of the series contributes no sample —
 * there is no previous close to measure eligibility from, and assuming one
 * would fabricate a lag.
 *
 * This is a lag, never negative: the contract cannot run an epoch before its
 * civil-month rollover, so a negative value would mean the facts disagree with
 * the contract. Such a sample is dropped rather than clamped to 0, because a
 * clamped 0 would report perfect timeliness for corrupt data.
 */
export function epochLagSeconds(epochsAsc: readonly AdminEpochFacts[]): number[] {
  const lags: number[] = [];
  for (let i = 1; i < epochsAsc.length; i++) {
    const eligibleAt = nextMonthStartSeconds(Number(epochsAsc[i - 1]!.endedAtSeconds));
    const lag = Number(epochsAsc[i]!.endedAtSeconds) - eligibleAt;
    if (lag >= 0) lags.push(lag);
  }
  return lags;
}

/** The p-th percentile of an ascending sample, nearest-rank. */
function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))]!;
}

/**
 * Bucket a sample set into the shared edges. Bounded by BUCKET COUNT, not by
 * sample count — which is why the panel serves a distribution rather than the
 * raw lags, whose number grows with history.
 *
 * An empty sample set yields every bucket at 0 with `sample_count: 0`, and the
 * panel renders "n/a" off the count rather than drawing a flat histogram that
 * looks like a measured result.
 *
 * `truncated` says the sample hit its cap and so describes the most recent
 * `sample_count` events rather than all history — a real answer, but a
 * different one, so it rides rather than being dropped.
 */
export function toUpkeepDistribution(
  samples: readonly number[],
  truncated = false,
): AdminUpkeepDistribution {
  const buckets: AdminUpkeepBucket[] = UPKEEP_BUCKET_EDGES.map((from, i) => ({
    from_seconds: from,
    to_seconds: UPKEEP_BUCKET_EDGES[i + 1] ?? null,
    count: 0,
  }));
  for (const sample of samples) {
    let index = 0;
    for (let i = 0; i < UPKEEP_BUCKET_EDGES.length; i++) {
      if (sample >= UPKEEP_BUCKET_EDGES[i]!) index = i;
    }
    buckets[index]!.count += 1;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    sample_count: samples.length,
    median_seconds: percentile(sorted, 50),
    p90_seconds: percentile(sorted, 90),
    buckets,
    truncated,
  };
}
