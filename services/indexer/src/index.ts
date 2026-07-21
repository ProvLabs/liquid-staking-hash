// Indexer entrypoint (scaffold shell, app plan PR 1.1; made runnable in the
// full-stack wiring, PR 1.5).
//
// The indexer is a set of long-running worker loops (chain-events,
// epoch-history, validator-sampler, market-sampler) each with a durable cursor
// in `indexer_checkpoints` (app-spec §6, §9.2). Those workers, the reconciler,
// and incident derivation land in M2 (PRs 2.1–2.5). This scaffold establishes
// the process shell only: it connects to the `indexed` schema as the
// `indexer_writer` role (ADR-001 Decision 1), proves the connection stays live,
// and idles until a signal — the shape M2 workers slot into.
//
// Boundary invariants (plan §1 ownership table): the indexer serves NO HTTP to
// users, holds NO keys, and signs NOTHING. There is deliberately no server,
// listener, or signer here — liveness is proven by a database ping written to a
// heartbeat file the container healthcheck reads (scripts/healthcheck.mjs), not
// by exposing a port.
//
// M2.0 added the per-(chain_id, contract) isolation boot check (spec §9.3): the
// process fails closed if the database holds a history from a different
// chain/contract than config. M2.1 wires the first worker (chain-events): the
// supervisor now builds the RPC head source, starts the worker loop(s), and
// keeps the DB-ping heartbeat. Each worker trails the head, pages the
// un-processed range, and commits per window (src/runtime/*). A worker crash is
// fatal: it aborts the others and exits non-zero so compose restarts from the
// last committed cursor.

import { writeFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { db } from "./db.ts";
import { logger } from "./logger.ts";
import { assertChainIsolation } from "./runtime/streams.ts";
import { runWorker, type Worker, type WorkerRuntimeDeps } from "./runtime/worker.ts";
import { PinnedLcdClient, RpcClient } from "./transport/rpc.ts";
import { createChainEventsWorker } from "./workers/chain-events/index.ts";
import { createEpochHistoryWorker } from "./workers/epoch-history/index.ts";

/** How often the supervisor re-proves database reachability. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Heartbeat file the container healthcheck stats for freshness (no HTTP). */
const heartbeatFile = process.env.INDEXER_HEARTBEAT_FILE ?? "/tmp/indexer.heartbeat";

function touchHeartbeat(nowMs: number): void {
  // Content is the last-good ping timestamp; the healthcheck only needs mtime.
  writeFileSync(heartbeatFile, `${nowMs}\n`);
}

/** Abortable sleep — resolves early when the signal aborts (clean shutdown). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Boot the supervisor: validate config, prove the database is reachable, assert
 * chain/contract isolation, start the worker loop(s), and hold the process open
 * with a periodic DB ping. Resolves on a clean shutdown signal.
 */
export async function run(): Promise<void> {
  const config = loadConfig();
  const prisma = db();

  // Prove connectivity up front — a half-configured start is an error, not a
  // best-effort continue (SECURITY.md: bound inputs, fail loudly).
  await prisma.$queryRaw`SELECT 1`;

  // Refuse to append to a history captured under a different chain/contract
  // (spec §9.3): a devnet redeploy resets the DB with the chain, so a mismatch
  // is a misconfiguration, not a resume. Fails closed before any worker runs.
  await assertChainIsolation(prisma, {
    chainId: config.chainId,
    contractAddress: config.contractAddress,
  });

  const controller = new AbortController();
  const rpc = new RpcClient(config.rpcUrl);
  const pinned = new PinnedLcdClient(config.lcdUrl);

  // Composition root: the workers the supervisor runs. Explicit list (the
  // `registerWorker` seam is available for self-registration; kept explicit
  // here so startup is testable and obvious). Reconciler + more workers append
  // in later M2 PRs.
  const workers: Worker[] = [
    createChainEventsWorker({
      rpc,
      scope: { vaultAddress: config.vaultAddress, receiptDenom: config.receiptDenom },
    }),
    createEpochHistoryWorker({ rpc, pinned, contractAddress: config.contractAddress }),
  ];

  const deps: WorkerRuntimeDeps = {
    prisma,
    headHeight: () => rpc.latestHeight(),
    confirmationDepth: config.confirmationDepth,
    maxWindowSpan: BigInt(config.indexWindowSpan),
    pollIntervalMs: config.pollIntervalMs,
    sleep: (ms) => sleep(ms, controller.signal),
    signal: controller.signal,
  };

  touchHeartbeat(Date.now());
  logger.info("indexer started", { count: workers.length });

  // Start each worker; a crash is fatal (abort siblings, exit non-zero).
  const loops = workers.map((worker) =>
    runWorker(worker, deps).catch((cause: unknown) => {
      logger.error("worker crashed", {
        stream: worker.stream,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      process.exitCode = 1;
      controller.abort();
    }),
  );

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      void (async () => {
        try {
          await prisma.$queryRaw`SELECT 1`;
          touchHeartbeat(Date.now());
        } catch (cause) {
          // A lost database is fatal: stop touching the heartbeat (the
          // healthcheck flips unhealthy) and exit non-zero so compose restarts.
          logger.error("database ping failed", {
            error: cause instanceof Error ? cause.message : String(cause),
          });
          clearInterval(timer);
          process.exitCode = 1;
          controller.abort();
        }
      })();
    }, HEARTBEAT_INTERVAL_MS);

    // End on a signal OR when a worker crash aborts the run.
    const finish = (): void => {
      clearInterval(timer);
      resolve();
    };
    controller.signal.addEventListener("abort", finish, { once: true });

    const shutdown = (signal: string): void => {
      logger.info("indexer shutting down", { kind: signal });
      controller.abort();
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  });

  // Let the worker loops observe the abort and unwind before disconnecting.
  await Promise.allSettled(loops);
  await prisma.$disconnect();
}

// Only run when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error: unknown) => {
    logger.error("indexer failed to start", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
