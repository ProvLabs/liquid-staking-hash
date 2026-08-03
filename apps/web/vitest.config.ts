import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone vitest config (the react-router vite plugin is build-only and
// must not load for unit tests). Unit suites are node-environment: config,
// boot checks (via MSW), i18n coverage, theme parsing.
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // EXCLUDED so `pnpm -r run test` stays database-free: the `app`-schema
    // store gate needs a migrated Postgres and runs under
    // vitest.integration.config.ts via `test:db`, the services/api precedent.
    exclude: ["test/integration/**"],
    environment: "node",
  },
});
