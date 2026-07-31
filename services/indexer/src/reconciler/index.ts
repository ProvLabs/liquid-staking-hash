// The reconciler (app-spec §9.6/§12.1) — the honesty alarm.
// It runs as its OWN loop at a slower cadence, INDEPENDENT of the ingestion
// workers, reading the live plane (fresh chain queries) vs the indexed plane
// (the DB) and comparing. Independence is the point: if the workers stall, the
// reconciler still runs, sees the growing lag/divergence, and opens incidents —
// it survives an indexer outage (§12.1.3). It advances no cursor; it only reads
// chain + indexed data and writes reconciler_runs + incidents.

import type { PrismaClient } from "@prisma/client";
import { expectObject } from "../decode/scalars.ts";
import { logger } from "../logger.ts";
import type { PinnedLcdClient, RpcClient } from "../transport/rpc.ts";
import { parseEpochSnapshot } from "../workers/epoch-history/decode.ts";
import { deriveActions, type LivePlane } from "./incidents.ts";
import { applyActions, readIndexedPlane } from "./store.ts";
import { TOLERANCES } from "./tolerances.ts";

export interface ReconcilerDeps {
  readonly prisma: PrismaClient;
  readonly rpc: RpcClient;
  readonly pinned: PinnedLcdClient;
  readonly contractAddress: string;
  readonly cadenceMs: number;
  sleep(ms: number): Promise<void>;
  readonly signal: AbortSignal;
  /** injectable clock (deterministic in tests). */
  now(): Date;
}

/** The contract `epoch_status` is halted when its `halted` flag is true. */
function parseHalted(data: unknown): boolean {
  return expectObject(data, "$.epoch_status")["halted"] === true;
}

/** Read the live plane: head, the chain's retained latest snapshot, halted. */
async function readLive(deps: ReconcilerDeps): Promise<LivePlane> {
  const head = await deps.rpc.latestHeight();

  const snapData = expectObject(
    await deps.pinned.smartAtHeight(deps.contractAddress, { epoch_snapshot: {} }, head),
    "$.data",
  );
  const snap = snapData["snapshot"];
  const snapshot =
    snap === null || snap === undefined
      ? null
      : (() => {
          const f = parseEpochSnapshot(snap);
          return { epochIndex: f.epochIndex, totalShares: f.totalShares, tvvAfter: f.tvvAfter };
        })();

  const halted = parseHalted(
    await deps.pinned.smartAtHeight(deps.contractAddress, { epoch_status: {} }, head),
  );

  return { head, snapshot, halted };
}

/** One reconciliation pass: read both planes, derive, apply. */
export async function reconcileOnce(deps: ReconcilerDeps): Promise<void> {
  const live = await readLive(deps);
  const indexed = await readIndexedPlane(deps.prisma, live.snapshot?.epochIndex ?? null);
  const actions = deriveActions(live, indexed, TOLERANCES, deps.now());
  await applyActions(deps.prisma, actions);
  logger.info("reconciled", {
    chainHeight: live.head,
    indexedHeight: actions.run.indexedHeight,
    count: actions.open.length,
  });
}

/** Run the reconciler loop until the signal aborts. */
export async function runReconciler(deps: ReconcilerDeps): Promise<void> {
  while (!deps.signal.aborted) {
    await reconcileOnce(deps);
    if (deps.signal.aborted) break;
    await deps.sleep(deps.cadenceMs);
  }
}
