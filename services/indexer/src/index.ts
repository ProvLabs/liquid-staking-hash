// Indexer entrypoint and worker supervisor.
//
// The indexer is a set of long-running worker loops (chain-events,
// epoch-history, validator-sampler, governance) each with a durable cursor in
// `indexer_checkpoints` (app-spec §6, §9.2). The supervisor connects to the
// `indexed` schema as the `indexer_writer` role (ADR-001 Decision 1), builds
// the RPC head source, and starts the worker loops. Each worker trails the
// head, pages the un-processed range, and commits per window (`src/runtime/*`).
//
// Boundary invariants: the indexer serves NO HTTP to users, holds NO keys, and
// signs NOTHING. There is deliberately no server, listener, or signer here —
// liveness is proven by a database ping written to a heartbeat file the
// container healthcheck reads (`scripts/healthcheck.mjs`), not by exposing a
// port.
//
// Two fail-closed properties:
//   * The per-(chain_id, contract) isolation boot check (spec §9.3) aborts
//     startup if the database holds a history from a different chain or
//     contract than config names.
//   * A worker crash is fatal: it aborts the others and exits non-zero, so
//     compose restarts the process from the last committed cursor rather than
//     letting the surviving streams drift ahead of the dead one.

import { writeFileSync } from "node:fs";
import { type IndexerConfig, loadConfig } from "./config.ts";
import { db } from "./db.ts";
import { logger } from "./logger.ts";
import { assertChainIsolation } from "./runtime/streams.ts";
import { runWorker, type Worker, type WorkerRuntimeDeps } from "./runtime/worker.ts";
import { PinnedLcdClient, RpcClient } from "./transport/rpc.ts";
import { createChainEventsWorker } from "./workers/chain-events/index.ts";
import { createEpochHistoryWorker } from "./workers/epoch-history/index.ts";
import { createGovernanceWorker } from "./workers/governance/index.ts";
import { createValidatorSamplerWorker } from "./workers/validator-sampler/index.ts";
import { runReconciler } from "./reconciler/index.ts";

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
 * The composition root's worker set. Exported so the start-height wiring is
 * assertable: a stream left at the `startHeight` default pages from height 1,
 * which on a chain with millions of blocks never converges. Pinned by
 * test/workers/build-workers.test.ts.
 *
 * @param config validated indexer configuration
 * @param deps chain transports the workers read through
 * @returns one worker per ingestion stream, each with an explicit start height
 */
export function buildWorkers(
  config: IndexerConfig,
  deps: { rpc: RpcClient; pinned: PinnedLcdClient },
): Worker[] {
  const { rpc, pinned } = deps;
  const startHeight = BigInt(config.indexStartHeight);
  return [
    createChainEventsWorker({
      rpc,
      startHeight,
      scope: {
        vaultAddress: config.vaultAddress,
        receiptDenom: config.receiptDenom,
        contractAddress: config.contractAddress,
      },
    }),
    createEpochHistoryWorker({
      rpc,
      pinned,
      startHeight,
      contractAddress: config.contractAddress,
    }),
    createValidatorSamplerWorker({
      rpc,
      pinned,
      startHeight,
      contractAddress: config.contractAddress,
    }),
    // Governance starts on every chain, including one with no x/group substrate
    // at all: policy discovery then resolves to the empty set and the worker
    // commits empty windows, the honest no-governance state rather than a crash
    // or a silently disabled stream.
    createGovernanceWorker({
      rpc,
      pinned,
      contractAddress: config.contractAddress,
      lcdUrl: config.lcdUrl,
      overridePolicies: config.govGroupPolicies,
      startHeight: BigInt(config.govStartHeight),
    }),
  ];
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
  // `registerWorker` seam is available for self-registration; kept explicit in
  // `buildWorkers` so startup is testable and obvious).
  const workers = buildWorkers(config, { rpc, pinned });

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

  const onLoopCrash =
    (stream: string) =>
    (cause: unknown): void => {
      logger.error("worker crashed", {
        stream,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      process.exitCode = 1;
      controller.abort();
    };

  // Start each worker; a crash is fatal (abort siblings, exit non-zero).
  const loops = workers.map((worker) => runWorker(worker, deps).catch(onLoopCrash(worker.stream)));

  // The reconciler runs as its own independent loop (§12.1.3): it must keep
  // running even if the ingestion workers stall, so it can see the growing lag.
  loops.push(
    runReconciler({
      prisma,
      rpc,
      pinned,
      contractAddress: config.contractAddress,
      cadenceMs: config.reconcileIntervalMs,
      sleep: (ms) => sleep(ms, controller.signal),
      signal: controller.signal,
      now: () => new Date(),
    }).catch(onLoopCrash("reconciler")),
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
