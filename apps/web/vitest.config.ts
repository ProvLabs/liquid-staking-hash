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
    environment: "node",
  },
});
