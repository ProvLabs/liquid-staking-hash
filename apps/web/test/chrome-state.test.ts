// Chrome-state gates (SECURITY.md "never lie about state",
// app-spec §12.1): a banner renders only from a true program state read this
// request; a failed read degrades its own surface honestly and never
// fabricates. Chain reads come from the @nvhash/fixtures corpus via the MSW
// harness; API envelopes are built with the @nvhash/api-types producers.

import { envelope, type IncidentRow } from "@nvhash/api-types";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import vaultGet from "@nvhash/fixtures/queries/vault/get";

import {
  DEGRADED_LAG_BLOCKS,
  DEGRADED_STALE_SECONDS,
  deriveChromeState,
  loadChromeState,
  type ChromeLiveFacts,
  type ChromeStatusFacts,
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
      http.get("*/vault/v1/vaults/:id", () =>
        HttpResponse.json({ message: "down" }, { status: 503 }),
      ),
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

  it("stale reconciled_at flips degraded even with the height delta frozen (8.1 §2.2)", async () => {
    // A dead indexer freezes both heights; the data's age is the tell.
    const stale = new Date(Date.now() - (DEGRADED_STALE_SECONDS + 60) * 1000);
    server.use(
      http.get("*/api/v1/status", () =>
        HttpResponse.json(
          envelope(
            { reconciled_at: stale.toISOString() },
            { source: "indexed", chainHeight: 1200, indexedHeight: 1199 },
          ),
        ),
      ),
    );
    const state = await loadChromeState(config());
    expect(state.banner).toEqual({ kind: "degraded" });
    expect(state.reconciledAt).toBe(stale.toISOString());
  });

  it("a fresh reconciled_at does not degrade, and cold start stays cold start", async () => {
    server.use(
      http.get("*/api/v1/status", () =>
        HttpResponse.json(
          envelope(
            { reconciled_at: new Date().toISOString() },
            { source: "indexed", chainHeight: 1200, indexedHeight: 1199 },
          ),
        ),
      ),
    );
    expect((await loadChromeState(config())).banner).toBeNull();

    // Cold start is deliberately not degraded.
    server.resetHandlers();
    const cold = await loadChromeState(config());
    expect(cold.banner).toBeNull();
    expect(cold.freshness?.indexed_height).toBeNull();
    expect(cold.reconciledAt).toBeNull();
  });
});

// Generated state matrix: every combination of the loader's inputs is
// asserted; expectations derive from the stated rules, not the
// implementation.
describe("generated chrome matrix (live × status × incidents)", () => {
  const NOW = Date.parse("2026-08-14T12:00:00Z");
  const FRESH = new Date(NOW - 30 * 1000).toISOString();
  const STALE = new Date(NOW - (DEGRADED_STALE_SECONDS + 60) * 1000).toISOString();

  const incidentRow = (kind: IncidentRow["kind"]): IncidentRow => ({
    kind,
    severity: "warning",
    opened_at: "2026-08-14T00:00:00Z",
    closed_at: null,
    height: null,
  });

  const LIVE_STATES = {
    "ok-nominal": { paused: false, pausedReason: "", halted: false },
    "ok-paused": { paused: true, pausedReason: "maintenance", halted: false },
    "ok-halted": { paused: false, pausedReason: "", halted: true },
    failed: null,
  } satisfies Record<string, ChromeLiveFacts | null>;

  const STATUS_STATES = {
    "ok-fresh": {
      meta: { chain_height: 1200, indexed_height: 1199, generated_at: FRESH, source: "indexed" },
      reconciledAt: FRESH,
    },
    "ok-stale": {
      meta: { chain_height: 1200, indexed_height: 1199, generated_at: FRESH, source: "indexed" },
      reconciledAt: STALE,
    },
    "ok-coldstart": {
      meta: { chain_height: null, indexed_height: null, generated_at: FRESH, source: "indexed" },
      reconciledAt: null,
    },
    failed: null,
  } satisfies Record<string, ChromeStatusFacts | null>;

  const INCIDENT_STATES = {
    "none-open": [] as IncidentRow[],
    "divergence-open": [incidentRow("reconciler_divergence")],
    "lag-open": [incidentRow("indexer_lag")],
    failed: null,
  } satisfies Record<string, IncidentRow[] | null>;

  for (const [liveKey, liveState] of Object.entries(LIVE_STATES)) {
    for (const [statusKey, statusState] of Object.entries(STATUS_STATES)) {
      for (const [incKey, incState] of Object.entries(INCIDENT_STATES)) {
        it(`live=${liveKey} status=${statusKey} incidents=${incKey}`, () => {
          const state = deriveChromeState(liveState, statusState, incState, NOW);

          // Expected banner from the stated rules alone.
          const degraded =
            statusKey === "ok-stale" || incKey === "divergence-open" || incKey === "lag-open";
          const expectedBanner =
            liveKey === "ok-halted"
              ? { kind: "halted" }
              : liveKey === "ok-paused"
                ? { kind: "paused", reason: "maintenance" }
                : degraded
                  ? { kind: "degraded" }
                  : null;

          expect(state.banner).toEqual(expectedBanner);
          // A failed live read is never health, and never suppresses the
          // indexed plane's own degraded claim.
          expect(state.liveStatusOk).toBe(liveState !== null);
          // The footer inputs pass through unfabricated.
          expect(state.freshness).toEqual(statusState?.meta ?? null);
          expect(state.reconciledAt).toBe(statusState?.reconciledAt ?? null);
        });
      }
    }
  }

  it("the coldstart pairing (heights without reconciled_at) is unrepresentable from the API", () => {
    // Run heights and reconciled_at come from the same row: heights with a
    // null age is unreachable.
    const cold = STATUS_STATES["ok-coldstart"];
    expect(cold.meta.indexed_height).toBeNull();
    expect(cold.reconciledAt).toBeNull();
  });
});
