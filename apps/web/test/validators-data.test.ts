// Validators-page gates (plan 4.3 §3, SECURITY.md "never lie about state",
// app-spec §8.6/§12.1): the set read degrades honestly, per-field joins
// degrade only their field, and the client-crossing row is the CLOSED public
// projection (no operator economics, ever). Chain reads come from the fixture
// corpus via MSW; API envelopes from the @nvhash/api-types producers.

import { envelope } from "@nvhash/api-types";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "~/config/config.server";
import {
  FIXTURE_CHAIN_ID,
  FIXTURE_CONTRACT_ADDRESS,
  FIXTURE_VAULT_ADDRESS,
} from "~/mocks/handlers";
import { server } from "~/mocks/node";
import { loadValidatorsData } from "~/validators/validators.server";

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

// The one enrolled validator in the fixture corpus (contract/validators.json
// joined with staking/validators.json and staking/delegations.json).
const FIXTURE_VALOPER = "tpvaloper1l39wu7cht0zcycc5rkcd90sdd4ksjmxwjqvnjp";

/** Override one contract smart query by its top-level key. */
function smartQueryOverride(targetKey: string, body: Record<string, unknown>) {
  return http.get("*/cosmwasm/wasm/v1/contract/:address/smart/:query", ({ params }) => {
    const decoded = Buffer.from(String(params["query"]), "base64").toString("utf8");
    const key = Object.keys(JSON.parse(decoded) as Record<string, unknown>)[0];
    if (key !== targetKey) return undefined; // fall through to defaults
    return HttpResponse.json(body);
  });
}

describe("public rows (fixture golden values)", () => {
  it("joins the corpus set: moniker, status, uptime vs threshold, delegation, tenure", async () => {
    const data = await loadValidatorsData(config());
    expect(data.rows).toHaveLength(1);
    const row = data.rows![0]!;
    expect(row.valoper).toBe(FIXTURE_VALOPER);
    expect(row.moniker).toBe("testing");
    expect(row.eligible).toBe(true);
    expect(row.jailed).toBe(false);
    expect(row.tombstoned).toBe(false);
    expect(row.uptimePercent).toBe("100.00"); // 10000 bps
    expect(row.thresholdPercent).toBe("0.00"); // fixture performance_threshold_bps
    expect(row.programDelegation).toBe("315.35"); // 315350396951 nhash
    expect(row.enrolledAt).toBe(new Date(1784045040 * 1000).toISOString());
    expect(data.eligibleCount).toBe(1);
  });

  it("the row is the CLOSED public projection: no operator economics ever crosses", async () => {
    const data = await loadValidatorsData(config());
    const keys = Object.keys(data.rows![0]!).sort();
    expect(keys).toEqual([
      "eligible",
      "enrolledAt",
      "jailed",
      "moniker",
      "programDelegation",
      "thresholdPercent",
      "tombstoned",
      "uptimePercent",
      "valoper",
    ]);
    const serialized = JSON.stringify(data);
    for (const forbidden of ["commission", "tip", "headroom", "arrears", "Arrears"]) {
      expect(serialized, `must not leak "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

describe("honest degradation (§12.1: each read degrades its own surface)", () => {
  it("a failed contract validators read nulls rows; the page says unavailable", async () => {
    server.use(smartQueryOverride("validators", { data: null }));
    // A null payload fails the decoder, which is a failed read, not a set.
    const data = await loadValidatorsData(config());
    expect(data.rows).toBeNull();
  });

  it("a failed config read also nulls rows (no threshold, no ranking claim)", async () => {
    server.use(
      http.get("*/cosmwasm/wasm/v1/contract/:address/smart/:query", ({ params }) => {
        const decoded = Buffer.from(String(params["query"]), "base64").toString("utf8");
        const key = Object.keys(JSON.parse(decoded) as Record<string, unknown>)[0];
        if (key !== "config") return undefined;
        return HttpResponse.json({ message: "down" }, { status: 503 });
      }),
    );
    const data = await loadValidatorsData(config());
    expect(data.rows).toBeNull();
  });

  it("a failed staking read degrades only moniker/delegation, never the row", async () => {
    server.use(
      http.get("*/cosmos/staking/v1beta1/validators", () =>
        HttpResponse.json({ message: "down" }, { status: 503 }),
      ),
      http.get("*/cosmos/staking/v1beta1/delegations/:delegator", () =>
        HttpResponse.json({ message: "down" }, { status: 503 }),
      ),
    );
    const data = await loadValidatorsData(config());
    expect(data.rows).toHaveLength(1);
    const row = data.rows![0]!;
    expect(row.moniker).toBeNull();
    expect(row.programDelegation).toBeNull();
    expect(row.uptimePercent).toBe("100.00"); // contract-sourced fields intact
  });

  it("uptimeBps null (no capture yet) renders as null, never a number", async () => {
    server.use(
      smartQueryOverride("validators", {
        data: {
          validators: [
            {
              valoper: FIXTURE_VALOPER,
              operator: "tp1l39wu7cht0zcycc5rkcd90sdd4ksjmxwdf388y",
              enrolled_at_seconds: 1784045040,
              uptime_capture_count: 0,
              uptime_bps: null,
              jailed: false,
              tombstoned: false,
              tip_epoch: "0",
              commission_accrued: "0",
              commission_paid: "0",
              commission_due: "0",
              in_arrears: false,
              eligible: true,
              headroom: "0",
            },
          ],
        },
      }),
    );
    const data = await loadValidatorsData(config());
    expect(data.rows![0]!.uptimePercent).toBeNull();
  });

  it("an unreachable API nulls only setHealth (distinct from empty)", async () => {
    server.use(
      http.get("*/api/v1/validators", () => HttpResponse.json({}, { status: 502 })),
    );
    const data = await loadValidatorsData(config());
    expect(data.setHealth).toBeNull();
    expect(data.rows).toHaveLength(1);
  });

  it("pristine scaffold yields zeroed set health with null heights", async () => {
    const data = await loadValidatorsData(config());
    expect(data.setHealth?.data).toEqual({ total: 0, active: 0, eligible: 0 });
    expect(data.setHealth?.meta.indexed_height).toBeNull();
  });

  it("populated payloads project ONLY the public aggregates; off-shape degrades to null", async () => {
    const payload = {
      validators: [
        {
          valoper: FIXTURE_VALOPER,
          moniker: "testing",
          active: true,
          epoch_index: 8,
          uptime_bps: 10000,
          eligible: true,
          failing_reasons: [],
          program_delegation: "315350396951",
          commission_due: "44045121",
        },
      ],
      set_health: { total: 3, active: 2, eligible: 1, in_arrears: 1 },
    };
    server.use(
      http.get("*/api/v1/validators", () =>
        HttpResponse.json(envelope(payload, { source: "indexed", indexedHeight: 7811 })),
      ),
    );
    const populated = await loadValidatorsData(config());
    // in_arrears and the API's per-validator rows must NOT cross (§8.6 split;
    // the closed-projection gate above also forbids the substrings).
    expect(populated.setHealth?.data).toEqual({ total: 3, active: 2, eligible: 1 });
    expect(populated.setHealth?.meta.indexed_height).toBe(7811);

    server.use(
      http.get("*/api/v1/validators", () =>
        HttpResponse.json(envelope({ validators: [{}] }, { source: "indexed" })),
      ),
    );
    const offShape = await loadValidatorsData(config());
    expect(offShape.setHealth).toBeNull();
  });
});
