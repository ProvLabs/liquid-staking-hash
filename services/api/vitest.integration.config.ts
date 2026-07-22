import { defineConfig } from "vitest/config";

// Integration-suite config: ONLY the database-backed reader gate (PR 3.1) —
// real Prisma queries as the SELECT-only `api_reader` role against rows
// seeded as `indexer_writer`. Kept separate from the default config so the
// unit gate stays Postgres-free; run via `test:db` in the app-ci `db-grants`
// job after roles.sql + migrate (the indexer's test:grants precedent).
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    // A cross-role Postgres round-trip is slower than a unit test; give it room.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
