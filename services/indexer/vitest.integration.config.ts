import { defineConfig } from "vitest/config";

// Integration-suite config: ONLY the database-backed grant-boundary test
// (ADR-001 Decision 1). Kept separate from the default config so the unit
// gate stays Postgres-free; run via `test:grants` in the app-ci `db-grants`
// job (and locally by infra/devnet/stack.sh verify) against a live Postgres.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    // A cross-role Postgres round-trip is slower than a unit test; give it room.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
