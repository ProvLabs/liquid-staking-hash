import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

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

  return {
    plugins: [react()],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: { port: 5273, proxy },
    preview: { port: 5273, proxy },
    build: { target: "es2022", sourcemap: true },
  };
});
