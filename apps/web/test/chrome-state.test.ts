// Chrome-state gates (SECURITY.md "never lie about state",
// app-spec §12.1): a banner renders only from a true program state read this
// request; a failed read degrades its own surface honestly and never
// fabricates. Chain reads come from the @nvhash/fixtures corpus via the MSW
// harness; API envelopes are built with the @nvhash/api-types producers.

import { envelope } from "@nvhash/api-types";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import vaultGet from "@nvhash/fixtures/queries/vault/get";

import {
  DEGRADED_LAG_BLOCKS,
  loadChromeState,
} from "~/chrome/chrome.server";
import { describeFreshness, formatAge } from "~/chrome/freshness";
import { loadConfig } from "~/config/config.server";
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

/** The pristine epoch_status fixture with overrides (halted etc.). */
function epochStatusOverride(overrides: Record<string, unknown>) {
  return http.get("*/cosmwasm/wasm/v1/contract/:address/smart/:query", ({ params }) => {
    const decoded = Buffer.from(String(params["query"]), "base64").toString("utf8");
    const key = Object.keys(JSON.parse(decoded) as Record<string, unknown>)[0];
    if (key !== "epoch_status") return undefined; // fall through to defaults
    return HttpResponse.json({
      data: {
        phase: "Idle",
        halted: false,
        last_run_seconds: 1784059201,
        receipt_minted: "0",
        pending_delegations: [],
        pending_redelegations: [],
        ...overrides,
      },
    });
  });
}

/** The pristine vault `get` fixture with vault-record overrides (paused etc.). */
function vaultOverride(overrides: Record<string, unknown>) {
  const fixture = vaultGet as { vault: Record<string, unknown> };
  return http.get("*/vault/v1/vaults/:id", () =>
    HttpResponse.json({ ...fixture, vault: { ...fixture.vault, ...overrides } }),
  );
}

describe("banner honesty (§12.1: a banner mirrors a true state, never an assumption)", () => {
  it("pristine fixtures render no banner and healthy live status", async () => {
    const state = await loadChromeState(config());
    expect(state.banner).toBeNull();
    expect(state.liveStatusOk).toBe(true);
  });

  it("paused vault renders the paused banner with its on-chain reason", async () => {
    server.use(vaultOverride({ paused: true, paused_reason: "scheduled maintenance" }));
    const state = await loadChromeState(config());
    expect(state.banner).toEqual({ kind: "paused", reason: "scheduled maintenance" });
  });

  it("halted contract renders the halted banner", async () => {
    server.use(epochStatusOverride({ halted: true }));
    const state = await loadChromeState(config());
    expect(state.banner).toEqual({ kind: "halted" });
  });

  it("halted outranks paused", async () => {
    server.use(
      vaultOverride({ paused: true, paused_reason: "maintenance" }),
      epochStatusOverride({ halted: true }),
    );
    const state = await loadChromeState(config());
    expect(state.banner).toEqual({ kind: "halted" });
  });

  it("a failed live read is not health: liveStatusOk=false and NO banner", async () => {
    server.use(
      http.get("*/vault/v1/vaults/:id", () => HttpResponse.json({ message: "down" }, { status: 503 })),
    );
    const state = await loadChromeState(config());
    expect(state.liveStatusOk).toBe(false);
    expect(state.banner).toBeNull();
  });

  it("an undecodable live payload degrades identically (bounded at the boundary)", async () => {
    server.use(http.get("*/vault/v1/vaults/:id", () => HttpResponse.json({ nonsense: true })));
    const state = await loadChromeState(config());
    expect(state.liveStatusOk).toBe(false);
    expect(state.banner).toBeNull();
  });
});

