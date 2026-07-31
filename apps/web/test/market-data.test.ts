// Market-page gates (SECURITY.md "never lie about state",
// app-spec §8.5/§12.1/§13 decision 4): the v1 shell is the honest contract
// state, never a fabricated market; a null premium stays null; every read
// degrades only its own figure. Chain reads come from the fixture corpus via
// MSW; API envelopes from the @nvhash/api-types producers.

import { envelope } from "@nvhash/api-types";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "~/config/config.server";
import { loadMarketData } from "~/market/market.server";
import {
  FIXTURE_CHAIN_ID,
  FIXTURE_CONTRACT_ADDRESS,
  FIXTURE_VAULT_ADDRESS,
} from "~/mocks/handlers";
import { server } from "~/mocks/node";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const GOOD_ENV = {
  APP_ENV: "development",
  CHAIN_ID: FIXTURE_CHAIN_ID,
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: FIXTURE_CONTRACT_ADDRESS,
  VAULT_ADDRESS: FIXTURE_VAULT_ADDRESS,
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: FIXTURE_CHAIN_ID,
  API_URL: "http://api.mock:8787",
} as NodeJS.ProcessEnv;

const config = () => loadConfig(GOOD_ENV);

const POPULATED_SAMPLE = {
  venue: "osmosis",
  pool: "pool1abcdef",
  price: "1020000000", // 1.0200 HASH per nvHASH in nhash base units
  premium_discount_bps: 244,
  depth_bands: [
    // nvHASH base units at exponent 15: 5.00 and 3.00 nvHASH.
    { side: "buy" as const, slippage_bps: 50, amount: "5000000000000000" },
    { side: "sell" as const, slippage_bps: 50, amount: "3000000000000000" },
  ],
  sampled_at: "2026-07-22T12:00:00Z",
};

describe("the v1 shell vs an active market (§13 decision 4)", () => {
  it("the real honest-empty contract renders as the forthcoming state, not unavailable", async () => {
    const data = await loadMarketData(config());
    expect(data.market).not.toBeNull(); // the envelope arrived
    expect(data.market?.sample).toBeNull(); // no market exists: forthcoming
    expect(data.market?.bridged).toEqual([]);
  });

  it("a populated sample renders verbatim from the API (no market math here)", async () => {
    server.use(
      http.get("*/api/v1/market", () =>
        HttpResponse.json(
          envelope(
            { sample: POPULATED_SAMPLE, bridged_supply: [] },
            { source: "indexed", chainHeight: 48089, indexedHeight: 48088 },
          ),
        ),
      ),
    );
    const data = await loadMarketData(config());
    const sample = data.market?.sample;
    expect(sample?.venue).toBe("osmosis");
    expect(sample?.priceHash).toBe("1.0200");
    expect(sample?.premiumPercent).toBe("2.44");
    expect(sample?.sampledAt).toBe("2026-07-22T12:00:00Z");
    expect(sample?.depth).toEqual([
      { side: "buy", slippageBps: 50, sizeNvhash: "5.00" },
      { side: "sell", slippageBps: 50, sizeNvhash: "3.00" },
    ]);
  });

  it("a null premium inside a real sample stays null: n/a, never a fabricated 0", async () => {
    server.use(
      http.get("*/api/v1/market", () =>
        HttpResponse.json(
          envelope(
            { sample: { ...POPULATED_SAMPLE, premium_discount_bps: null }, bridged_supply: [] },
            { source: "indexed" },
          ),
        ),
      ),
    );
    const data = await loadMarketData(config());
    expect(data.market?.sample?.premiumPercent).toBeNull();
  });

  it("bridged supply rows carry chain + sample time", async () => {
    server.use(
      http.get("*/api/v1/market", () =>
        HttpResponse.json(
          envelope(
            {
              sample: null,
              bridged_supply: [
                { chain: "base", supply: "1500000000000000", sampled_at: "2026-07-22T11:00:00Z" },
              ],
            },
            { source: "indexed" },
          ),
        ),
      ),
    );
    const data = await loadMarketData(config());
    expect(data.market?.bridged).toEqual([
      { chain: "base", supplyNvhash: "1.50", sampledAt: "2026-07-22T11:00:00Z" },
    ]);
  });
});

describe("honest degradation (§12.1: each read degrades its own surface)", () => {
  it("an unreachable /market is UNAVAILABLE, distinct from the forthcoming shell", async () => {
    server.use(http.get("*/api/v1/market", () => HttpResponse.json({}, { status: 502 })));
    const data = await loadMarketData(config());
    expect(data.market).toBeNull();
    expect(data.localSupply).not.toBeNull(); // the live figure is untouched
  });

  it("off-shape market payloads degrade to null (fractional price is a shape error)", async () => {
    server.use(
      http.get("*/api/v1/market", () =>
        HttpResponse.json(
          envelope(
            { sample: { ...POPULATED_SAMPLE, price: "1.02" }, bridged_supply: [] },
            { source: "indexed" },
          ),
        ),
      ),
    );
    const data = await loadMarketData(config());
    expect(data.market).toBeNull();
  });

  it("a failed vault read nulls only localSupply", async () => {
    server.use(
      http.get("*/vault/v1/vaults/:id", () =>
        HttpResponse.json({ message: "down" }, { status: 503 }),
      ),
    );
    const data = await loadMarketData(config());
    expect(data.localSupply).toBeNull();
    expect(data.market).not.toBeNull();
  });

  it("a fractional TVV is a shape error at the boundary, never a render crash", async () => {
    // history.tsx BigInts tvv for the table; the schema must reject fractions
    // so a bad row degrades the whole surface instead.
    server.use(
      http.get("*/api/v1/epochs", () =>
        HttpResponse.json(
          envelope(
            [
              {
                epoch_index: 8,
                ended_at: "2026-07-14T00:00:01Z",
                nav: "1.0175",
                tvv: "1.5",
                net_apr_bps: null,
              },
            ],
            { source: "indexed" },
          ),
        ),
      ),
    );
    const data = await loadMarketData(config());
    expect(data.epochs).toBeNull();
  });

  it("pristine local supply comes from the live corpus shares", async () => {
    const data = await loadMarketData(config());
    // 309963777029000000 nvhash base units at exponent 15 → "309.96"
    expect(data.localSupply).toBe("309.96");
    expect(data.epochs?.data).toEqual([]);
  });
});
