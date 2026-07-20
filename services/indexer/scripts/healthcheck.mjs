// Container healthcheck for the indexer service (app plan PR 1.5).
//
// The indexer serves no HTTP by design (plan §1 ownership table), so liveness
// is not an endpoint. Instead the supervisor (src/index.ts) writes a heartbeat
// file after each successful database ping; this probe passes only if that file
// is fresh — i.e. the process is alive AND its database connection is healthy.
// A stale/missing heartbeat exits non-zero, flipping the container unhealthy.
//
// Plain .mjs (not TS): it runs as the raw healthcheck command with no build.

import { statSync } from "node:fs";

const file = process.env.INDEXER_HEARTBEAT_FILE ?? "/tmp/indexer.heartbeat";
// Two missed 15s ping intervals is the staleness ceiling.
const MAX_AGE_MS = 45_000;

try {
  const ageMs = Date.now() - statSync(file).mtimeMs;
  if (ageMs > MAX_AGE_MS) {
    process.stderr.write(`indexer heartbeat stale (${Math.round(ageMs / 1000)}s)\n`);
    process.exit(1);
  }
  process.exit(0);
} catch {
  process.stderr.write("indexer heartbeat missing\n");
  process.exit(1);
}
