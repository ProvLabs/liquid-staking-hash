// The worker loop shell every M2 ingestion worker slots into (app-spec §9.2).
// A worker declares its stream, an optional backfill start height, and a
// `process(tx, window)` body; the runner owns the mechanics: poll the head,
// trail by a confirmation depth, page the un-processed range into bounded
// windows, and run each through `runWindow` so the cursor advances atomically.
//
// Workers register through the `registerWorker` seam so the supervisor
// (src/index.ts) starts them without each worker re-editing the entrypoint.
// The runtime is injectable (head source, clock, sleep, abort signal) so the
// pure pieces and one guarded loop pass are unit-testable without Postgres or a
// live chain. Full supervisor wiring of the head source lands with the first
// worker; this PR ships the runtime and its tests.

import type { Prisma, PrismaClient } from "../prisma.ts";
import { logger } from "../logger.ts";
import { readCheckpoint, runWindow, trailingTarget, type Window } from "./checkpoint.ts";

/**
 * A worker is two-phase so chain I/O never happens inside a DB transaction:
 *
 *  1. `collect(window)` — read the chain (RPC/LCD) and decode a `Batch` of the
 *     window's facts. NO database access. Runs outside any transaction.
 *  2. `write(tx, window, batch)` — apply that batch to the `indexed` schema on
 *     the given transaction client. NO network access.
 *
 * The runner wraps `write` and the cursor advance in one `runWindow`
 * transaction, so a Postgres transaction is only ever open for local writes,
 * never across a network round-trip.
 */
export interface Worker<Batch = unknown> {
  /** durable checkpoint key (use a `STREAMS` constant) */
  readonly stream: string;
  /** first height to ingest when there is no checkpoint yet (default 0) */
  readonly startHeight?: bigint;
  /** read + decode the window's facts from chain (no DB) */
  collect(window: Window): Promise<Batch>;
  /** apply the batch + advance nothing (the runner advances the cursor) */
  write(tx: Prisma.TransactionClient, window: Window, batch: Batch): Promise<void>;
}

/**
 * Split the inclusive range `[from, to]` into windows of at most `maxSpan`
 * heights. Empty when `from > to`. Pure — the pagination unit under test.
 */
export function planWindows(from: bigint, to: bigint, maxSpan: bigint): Window[] {
  if (maxSpan <= 0n) throw new Error("maxSpan must be > 0");
  const windows: Window[] = [];
  let cursor = from;
  while (cursor <= to) {
    const end = cursor + maxSpan - 1n;
    windows.push({ from: cursor, to: end < to ? end : to });
    cursor = end + 1n;
  }
  return windows;
}

// --- registration seam ------------------------------------------------------

const registry: Worker[] = [];

/** Register a worker for the supervisor to start. Streams must be unique. */
export function registerWorker(worker: Worker): void {
  if (registry.some((w) => w.stream === worker.stream)) {
    throw new Error(`worker already registered for stream ${worker.stream}`);
  }
  registry.push(worker);
}

export function registeredWorkers(): readonly Worker[] {
  return registry;
}

/** Test seam: drop all registrations. */
export function clearRegisteredWorkers(): void {
  registry.length = 0;
}

// --- the loop ---------------------------------------------------------------

export interface WorkerRuntimeDeps {
  readonly prisma: PrismaClient;
  /** current chain head height (e.g. RpcClient.latestHeight) */
  headHeight(): Promise<bigint>;
  /** confirmation depth to trail the head by (default 0, instant finality) */
  readonly confirmationDepth: number;
  /** max heights per window */
  readonly maxWindowSpan: bigint;
  /** delay between polls when caught up */
  readonly pollIntervalMs: number;
  sleep(ms: number): Promise<void>;
  /** abort to stop the loop at the next safe point (shutdown) */
  readonly signal: AbortSignal;
}

/**
 * Drive one worker until `deps.signal` aborts. Each pass processes every window
 * from the last committed height up to the trailing target, committing the
 * cursor per window; then sleeps. A window that throws propagates (crash →
 * compose restart → resume from the last committed cursor).
 */
export async function runWorker(worker: Worker, deps: WorkerRuntimeDeps): Promise<void> {
  const committed = await readCheckpoint(deps.prisma, worker.stream);
  let next = committed === null ? (worker.startHeight ?? 0n) : committed + 1n;
  // CometBFT block heights are 1-based — there is no block 0, and
  // `block_results?height=0` is a hard RPC error. An empty checkpoint with a
  // 0 (or unset) startHeight would otherwise page from 0 and crash the worker
  // on its first live read; floor the first ingested height at 1.
  if (next < 1n) next = 1n;

  while (!deps.signal.aborted) {
    const head = await deps.headHeight();
    const target = trailingTarget(head, deps.confirmationDepth);

    if (target >= next) {
      for (const window of planWindows(next, target, deps.maxWindowSpan)) {
        if (deps.signal.aborted) return;
        // Phase 1: read+decode the chain OUTSIDE any transaction.
        const batch = await worker.collect(window);
        if (deps.signal.aborted) return;
        // Phase 2: apply the batch and advance the cursor in one transaction.
        await runWindow(deps.prisma, worker.stream, window, (tx, w) => worker.write(tx, w, batch));
        next = window.to + 1n;
        logger.info("window committed", {
          stream: worker.stream,
          height: window.to,
          chainHeight: head,
          indexedHeight: window.to,
        });
      }
    }

    if (deps.signal.aborted) return;
    await deps.sleep(deps.pollIntervalMs);
  }
}
