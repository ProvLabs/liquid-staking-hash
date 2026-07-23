// e2e-live Playwright project (plan 5.2 §2.4; master plan §4 "e2e (live)"):
// runs against the REAL devnet stack (`infra/devnet/stack.sh up`, app
// profile) — no MSW, no webServer here; the stack owns the processes.
// Specs skip cleanly when E2E_LIVE_SIGNER_KEY is absent, so this config is
// safe to invoke anywhere; it only bites on a prepared stack.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-live",
  fullyParallel: false, // one devnet account: sequence numbers are serial
  retries: 0, // a live flake is a finding, not a retry
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_LIVE_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
});
