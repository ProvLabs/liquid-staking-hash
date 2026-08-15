// Vitest harness (PR 8.4b commit A). Deliberately OUTSIDE tsc -b's build
// graph (tsconfig includes only src/ + vite.config.ts): vitest transpiles
// tests itself. Node environment only — the console's gating tests are pure
// (grammar, state machines, encoders, generated HTML); no DOM library joins
// devDependencies (invariant 9: vitest is the only addition).
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
