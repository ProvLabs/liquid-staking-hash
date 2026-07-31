// Learn-data gates (SECURITY.md "never lie about state",
// app-spec §12.1): every figure degrades independently to null on a failed
// or off-shape read, never a crash, a guess, or a stale substitute. Chain
// reads come from the fixture corpus via MSW; API envelopes are built with
// the @nvhash/api-types producers.

import { envelope } from "@nvhash/api-types";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "~/config/config.server";
import { loadLearnData, MIN_APR_EPOCHS } from "~/learn/learn.server";
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

/** Override one contract smart query by its top-level key. */
function smartQueryOverride(targetKey: string, body: Record<string, unknown>) {
  return http.get("*/cosmwasm/wasm/v1/contract/:address/smart/:query", ({ params }) => {
    const decoded = Buffer.from(String(params["query"]), "base64").toString("utf8");
    const key = Object.keys(JSON.parse(decoded) as Record<string, unknown>)[0];
    if (key !== targetKey) return undefined; // fall through to defaults
    return HttpResponse.json(body);
  });
}

const FIXTURE_APR = {
  epoch_index: 8,
  window_seconds: 13724,
  tvv_before: "315350573874",
  rewards_claimed: "66483236",
  commission_received: "0",
  tips_received: "0",
  aum_fee_estimate: "0",
  write_down: "0",
  gross_apr_bps: 4844,
  net_apr_bps: 4844,
};

const EPOCH_ROW = {
  epoch_index: 8,
  ended_at: "2026-07-14T00:00:01Z",
  nav: "1.0175",
  tvv: "315397882283",
  net_apr_bps: 4844,
};

describe("live figures (fixture corpus)", () => {
  it("pristine fixtures populate every live figure with the golden values", async () => {
    const data = await loadLearnData(config());
    expect(data.live.nav).toBe("1.0175");
    expect(data.live.tvl).toBe("315.39");
    expect(data.live.netAprPercent).toBe("48.44");
    expect(data.live.grossAprPercent).toBe("48.44");
    expect(data.live.aprWindowSeconds).toBe(13724);
    expect(data.live.aprInsufficientHistory).toBe(false);
    expect(data.live.yieldSources).toEqual({
      rewards: "0.06",
      commission: "0.00",
      tips: "0.00",
      aumFee: "0.00",
    });
    expect(data.live.eligibleValidators).toBe(1);
  });

  it("a failed vault read nulls NAV/TVL and ONLY them (figures degrade independently)", async () => {
    server.use(
      http.get("*/vault/v1/vaults/:id", () =>
        HttpResponse.json({ message: "down" }, { status: 503 }),
      ),
    );
    const data = await loadLearnData(config());
    expect(data.live.nav).toBeNull();
    expect(data.live.tvl).toBeNull();
    expect(data.live.netAprPercent).toBe("48.44"); // the APR read is its own surface
    expect(data.metrics).not.toBeNull();
  });

  it("a null on-chain APR renders as absent, not as insufficient history", async () => {
    server.use(smartQueryOverride("apr", { data: null }));
    const data = await loadLearnData(config());
    expect(data.live.netAprPercent).toBeNull();
    expect(data.live.aprInsufficientHistory).toBe(false);
    expect(data.live.yieldSources).toBeNull();
  });

  it("APR below the minimum window is flagged, never annualized (§8.1 rule)", async () => {
    server.use(
      smartQueryOverride("apr", { data: { ...FIXTURE_APR, epoch_index: MIN_APR_EPOCHS - 1 } }),
    );
    const data = await loadLearnData(config());
    expect(data.live.netAprPercent).toBeNull();
    expect(data.live.grossAprPercent).toBeNull();
    expect(data.live.aprInsufficientHistory).toBe(true);
    // The decomposition is still real chain data and still shows.
    expect(data.live.yieldSources).not.toBeNull();
  });
});

describe("indexed figures (envelopes, §9.4/§12.1)", () => {
  it("pristine scaffold envelopes arrive with honest nulls and empty lists", async () => {
    const data = await loadLearnData(config());
    expect(data.metrics?.data).toEqual({
      participant_count: null,
      program_started_at: null,
      epoch_count: null,
    });
    expect(data.metrics?.meta.indexed_height).toBeNull();
    expect(data.epochs?.data).toEqual([]);
    expect(data.incidents?.data).toEqual([]);
  });

  it("populated envelopes parse through with their freshness meta", async () => {
    server.use(
      http.get("*/api/v1/metrics", () =>
        HttpResponse.json(
          envelope(
            { participant_count: 128, program_started_at: "2026-03-01T00:00:00Z", epoch_count: 8 },
            { source: "indexed", chainHeight: 7811, indexedHeight: 7811 },
          ),
        ),
      ),
      http.get("*/api/v1/epochs", () =>
        HttpResponse.json(
          envelope([EPOCH_ROW], { source: "indexed", chainHeight: 7811, indexedHeight: 7811 }),
        ),
      ),
    );
    const data = await loadLearnData(config());
    expect(data.metrics?.data.participant_count).toBe(128);
    expect(data.metrics?.meta.indexed_height).toBe(7811);
    expect(data.epochs?.data).toEqual([EPOCH_ROW]);
  });

  it("an unreachable API nulls the indexed figures and only them", async () => {
    server.use(
      http.get("*/api/v1/metrics", () => HttpResponse.json({}, { status: 502 })),
      http.get("*/api/v1/epochs", () => HttpResponse.json({}, { status: 502 })),
      http.get("*/api/v1/incidents", () => HttpResponse.json({}, { status: 502 })),
    );
    const data = await loadLearnData(config());
    expect(data.metrics).toBeNull();
    expect(data.epochs).toBeNull();
    expect(data.incidents).toBeNull();
    expect(data.live.nav).toBe("1.0175"); // the live plane is untouched
  });

  it("off-shape payloads degrade to null, never a guess (bounded at the boundary)", async () => {
    server.use(
      http.get("*/api/v1/metrics", () =>
        HttpResponse.json(envelope({ participant_count: "many" }, { source: "indexed" })),
      ),
      http.get("*/api/v1/epochs", () =>
        HttpResponse.json(
          envelope([{ epoch_index: 8, nav: "not-a-decimal" }], { source: "indexed" }),
        ),
      ),
    );
    const data = await loadLearnData(config());
    expect(data.metrics).toBeNull();
    expect(data.epochs).toBeNull();
  });

  it("collections beyond the page cap are rejected as off-shape (no unbounded input)", async () => {
    server.use(
      http.get("*/api/v1/epochs", () =>
        HttpResponse.json(
          envelope(
            Array.from({ length: 201 }, (_, i) => ({ ...EPOCH_ROW, epoch_index: i })),
            { source: "indexed" },
          ),
        ),
      ),
    );
    const data = await loadLearnData(config());
    expect(data.epochs).toBeNull();
  });
});
