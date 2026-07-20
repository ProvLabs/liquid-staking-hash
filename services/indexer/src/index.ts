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

import { writeFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { db } from "./db.ts";
import { logger } from "./logger.ts";

/** How often the supervisor re-proves database reachability. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Heartbeat file the container healthcheck stats for freshness (no HTTP). */
const heartbeatFile = process.env.INDEXER_HEARTBEAT_FILE ?? "/tmp/indexer.heartbeat";

function touchHeartbeat(nowMs: number): void {
  // Content is the last-good ping timestamp; the healthcheck only needs mtime.
  writeFileSync(heartbeatFile, `${nowMs}\n`);
}

/**
 * Boot the scaffold supervisor: validate config, prove the database is
 * reachable as the configured role, then hold the process open with a periodic
 * ping. Resolves only on a clean shutdown signal.
 */
export async function run(): Promise<void> {
  const config = loadConfig();
  const prisma = db();

  // Prove connectivity up front — a half-configured start is an error, not a
  // best-effort continue (SECURITY.md: bound inputs, fail loudly).
  await prisma.$queryRaw`SELECT 1`;
  touchHeartbeat(Date.now());
  logger.info("indexer scaffold started");

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
          void prisma.$disconnect().finally(() => resolve());
        }
      })();
    }, HEARTBEAT_INTERVAL_MS);

    const shutdown = (signal: string): void => {
      logger.info("indexer shutting down", { kind: signal });
      clearInterval(timer);
      void prisma.$disconnect().finally(() => resolve());
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  });

  void config;
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
