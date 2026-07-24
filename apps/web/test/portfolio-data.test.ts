// Portfolio loader degradation matrix (M6.1 §2.6; SECURITY.md "never lie about
// state", app-spec §12.1): live plane down falls back to the indexed plane
// with an honest plane label; the API down (or no minting key) leaves a
// live-only summary with personalReadsAvailable false; has_transfers /
// inconsistent flow through as flags; an empty history yields zeros without
// fabrication; pagination maps page → offset; explorer links honor config.
// Chain reads come from the fixture corpus via MSW; API envelopes from the
// @nvhash/api-types producers.

import { envelope } from "@nvhash/api-types";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "~/config/config.server";
import { loadPortfolioData } from "~/portfolio/portfolio.server";
import {
  FIXTURE_CHAIN_ID,
  FIXTURE_CONTRACT_ADDRESS,
  FIXTURE_VAULT_ADDRESS,
} from "~/mocks/handlers";
import { server } from "~/mocks/node";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const KEY = "portfolio-test-assertion-key-0123456789";
const BASE_ENV = {
  APP_ENV: "development",
  CHAIN_ID: FIXTURE_CHAIN_ID,
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: FIXTURE_CONTRACT_ADDRESS,
  VAULT_ADDRESS: FIXTURE_VAULT_ADDRESS,
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: FIXTURE_CHAIN_ID,
  API_URL: "http://api.mock:8787",
} as NodeJS.ProcessEnv;

const withKey = () => loadConfig({ ...BASE_ENV, API_SERVICE_ASSERTION_KEY: KEY });
const withoutKey = () => loadConfig(BASE_ENV);
const withExplorer = () =>
  loadConfig({ ...BASE_ENV, API_SERVICE_ASSERTION_KEY: KEY, EXPLORER_URL: "https://explorer.test/" });

