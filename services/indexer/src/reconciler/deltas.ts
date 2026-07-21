// Indexed-vs-live delta computation (app-spec §9.5.6). The "live plane" here is
// the chain's retained latest epoch snapshot (the authoritative current epoch
// record); the "indexed plane" is the indexer's stored copy of that same epoch.
// Comparing them detects whether the indexed data is a FAITHFUL copy — a
// corrupted/buggy indexed row diverges from chain and trips the alarm. When the
// indexer simply has not ingested the chain's latest epoch yet, that is lag
// (indexer_lag), not divergence, so no value comparison is made.

import type { Tolerances } from "./tolerances.ts";

export interface LiveSnapshot {
  epochIndex: bigint;
  totalShares: bigint;
  tvvAfter: bigint;
}

export interface DeltaResult {
  chainEpoch: bigint;
  maxIndexedEpoch: bigint | null;
  /** how many epochs the indexer trails chain by (0 when caught up). */
  epochLag: bigint;
  /** true only when the indexed row for the chain epoch existed and was compared. */
  compared: boolean;
  /** indexed − chain (null when not compared). */
  totalSharesDelta: bigint | null;
  tvvDelta: bigint | null;
  divergentMetrics: string[];
  withinTolerance: boolean;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/**
 * Compare the chain's latest snapshot against the indexer's stored row for that
 * same epoch (`indexedForChainEpoch`, null if not yet ingested).
 */
export function computeDeltas(
  live: LiveSnapshot,
  indexedForChainEpoch: { totalShares: bigint; tvvAfter: bigint } | null,
  maxIndexedEpoch: bigint | null,
  tol: Tolerances,
): DeltaResult {
  const epochLag = live.epochIndex - (maxIndexedEpoch ?? -1n);

  if (indexedForChainEpoch === null) {
    // The indexer has not stored this epoch yet — lag, not divergence.
    return {
      chainEpoch: live.epochIndex,
      maxIndexedEpoch,
      epochLag,
      compared: false,
      totalSharesDelta: null,
      tvvDelta: null,
      divergentMetrics: [],
      withinTolerance: true,
    };
  }

  const totalSharesDelta = indexedForChainEpoch.totalShares - live.totalShares;
  const tvvDelta = indexedForChainEpoch.tvvAfter - live.tvvAfter;
  const divergentMetrics: string[] = [];
  if (abs(totalSharesDelta) > tol.totalShares) divergentMetrics.push("total_shares");
  if (abs(tvvDelta) > tol.tvvAfter) divergentMetrics.push("tvv_after");

  return {
    chainEpoch: live.epochIndex,
    maxIndexedEpoch,
    epochLag,
    compared: true,
    totalSharesDelta,
    tvvDelta,
    divergentMetrics,
    withinTolerance: divergentMetrics.length === 0,
  };
}
