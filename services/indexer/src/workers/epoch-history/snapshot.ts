// Height-pinned snapshot fetch: at each crank height H, query the contract's
// epoch_snapshot and apr AS OF H (via `x-cosmos-block-height`), which returns
// the epoch that closed at H — the only way to recover history the contract no
// longer retains (single-snapshot retention, spec §13 / §9.3). Deterministic:
// the state at a past height never changes, so re-querying converges (idempotent
// replay, SECURITY.md).

import { expectObject } from "../../decode/scalars.ts";
import { parseApr, parseEpochSnapshot, type EpochSnapshotFields } from "./decode.ts";
import type { Crank } from "./boundaries.ts";

/** A fully-decoded `epoch_snapshots` row, ready to upsert. */
export interface EpochRow extends EpochSnapshotFields {
  grossAprBps: number;
  netAprBps: number;
  /** the crank tx that closed this epoch */
  txhash: string;
  /** the crank height we queried at (ingestion height) */
  height: bigint;
  /** consensus time at the crank height */
  observedAt: Date;
}

/** The reads a snapshot fetch needs (height-pinned smart query + block time). */
export interface SnapshotSource {
  smartAtHeight(contract: string, query: Record<string, unknown>, height: bigint | number): Promise<unknown>;
  blockTime(height: bigint | number): Promise<Date>;
}

/**
 * Fetch and decode the epoch that closed at `crank.height`. Returns null if the
 * contract reports no snapshot at that height (defensive — should not happen at
 * a real crank height; a null just skips the row rather than fabricating one).
 */
export async function fetchEpochAt(
  src: SnapshotSource,
  contract: string,
  crank: Crank,
): Promise<EpochRow | null> {
  const envelope = expectObject(await src.smartAtHeight(contract, { epoch_snapshot: {} }, crank.height), "$.data");
  const snapshot = envelope["snapshot"];
  if (snapshot === null || snapshot === undefined) return null;

  const fields = parseEpochSnapshot(snapshot);
  const apr = parseApr(await src.smartAtHeight(contract, { apr: {} }, crank.height));
  const observedAt = await src.blockTime(crank.height);

  return {
    ...fields,
    grossAprBps: apr.grossAprBps,
    netAprBps: apr.netAprBps,
    txhash: crank.txhash,
    height: crank.height,
    observedAt,
  };
}
