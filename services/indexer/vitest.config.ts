import { defineConfig } from "vitest/config";

// Default unit-suite config. It EXCLUDES test/integration/** so that
// `pnpm -r run test` (the workspace app-ci gate) stays database-free — the
// indexer's unit + security-executable gates run with no Postgres, exactly as
// services/indexer/CLAUDE.md promises. The database-backed grant-boundary
// integration test runs under vitest.integration.config.ts via `test:grants`,
// in the dedicated app-ci `db-grants` job with a Postgres service.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**"],
    environment: "node",
  },
});
