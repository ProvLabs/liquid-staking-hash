import { defineConfig, devices } from "@playwright/test";

import { manifest } from "./e2e/fixture-manifest";

// Offline e2e (plan §4): the production build served with NVHASH_MOCK=1 —
// chain reads come from the @nvhash/fixtures corpus via MSW, no devnet needed.
// Runs in the official Playwright image on the ADR-002 compose file
// (`./dev pw …`); the @playwright/test pin and the image tag move together.
const PORT = 43117;

// LCD_URL is deliberately a sentinel origin: MSW matches handlers by path on
// any origin, and e2e/leaks.spec.ts asserts the sentinel never reaches the
// rendered page (server-only config stays server-side).
export const E2E_SERVER_ONLY_LCD = "http://server-only-lcd.sentinel.invalid";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "corepack pnpm exec react-router-serve ./build/server/index.js",
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      NVHASH_MOCK: "1",
      APP_ENV: "development",
      CHAIN_ID: manifest.chain_id,
      LCD_URL: E2E_SERVER_ONLY_LCD,
      CONTRACT_ADDRESS: manifest.contract,
      VAULT_ADDRESS: manifest.vault,
      CONSOLE_URL: "https://console.invalid",
      CONSOLE_CHAIN_ID: manifest.chain_id,
    },
  },
});
