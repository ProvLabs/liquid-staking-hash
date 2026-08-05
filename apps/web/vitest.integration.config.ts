import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration-suite config: ONLY the database-backed `app`-schema gate — the
// real Prisma stores as `app_writer`, mirroring services/api's `test:db`.
//
// It exists because the unit suites drive the IN-MEMORY stand-ins, so the
// Prisma implementations of both `app` tables shipped with no automated
// coverage at all: the `ON CONFLICT DO UPDATE` funnel increment and the
// conditional acknowledgment reversal are both CONCURRENCY remedies (plan
// §4b C3) whose whole point is behaviour the in-memory store cannot exhibit,
// and the unique-violation → `AckConflict` mapping is a Postgres error code
// this process never sees otherwise.
//
// Kept separate from the default config so the unit gate stays Postgres-free.
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    // Real round trips plus a deliberate concurrency burst; give it room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
