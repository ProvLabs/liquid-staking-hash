import { defineConfig } from "vitest/config";

// Default unit-suite config. It EXCLUDES test/integration/** so that
// `pnpm -r run test` (the workspace app-ci gate) stays database-free — the
// contract harness runs on the injected in-memory reader, exactly as
// services/api/CLAUDE.md promises. The database-backed reader gate runs under
// vitest.integration.config.ts via `test:db`, in the dedicated app-ci
// `db-grants` job with a Postgres service (the indexer's config-split
// precedent).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**"],
    environment: "node",
  },
});