describe("freshness honesty (§9.4/§12.1: null heights are n/a, never fabricated)", () => {
  it("the scaffold envelope (null heights) yields n/a", async () => {
    const state = await loadChromeState(config());
    expect(state.freshness).not.toBeNull();
    expect(state.freshness?.chain_height).toBeNull();
    expect(state.freshness?.indexed_height).toBeNull();
    expect(describeFreshness(state.freshness, Date.now())).toEqual({ kind: "na" });
  });

  it("reported heights yield the indexed-to-block rendering", async () => {
    const generatedAt = new Date(Date.now() - 30_000);
    server.use(
      http.get("*/api/v1/status", () =>
        HttpResponse.json(
          envelope({}, { source: "indexed", chainHeight: 1200, indexedHeight: 1197, generatedAt }),
        ),
      ),
    );
    const state = await loadChromeState(config());
    expect(state.banner).toBeNull(); // 3 blocks behind is not degraded
    const display = describeFreshness(state.freshness, Date.now());
    expect(display).toMatchObject({ kind: "indexed", height: 1197 });
    if (display.kind === "indexed") {
      expect(display.ageSeconds).toBeGreaterThanOrEqual(29);
      expect(display.ageSeconds).toBeLessThanOrEqual(35);
      expect(formatAge(display.ageSeconds)).toMatch(/^\d+s$/);
    }
  });

  it("an unreachable API only nulls freshness; it never fabricates a banner", async () => {
    server.use(
      http.get("*/api/v1/status", () => HttpResponse.json({ message: "down" }, { status: 502 })),
      http.get("*/api/v1/incidents", () => HttpResponse.json({ message: "down" }, { status: 502 })),
    );
    const state = await loadChromeState(config());
    expect(state.freshness).toBeNull();
    expect(state.banner).toBeNull();
    expect(state.liveStatusOk).toBe(true);
    expect(describeFreshness(state.freshness, Date.now())).toEqual({ kind: "na" });
  });

  it("an off-shape status envelope degrades to null freshness, not a guess", async () => {
    server.use(
      http.get("*/api/v1/status", () =>
        HttpResponse.json({ data: {}, meta: { chain_height: "not-a-number" } }),
      ),
    );
    const state = await loadChromeState(config());
    expect(state.freshness).toBeNull();
  });
});

describe("degraded banner (§8.0: indexer lagging or reconciler alarm)", () => {
  it("lag beyond the display threshold flips the chrome to degraded", async () => {
    server.use(
      http.get("*/api/v1/status", () =>
        HttpResponse.json(
          envelope(
            {},
            {
              source: "indexed",
              chainHeight: 10_000,
              indexedHeight: 10_000 - DEGRADED_LAG_BLOCKS - 1,
            },
          ),
        ),
      ),
    );
    const state = await loadChromeState(config());
    expect(state.banner).toEqual({ kind: "degraded" });
  });

  it("an open reconciler incident flips the chrome to degraded", async () => {
    server.use(
      http.get("*/api/v1/incidents", () =>
        HttpResponse.json(
          envelope(
            [
              {
                kind: "reconciler_divergence",
                severity: "critical",
                opened_at: "2026-07-20T00:00:00Z",
                closed_at: null,
                height: 7811,
              },
            ],
            { source: "indexed" },
          ),
        ),
      ),
    );
    const state = await loadChromeState(config());
    expect(state.banner).toEqual({ kind: "degraded" });
  });

  it("a closed incident does not degrade", async () => {
    server.use(
      http.get("*/api/v1/incidents", () =>
        HttpResponse.json(
          envelope(
            [
              {
                kind: "indexer_lag",
                severity: "warning",
                opened_at: "2026-07-19T00:00:00Z",
                closed_at: "2026-07-20T00:00:00Z",
                height: null,
              },
            ],
            { source: "indexed" },
          ),
        ),
      ),
    );
    const state = await loadChromeState(config());
    expect(state.banner).toBeNull();
  });

  it("an open incident of an unrelated kind does not degrade", async () => {
    server.use(
      http.get("*/api/v1/incidents", () =>
        HttpResponse.json(
          envelope(
            [
              {
                kind: "jail_report",
                severity: "warning",
                opened_at: "2026-07-20T00:00:00Z",
                closed_at: null,
                height: null,
              },
            ],
            { source: "indexed" },
          ),
        ),
      ),
    );
    const state = await loadChromeState(config());
    expect(state.banner).toBeNull();
  });

  it("an off-shape incidents payload drops the input rather than guessing", async () => {
    server.use(
      http.get("*/api/v1/incidents", () =>
        HttpResponse.json(envelope([{ nokind: true }], { source: "indexed" })),
      ),
    );
    const state = await loadChromeState(config());
    expect(state.banner).toBeNull();
  });

  it("paused outranks degraded", async () => {
    server.use(
      vaultOverride({ paused: true, paused_reason: "maintenance" }),
      http.get("*/api/v1/incidents", () =>
        HttpResponse.json(
          envelope(
            [
              {
                kind: "indexer_lag",
                severity: "warning",
                opened_at: "2026-07-20T00:00:00Z",
                closed_at: null,
                height: null,
              },
            ],
            { source: "indexed" },
          ),
        ),
      ),
    );
    const state = await loadChromeState(config());
    expect(state.banner).toEqual({ kind: "paused", reason: "maintenance" });
  });
});
