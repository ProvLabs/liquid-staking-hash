// The epoch-history worker (app-spec §9.2/§9.3, master plan PR 2.2): epoch
// decomposition → `epoch_snapshots`, backfilled from the contract's history.
// Two-phase: `collect` finds epoch cranks in the window (tx-search) and reads
// each closed epoch by height-pinned smart query (no DB); `write` upserts the
// rows by epochIndex (no network). Because the on-chain state at a past height
// is deterministic and the key is epochIndex, replay from any height converges.

import { STREAMS } from "../../runtime/streams.ts";
import type { Worker } from "../../runtime/worker.ts";
import type { PinnedLcdClient, RpcClient } from "../../transport/rpc.ts";
import { collectCranks } from "./boundaries.ts";
import { fetchEpochAt, type EpochRow, type SnapshotSource } from "./snapshot.ts";
import { PrismaEpochStore } from "./store.ts";
import { applyEpochRows } from "./write.ts";

export interface EpochHistoryDeps {
  readonly rpc: RpcClient;
  readonly pinned: PinnedLcdClient;
  readonly contractAddress: string;
  /** backfill start (contract instantiation height). Defaults to genesis;
   * instantiation-height discovery is a future optimization (the epoch scan is
   * cheap — one tx-search per window, pinned queries only at crank heights). */
  readonly startHeight?: bigint;
}

export function createEpochHistoryWorker(deps: EpochHistoryDeps): Worker<EpochRow[]> {
  const source: SnapshotSource = {
    smartAtHeight: (contract, query, height) => deps.pinned.smartAtHeight(contract, query, height),
    blockTime: (height) => deps.rpc.blockTime(height),
  };

  return {
    stream: STREAMS.epochHistory,
    startHeight: deps.startHeight ?? 0n,
    collect: async (window) => {
      const cranks = await collectCranks(deps.rpc, deps.contractAddress, window);
      const rows: EpochRow[] = [];
      for (const crank of cranks) {
        const row = await fetchEpochAt(source, deps.contractAddress, crank);
        if (row) rows.push(row);
      }
      return rows;
    },
    write: (tx, _window, rows) => applyEpochRows(new PrismaEpochStore(tx), rows),
  };
}
