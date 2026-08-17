import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { connectSrcFor } from "./scripts/csp";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const lcdTarget = env.VITE_LCD_URL || "http://localhost:1317";

  const proxy = {
    "/lcd": {
      target: lcdTarget,
      changeOrigin: true,
      secure: false,
      rewrite: (p: string) => p.replace(/^\/lcd/, ""),
    },
  };

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
