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
// Still deferred (app-spec §9.6): epoch_overdue and the queue-length delta.

import type { JailReport } from "../workers/validator-sampler/decode.ts";
import { computeDeltas, type LiveSnapshot } from "./deltas.ts";
import type { VaultPause } from "./decode.ts";
import { computeLag } from "./lag.ts";
import type { Tolerances } from "./tolerances.ts";

export type IncidentKind =
  | "reconciler_divergence"
  | "indexer_lag"
  | "contract_halted"
  | "vault_paused"
  | "jail_report"
  | "slash_write_down"
  | "redemption_refund";

export type IncidentSeverity = "info" | "warning" | "critical";

export interface LivePlane {
  head: bigint;
  snapshot: LiveSnapshot | null;
  halted: boolean;
  /** Never null: a failed vault read skips the pass — unknown is not
   * "unpaused". */
  pause: VaultPause;
  /** The contract's live jail reports; bounded by its validator bound. */
  jailReports: JailReport[];
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
  /** `${kind} ${dedupeKey}` of point-in-time incidents already recorded.
   * Point-in-time facts (slash/refund) never change once incident-ed, so we
   * open ONLY genuinely-new ones each pass instead of re-upserting the entire
   * lifetime history every 30 s (bounded per-pass work). */
  existingPointInTimeKeys: Set<string>;
  /** Open jail_report dedupeKeys, diffed against live reports to close ended
   * episodes. */
  openJailReportKeys: string[];
}

/** Composite membership key for a point-in-time incident. */
function ptKey(kind: IncidentKind, dedupeKey: string): string {
  return `${kind} ${dedupeKey}`;
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

  // --- vault paused: warning severity (halt stays critical) ---
  if (live.pause.paused) {
    open.push({
      kind: "vault_paused",
      dedupeKey: "paused",
      severity: "warning",
      openedHeight: live.head,
      payload: { reason: live.pause.reason },
    });
  } else {
    close.push({ kind: "vault_paused", dedupeKey: "paused" });
  }

  // --- jail reports: keyed per EPISODE (valoper + reportedAt) — a bare
  // valoper key would merge a re-jail into the first episode's record.
  const liveJailKeys = new Set<string>();
  for (const report of live.jailReports) {
    const dedupeKey = `valoper:${report.valoper}:${report.reportedAtSeconds}`;
    liveJailKeys.add(dedupeKey);
    open.push({
      kind: "jail_report",
      dedupeKey,
      severity: "warning",
      openedHeight: live.head,
      payload: {
        valoper: report.valoper,
        reportedAtSeconds: report.reportedAtSeconds.toString(),
        purgeReadyAtSeconds: report.purgeReadyAtSeconds.toString(),
      },
    });
  }
  for (const openKey of indexed.openJailReportKeys) {
    if (!liveJailKeys.has(openKey)) {
      close.push({ kind: "jail_report", dedupeKey: openKey });
    }
  }

  // --- point-in-time facts (opened once, never auto-closed) ---
  // Only open facts not already recorded — these never change once incident-ed,
  // so re-upserting the whole history every pass is wasted, growing work.
  for (const epoch of indexed.writeDownEpochs) {
    const dedupeKey = `epoch:${epoch}`;
    if (indexed.existingPointInTimeKeys.has(ptKey("slash_write_down", dedupeKey))) continue;
    open.push({
      kind: "slash_write_down",
      dedupeKey,
      severity: "warning",
      openedHeight: null,
      payload: { epochIndex: epoch.toString() },
    });
  }
  for (const requestId of indexed.refundedRequestIds) {
    const dedupeKey = `request:${requestId}`;
    if (indexed.existingPointInTimeKeys.has(ptKey("redemption_refund", dedupeKey))) continue;
    open.push({
      kind: "redemption_refund",
      dedupeKey,
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
