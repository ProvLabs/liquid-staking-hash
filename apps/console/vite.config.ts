import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { connectSrcFor } from "./scripts/csp";

// One build per deployment profile (spec §7): `--mode devnet|test|production`.
// Config values are read from `.env.<mode>` as VITE_* and typed in src/config.ts.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const lcdTarget = env.VITE_LCD_URL || "http://localhost:1317";

  // Dev/preview proxy: the browser calls same-origin `/lcd/*`; Vite forwards to the node.
  // This sidesteps the node's missing CORS headers in local dev (spec §14.2). In a real
  // deployment the program-operated node must itself send CORS for the console origin.
  const proxy = {
    "/lcd": {
      target: lcdTarget,
      changeOrigin: true,
      secure: false,
      rewrite: (p: string) => p.replace(/^\/lcd/, ""),
    },
  };

  // CSP `connect-src` is GENERATED from the profile at serve and build time
  // (PR 8.4b §2.5): index.html carries a token, never a hand-edited host
  // list, and `connectSrcFor` throws on anything wider than one exact origin
  // — the build fails closed. Gated by test/csp.test.ts.
  const cspConnectSrc = connectSrcFor(mode, lcdTarget);
  const cspPlugin = {
    name: "nvhash-csp-connect-src",
    transformIndexHtml: {
      order: "pre" as const,
      handler(html: string) {
        if (!html.includes("__CSP_CONNECT_SRC__")) {
          throw new Error(
            "index.html lost its __CSP_CONNECT_SRC__ token — the CSP must be generated",
          );
        }
        return html.replaceAll("__CSP_CONNECT_SRC__", cspConnectSrc);
      },
    },
  };

  // Pre-certification caveat fact, BAKED at build (plan 8.4 §2.7.2): the
  // fixture-corpus manifest status — the same artifact the App reads at
  // runtime. The console sits outside the pnpm workspace, so the file is read
  // by path; a missing manifest fails the build (never a silent "certified").
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../packages/fixtures/fixtures/manifest.json", import.meta.url)),
      "utf8",
    ),
  ) as { status?: string };
  const corpusCertified = !String(manifest.status ?? "PROVISIONAL").startsWith("PROVISIONAL");

  return {
    plugins: [react(), cspPlugin],
    define: {
      __CORPUS_CERTIFIED__: JSON.stringify(corpusCertified),
    },
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: { port: 5273, proxy },
    preview: { port: 5273, proxy },
    build: { target: "es2022", sourcemap: true },
  };
});
