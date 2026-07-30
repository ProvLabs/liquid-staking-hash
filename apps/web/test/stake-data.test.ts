// Stake-context loader gate (app-spec §8.3, §12.1 never-lie):
// the live-read context degrades each figure independently and never throws.
// Chain reads come from the fixture corpus via MSW; overrides drive the
// paused / anonymous / unavailable branches (the roles-test pattern).

import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import vaultGet from "@nvhash/fixtures/queries/vault/get";

import { loadConfig } from "~/config/config.server";
import { loadStakeContext } from "~/stake/stake.server";
import { FIXTURE_CHAIN_ID, FIXTURE_CONTRACT_ADDRESS, FIXTURE_VAULT_ADDRESS } from "~/mocks/handlers";
import { server } from "~/mocks/node";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const config = loadConfig({
  APP_ENV: "development",
  CHAIN_ID: FIXTURE_CHAIN_ID,
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: FIXTURE_CONTRACT_ADDRESS,
  VAULT_ADDRESS: FIXTURE_VAULT_ADDRESS,
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: FIXTURE_CHAIN_ID,
  API_URL: "http://api.mock:8787",
} as NodeJS.ProcessEnv);

const ADDRESS = "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0";

describe("loadStakeContext", () => {
  it("assembles NAV inputs, swap gates, and next-epoch date from live reads", async () => {
    const context = await loadStakeContext(config, null);
    expect(context.vault).not.toBeNull();
    expect(context.vault!.swapInEnabled).toBe(true);
    expect(context.vault!.paused).toBe(false);
    expect(BigInt(context.vault!.totalShares)).toBeGreaterThan(0n);
    expect(BigInt(context.vault!.totalValueNhash)).toBeGreaterThanOrEqual(0n);
    // epoch_status fixture drives a real next-epoch ISO date.
    expect(context.nextEpochIso).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  });

  it("loads the connected address's spendable HASH", async () => {
    server.use(
      http.get("*/cosmos/bank/v1beta1/spendable_balances/:address", () =>
        HttpResponse.json({
          balances: [{ denom: "nhash", amount: "7500000000" }],
          pagination: { next_key: null, total: "1" },
        }),
      ),
    );
    const context = await loadStakeContext(config, ADDRESS);
    expect(context.spendableHash).toBe("7500000000");
  });

  it("surfaces the paused state with its reason", async () => {
    const fixture = vaultGet as { vault: Record<string, unknown> };
    server.use(
      http.get("*/vault/v1/vaults/:id", () =>
        HttpResponse.json({
          ...fixture,
          vault: { ...fixture.vault, paused: true, paused_reason: "maintenance window" },
        }),
      ),
    );
    const context = await loadStakeContext(config, null);
    expect(context.vault!.paused).toBe(true);
    expect(context.vault!.pausedReason).toBe("maintenance window");
  });

  it("degrades to vault:null when the vault read fails (never fabricates)", async () => {
    server.use(
      http.get("*/vault/v1/vaults/:id", () =>
        HttpResponse.json({ code: 2, message: "down", details: [] }, { status: 503 }),
      ),
    );
    const context = await loadStakeContext(config, null);
    expect(context.vault).toBeNull();
    // Other reads still resolve independently.
    expect(context.nextEpochIso).not.toBeNull();
  });

  it("anonymous requests carry no balance", async () => {
    const context = await loadStakeContext(config, null);
    expect(context.spendableHash).toBeNull();
  });
});
