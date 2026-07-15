// Indexer entrypoint (scaffold, app plan PR 1.1).
//
// The indexer is a set of long-running worker loops (chain-events,
// epoch-history, validator-sampler, market-sampler) each with a durable cursor
// in `indexer_checkpoints` (app-spec §6, §9.2). Those workers, the reconciler,
// and incident derivation land in M2 (PRs 2.1–2.5). This scaffold establishes
// the process shell only.
//
// Boundary invariants (plan §1 ownership table): the indexer serves NO HTTP to
// users, holds NO keys, and signs NOTHING. There is deliberately no server,
// listener, or signer here.

import { loadConfig } from "./config.ts";
import { logger } from "./logger.ts";

export function main(): void {
  const config = loadConfig();
  logger.info("indexer scaffold started", { chainHeight: 0 });
  // Worker loops are wired in M2. Fail loudly if config is unusable rather than
  // starting half-configured.
  void config;
}

// Only run when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
