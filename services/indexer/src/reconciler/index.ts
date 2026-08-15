// The reconciler (app-spec §9.6/§12.1) — the honesty alarm.
// It runs as its OWN loop at a slower cadence, INDEPENDENT of the ingestion
// workers, reading the live plane (fresh chain queries) vs the indexed plane
// (the DB) and comparing. Independence is the point: if the workers stall, the
// reconciler still runs, sees the growing lag/divergence, and opens incidents —
// it survives an indexer outage (§12.1.3). It advances no cursor; it only reads
// chain + indexed data and writes reconciler_runs + incidents.

import type { PrismaClient } from "../prisma.ts";
import { expectObject } from "../decode/scalars.ts";
import { logger } from "../logger.ts";
import type { PinnedLcdClient, RpcClient } from "../transport/rpc.ts";
import { parseEpochSnapshot } from "../workers/epoch-history/decode.ts";
import { parseJailReports } from "../workers/validator-sampler/decode.ts";
import { parseVaultPause } from "./decode.ts";
import { deriveActions, type LivePlane } from "./incidents.ts";
import { applyActions, readIndexedPlane } from "./store.ts";
import { TOLERANCES } from "./tolerances.ts";

export interface ReconcilerDeps {
  readonly prisma: PrismaClient;
  readonly rpc: RpcClient;
  readonly pinned: PinnedLcdClient;
  readonly contractAddress: string;
  readonly vaultAddress: string;
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

/** Read the live plane: head, the chain's retained latest snapshot, halted,
 * the vault's pause state, and the contract's jail reports. A pass is
 * ALL-OR-NOTHING: any failed read here throws, the pass derives nothing and
 * closes nothing — a failed vault read must never read as "unpaused". */
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

  const pause = parseVaultPause(
    await deps.pinned.getAtHeight(`vault/v1/vaults/${deps.vaultAddress}`, {}, head),
  );

  const jailReports = parseJailReports(
    expectObject(
      await deps.pinned.smartAtHeight(deps.contractAddress, { jail_reports: {} }, head),
      "$.data",
    ),
  );

  return { head, snapshot, halted, pause, jailReports };
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

/** Run the reconciler loop until the signal aborts.
 *
 * A failed pass is LOGGED AND SKIPPED, never fatal: the reconciler advances
 * no cursor, so the workers' crash-fatal rule does not apply to it — a
 * skipped pass is honest (the previous run's `ranAt` ages, and the chrome's
 * stale-heads clause surfaces exactly that), while a killed process is a
 * silenced alarm. The alarm must outlive what it watches. */
export async function runReconciler(deps: ReconcilerDeps): Promise<void> {
  while (!deps.signal.aborted) {
    try {
      await reconcileOnce(deps);
    } catch (cause) {
      logger.error("reconciler pass failed; skipping to next cadence", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (deps.signal.aborted) break;
    await deps.sleep(deps.cadenceMs);
  }
}
