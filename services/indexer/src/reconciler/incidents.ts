// Incident derivation (app-spec §9.6): incidents are COMPUTED from indexed +
// live facts, never hand-entered, and the reconciler is their SOLE writer.
// `deriveActions` is a pure function of the fetched live/indexed planes → the
// reconciler_run to write plus the incidents to open/close this pass. Keeping it
// pure is what lets the alarm be unit-tested (corrupt an indexed value → a
// reconciler_divergence open) without Postgres; index.ts applies the actions.
//
// Incident kinds split into:
//   - closeable (open while the condition holds, close when it clears):
//     reconciler_divergence, indexer_lag, contract_halted.
//   - point-in-time (a historical fact; opened once, never auto-closed):
//     slash_write_down, redemption_refund.
//
// Deferred to a documented fast-follow (each needs a live decoder this PR does
// not add — noted in app-spec §9.6): vault_paused (vault query), jail_report
// (jail lifecycle), epoch_overdue (config interval + calendar-month), and the
// queue-length delta (vault pending_swap_outs).

import { computeDeltas, type LiveSnapshot } from "./deltas.ts";
import { computeLag } from "./lag.ts";
import type { Tolerances } from "./tolerances.ts";

export type IncidentKind =
  | "reconciler_divergence"
  | "indexer_lag"
  | "contract_halted"
  | "slash_write_down"
  | "redemption_refund";

export type IncidentSeverity = "info" | "warning" | "critical";

export interface LivePlane {
  head: bigint;
  snapshot: LiveSnapshot | null;
  halted: boolean;
}

export interface IndexedPlane {
  maxEpoch: bigint | null;
  /** the indexed epoch_snapshots row for the chain's latest epoch, or null. */
  chainEpochRow: { totalShares: bigint; tvvAfter: bigint } | null;
  checkpoints: { stream: string; cursorHeight: bigint }[];
  /** indexed epochs that recorded a slash write-down (> 0). */
  writeDownEpochs: bigint[];
  /** indexed redemption requests that terminated as a refund. */
  refundedRequestIds: string[];
}

export interface RunData {
  ranAt: Date;
  chainHeight: bigint;
  indexedHeight: bigint;
  deltas: unknown; // JSON-safe (bigints stringified)
  withinTolerance: boolean;
}

export interface OpenAction {
  kind: IncidentKind;
  dedupeKey: string;
  severity: IncidentSeverity;
  openedHeight: bigint | null;
  payload: unknown; // JSON-safe
  /** link the written reconciler_run to this incident's id. */
  linkToRun?: boolean;
}

export interface CloseAction {
  kind: IncidentKind;
  dedupeKey: string;
}

export interface ReconcileActions {
  run: RunData;
  open: OpenAction[];
  close: CloseAction[];
}

const s = (n: bigint | null): string | null => (n === null ? null : n.toString());

export function deriveActions(
  live: LivePlane,
  indexed: IndexedPlane,
  tol: Tolerances,
  now: Date,
): ReconcileActions {
  const open: OpenAction[] = [];
  const close: CloseAction[] = [];

  // --- reconciler divergence (the alarm) ---
  const deltas =
    live.snapshot === null
      ? null
      : computeDeltas(live.snapshot, indexed.chainEpochRow, indexed.maxEpoch, tol);

  const deltaPayload = deltas
    ? {
        chainEpoch: deltas.chainEpoch.toString(),
        maxIndexedEpoch: s(deltas.maxIndexedEpoch),
        epochLag: deltas.epochLag.toString(),
        compared: deltas.compared,
        totalSharesDelta: s(deltas.totalSharesDelta),
        tvvDelta: s(deltas.tvvDelta),
        divergentMetrics: deltas.divergentMetrics,
      }
    : { coldStart: true };

  const withinTolerance = deltas ? deltas.withinTolerance : true;
  if (deltas && !withinTolerance) {
    open.push({
      kind: "reconciler_divergence",
      dedupeKey: "latest",
      severity: "critical",
      openedHeight: live.head,
      payload: deltaPayload,
      linkToRun: true,
    });
  } else {
    close.push({ kind: "reconciler_divergence", dedupeKey: "latest" });
  }

  // --- indexer lag ---
  const lag = computeLag(indexed.checkpoints, live.head, tol);
  if (lag.over) {
    open.push({
      kind: "indexer_lag",
      dedupeKey: "max",
      severity: "warning",
      openedHeight: live.head,
      payload: {
        maxLag: lag.maxLag.toString(),
        perStream: lag.perStream.map((p) => ({ stream: p.stream, lag: p.lag.toString() })),
      },
    });
  } else {
    close.push({ kind: "indexer_lag", dedupeKey: "max" });
  }

  // --- contract halted ---
  if (live.halted) {
    open.push({
      kind: "contract_halted",
      dedupeKey: "halted",
      severity: "critical",
      openedHeight: live.head,
      payload: {},
    });
  } else {
    close.push({ kind: "contract_halted", dedupeKey: "halted" });
  }

  // --- point-in-time facts (opened once, never auto-closed) ---
  for (const epoch of indexed.writeDownEpochs) {
    open.push({
      kind: "slash_write_down",
      dedupeKey: `epoch:${epoch}`,
      severity: "warning",
      openedHeight: null,
      payload: { epochIndex: epoch.toString() },
    });
  }
  for (const requestId of indexed.refundedRequestIds) {
    open.push({
      kind: "redemption_refund",
      dedupeKey: `request:${requestId}`,
      severity: "info",
      openedHeight: null,
      payload: { requestId },
    });
  }

  const run: RunData = {
    ranAt: now,
    chainHeight: live.head,
    indexedHeight: lag.indexedHeight,
    deltas: deltaPayload,
    withinTolerance,
  };

  return { run, open, close };
}
