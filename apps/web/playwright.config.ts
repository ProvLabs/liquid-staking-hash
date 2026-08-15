import { defineConfig, devices } from "@playwright/test";

import { manifest } from "./e2e/fixture-manifest";
import { roleSigner } from "./e2e/support/login";

// Offline e2e: the production build served with NVHASH_MOCK=1 —
// chain reads come from the @nvhash/fixtures corpus via MSW, no devnet needed.
// Runs in the official Playwright image on the ADR-002 compose file
// (`./dev pw …`); the @playwright/test pin and the image tag move together.
const PORT = 43117;

// A second server instance with NVHASH_MOCK_LIVE_DOWN=1: the chrome's two
// live reads fail while the boot check still passes, so the suite can assert
// the honest degradation ("program status unavailable", no banner) end to
// end.
const LIVE_DOWN_PORT = 43118;
export const LIVE_DOWN_ORIGIN = `http://127.0.0.1:${LIVE_DOWN_PORT}`;

// A third instance with NVHASH_MOCK_GRANT_ROLES set (8.3): the role-bearing
// axe/states cells run HERE, so the primary server's chain state stays
// byte-identical to the corpus (the ungoverned plain-account truth every
// standing governance spec asserts) — the grant is opt-in per origin, never
// ambient.
const GRANT_PORT = 43119;
export const GRANT_ORIGIN = `http://127.0.0.1:${GRANT_PORT}`;

// LCD_URL/API_URL are deliberately sentinel origins: MSW matches handlers by
// path on any origin, and e2e/leaks.spec.ts asserts the sentinels never reach
// the rendered page (server-only config stays server-side).
export const E2E_SERVER_ONLY_LCD = "http://server-only-lcd.sentinel.invalid";
export const E2E_SERVER_ONLY_API = "http://server-only-api.sentinel.invalid";

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
  webServer: [
    {
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
        API_URL: E2E_SERVER_ONLY_API,
      },
    },
    {
      command: "corepack pnpm exec react-router-serve ./build/server/index.js",
      port: LIVE_DOWN_PORT,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(LIVE_DOWN_PORT),
        NVHASH_MOCK: "1",
        NVHASH_MOCK_LIVE_DOWN: "1",
        APP_ENV: "development",
        CHAIN_ID: manifest.chain_id,
        LCD_URL: E2E_SERVER_ONLY_LCD,
        CONTRACT_ADDRESS: manifest.contract,
        VAULT_ADDRESS: manifest.vault,
        CONSOLE_URL: "https://console.invalid",
        CONSOLE_CHAIN_ID: manifest.chain_id,
        API_URL: E2E_SERVER_ONLY_API,
      },
    },
    {
      command: "corepack pnpm exec react-router-serve ./build/server/index.js",
      port: GRANT_PORT,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(GRANT_PORT),
        NVHASH_MOCK: "1",
        // The 8.3 role grant (toolingOnly): the pinned role signer's address,
        // so THIS instance's mocked chain reports it as operator + group
        // member behind a governed admin, and the axe matrix's role cells
        // reach /validators/mine, /admin and /governance/new through the
        // app's REAL role reads (`detectRoles`, `verifyAdminUncached`).
        NVHASH_MOCK_GRANT_ROLES: roleSigner().address,
        APP_ENV: "development",
        CHAIN_ID: manifest.chain_id,
        LCD_URL: E2E_SERVER_ONLY_LCD,
        CONTRACT_ADDRESS: manifest.contract,
        VAULT_ADDRESS: manifest.vault,
        CONSOLE_URL: "https://console.invalid",
        CONSOLE_CHAIN_ID: manifest.chain_id,
        API_URL: E2E_SERVER_ONLY_API,
      },
    },
  ],
});