const SESSION = { address: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad" };

const HASH = 10n ** 9n;
const SHARE = 10n ** 15n;

/** A populated metrics payload (defaults are honest-empty). */
function metrics(overrides: Record<string, unknown> = {}) {
  return {
    address: SESSION.address,
    history_state: "complete" as const,
    indexed_share_balance: "0",
    escrowed_share_balance: "0",
    cost_basis_nhash: "0",
    escrowed_basis_nhash: "0",
    realized_gain_nhash: "0",
    effective_apr_bps: null,
    yield_by_epoch: [],
    accrual: [],
    accrual_truncated: false,
    accrual_markers: [],
    markers_truncated: false,
    ...overrides,
  };
}

function balanceOverride(amount: string) {
  return http.get("*/cosmos/bank/v1beta1/balances/:address/by_denom", ({ request }) =>
    HttpResponse.json({
      balance: { denom: new URL(request.url).searchParams.get("denom") ?? "nhash", amount },
    }),
  );
}

const vaultDown = () =>
  http.get("*/vault/v1/vaults/:id", () => HttpResponse.json({ message: "down" }, { status: 503 }));

describe("plane composition and fallback", () => {
  it("live plane down falls back to the indexed plane with the plane label", async () => {
    server.use(
      vaultDown(),
      http.get("*/api/v1/portfolio/metrics", () =>
        HttpResponse.json(
          envelope(metrics({ indexed_share_balance: (7n * SHARE).toString(), accrual: [
            { time: "2026-07-20T00:00:00Z", height: 100, value_nhash: (42n * HASH).toString() },
          ] }), { source: "indexed" }),
        ),
      ),
    );
    const data = await loadPortfolioData(withKey(), SESSION, 0);
    expect(data.summary.valuePlane).toBe("indexed");
    expect(data.summary.currentValueHash).toBe("42.0000");
    expect(data.summary.balanceHash).toBe("7.000000");
    expect(data.personalReadsAvailable).toBe(true);
  });

  it("maps a live position end to end (share balance + priced value)", async () => {
    server.use(
      balanceOverride((5n * SHARE).toString()),
      http.get("*/api/v1/portfolio/metrics", () =>
        HttpResponse.json(
          envelope(metrics({ indexed_share_balance: (5n * SHARE).toString() }), { source: "indexed" }),
        ),
      ),
    );
    const data = await loadPortfolioData(withKey(), SESSION, 0);
    expect(data.summary.valuePlane).toBe("live");
    expect(data.summary.balanceHash).toBe("5.000000");
    expect(data.summary.currentValueHash).not.toBeNull();
    expect(data.summary.divergent).toBe(false);
  });

  it("flags divergence when the live balance differs from the indexed balance", async () => {
    server.use(
      balanceOverride((5n * SHARE).toString()),
      http.get("*/api/v1/portfolio/metrics", () =>
        HttpResponse.json(
          envelope(metrics({ indexed_share_balance: (4n * SHARE).toString() }), { source: "indexed" }),
        ),
      ),
    );
    const data = await loadPortfolioData(withKey(), SESSION, 0);
    expect(data.summary.divergent).toBe(true);
    // Basis-derived fields still populate; the flag carries the honesty state.
    expect(data.summary.accruedGainHash).not.toBeNull();
  });
});

describe("personal reads availability", () => {
  it("API down leaves a live-only summary with personalReadsAvailable false", async () => {
    server.use(
      http.get("*/api/v1/portfolio", () => HttpResponse.json({}, { status: 503 })),
      http.get("*/api/v1/portfolio/metrics", () => HttpResponse.json({}, { status: 503 })),
      http.get("*/api/v1/transactions", () => HttpResponse.json({}, { status: 503 })),
    );
    const data = await loadPortfolioData(withKey(), SESSION, 0);
    expect(data.personalReadsAvailable).toBe(false);
    expect(data.summary.valuePlane).toBe("live");
    expect(data.history).toBeNull();
    expect(data.accrual).toBeNull();
  });

  it("no minting key gives the same live-only, personal-unavailable posture", async () => {
    const data = await loadPortfolioData(withoutKey(), SESSION, 0);
    expect(data.personalReadsAvailable).toBe(false);
    expect(data.summary.valuePlane).toBe("live");
    expect(data.summary.historyState).toBeNull();
    expect(data.history).toBeNull();
  });
});

describe("history-state honesty", () => {
  it("has_transfers flows through as a flag while figures populate", async () => {
    server.use(
      http.get("*/api/v1/portfolio/metrics", () =>
        HttpResponse.json(
          envelope(metrics({ history_state: "has_transfers", cost_basis_nhash: (10n * HASH).toString() }), {
            source: "indexed",
          }),
        ),
      ),
    );
    const data = await loadPortfolioData(withKey(), SESSION, 0);
    expect(data.summary.historyState).toBe("has_transfers");
    expect(data.summary.costBasisHash).not.toBeNull();
  });

  it("inconsistent nulls the basis-derived figures (never fabricated)", async () => {
    server.use(
      http.get("*/api/v1/portfolio/metrics", () =>
        HttpResponse.json(
          envelope(
            metrics({
              history_state: "inconsistent",
              cost_basis_nhash: null,
              escrowed_basis_nhash: null,
              realized_gain_nhash: null,
            }),
            { source: "indexed" },
          ),
        ),
      ),
    );
    const data = await loadPortfolioData(withKey(), SESSION, 0);
    expect(data.summary.historyState).toBe("inconsistent");
    expect(data.summary.costBasisHash).toBeNull();
    expect(data.summary.accruedGainHash).toBeNull();
    expect(data.summary.realizedGainHash).toBeNull();
  });
});

describe("metrics boundary validation", () => {
  // A fractional realized gain violates the base-unit-integer schema; the read
  // degrades to null metrics (never crashes on BigInt("1.5")).
  it.each(["1.5", "-1.5"])("rejects a fractional realized_gain_nhash (%s) to null metrics", async (bad) => {
    server.use(
      http.get("*/api/v1/portfolio/metrics", () =>
        HttpResponse.json(envelope(metrics({ realized_gain_nhash: bad }), { source: "indexed" })),
      ),
    );
    const data = await loadPortfolioData(withKey(), SESSION, 0);
    // The metrics envelope failed to parse -> indexed-derived figures are null.
    expect(data.summary.costBasisHash).toBeNull();
    expect(data.summary.realizedGainHash).toBeNull();
    expect(data.accrual).toBeNull();
    // The live plane still answers, so the summary is not blank.
    expect(data.summary.valuePlane).toBe("live");
  });
});

describe("empty history and pagination", () => {
  it("an empty indexed history yields zeros and empties without fabrication", async () => {
    const data = await loadPortfolioData(withKey(), SESSION, 0);
    expect(data.firstActivityAt).toBeNull();
    expect(data.activeRedemptions).toEqual([]);
    expect(data.yieldByEpoch).toEqual([]);
    expect(data.accrual).toEqual({ points: [], markers: [], truncated: false, historyTruncated: false });
    expect(data.history).toEqual({ rows: [], page: 0, pageSize: 50, hasMore: false });
    expect(data.effectiveAprBps).toBeNull();
  });

  it("page 1 requests offset 50 (page * pageSize)", async () => {
    let capturedOffset: string | null = null;
    let capturedLimit: string | null = null;
    server.use(
      http.get("*/api/v1/transactions", ({ request }) => {
        const url = new URL(request.url);
        capturedOffset = url.searchParams.get("offset");
        capturedLimit = url.searchParams.get("limit");
        return HttpResponse.json(envelope([] as unknown[], { source: "indexed" }));
      }),
    );
    const data = await loadPortfolioData(withKey(), SESSION, 1);
    expect(capturedOffset).toBe("50");
    expect(capturedLimit).toBe("50");
    expect(data.history?.page).toBe(1);
  });

  it("page 3 requests offset 150 (page * pageSize)", async () => {
    let capturedOffset: string | null = null;
    server.use(
      http.get("*/api/v1/transactions", ({ request }) => {
        capturedOffset = new URL(request.url).searchParams.get("offset");
        return HttpResponse.json(envelope([] as unknown[], { source: "indexed" }));
      }),
    );
    const data = await loadPortfolioData(withKey(), SESSION, 3);
    expect(capturedOffset).toBe("150");
    expect(data.history?.page).toBe(3);
  });

  it("rejects a negative page (route-bounded invariant)", async () => {
    await expect(loadPortfolioData(withKey(), SESSION, -1)).rejects.toThrow(RangeError);
  });
});

describe("explorer verify-links", () => {
  const txRow = {
    txhash: "ABC123",
    msg_index: 0,
    kind: "swap_in" as const,
    shares: (2n * SHARE).toString(),
    nhash: (2n * HASH).toString(),
    nav_at_height: "1.0000",
    height: 100,
    block_time: "2026-07-21T00:00:00Z",
  };
  const oneRow = () =>
    http.get("*/api/v1/transactions", () =>
      HttpResponse.json(envelope([txRow], { source: "indexed" })),
    );

  it("omits the verify-link when no explorer is configured", async () => {
    server.use(oneRow());
    const data = await loadPortfolioData(withKey(), SESSION, 0);
    expect(data.history?.rows[0]?.explorerHref).toBeNull();
    expect(data.history?.rows[0]?.sharesDisplay).toBe("2.000000");
    expect(data.history?.rows[0]?.nhashDisplay).toBe("2.0000");
  });

  it("builds the verify-link from the configured explorer URL", async () => {
    server.use(oneRow());
    const data = await loadPortfolioData(withExplorer(), SESSION, 0);
    expect(data.history?.rows[0]?.explorerHref).toBe("https://explorer.test/tx/ABC123");
  });
});
