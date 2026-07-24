// Envelope contract harness (app plan §4 "API contract" layer; standing CI gate
// for services/api from PR 1.2 on). Registry-driven: it iterates the ACTUAL
// route table, so every route now and in the future is held to the same three
// contracts — envelope shape, read-only method gate, and zod query bounds — and
// the harness cannot silently skip a new route.

import { describe, expect, it } from "vitest";
import { API_BASE, routes, type Route } from "../src/index.ts";
import { mintAssertion, TEST_ASSERTION_KEY } from "./assertions.ts";
import { startServer } from "./helpers.ts";
import { fakeReader, type FakeFacts } from "./reader-fake.ts";

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

// A bech32-charset-valid fixture address for exercising address-scoped
// routes through the generic registry loops.
const EXAMPLE_ADDRESS = "pb1walletaqq";

/**
 * Build a contract-valid GET for any registered route: public routes need
 * nothing; address-scoped routes get a matching assertion + `?address=`.
 * Registry-driven like the harness itself — a future route with a new auth
 * kind fails here loudly instead of being silently skipped.
 */
function validRequest(route: Route, baseUrl: string): { url: string; init: RequestInit } {
  if (route.auth === "public") return { url: `${baseUrl}${route.path}`, init: {} };
  if (route.auth === "address") {
    return {
      url: `${baseUrl}${route.path}?address=${EXAMPLE_ADDRESS}`,
      init: { headers: { authorization: mintAssertion(`address:${EXAMPLE_ADDRESS}`) } },
    };
  }
  throw new Error(`no valid-request builder for auth kind ${route.auth} (${route.path})`);
}

function isValidEnvelope(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "body is not an object";
  const record = body as Record<string, unknown>;
  if (!("data" in record)) return "missing data";
  if (typeof record.meta !== "object" || record.meta === null) return "missing meta";
  const meta = record.meta as Record<string, unknown>;
  if (meta.source !== "live" && meta.source !== "indexed") return `bad source: ${String(meta.source)}`;
  for (const key of ["chain_height", "indexed_height"] as const) {
    const v = meta[key];
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v))) return `bad ${key}: ${String(v)}`;
  }
  if (typeof meta.generated_at !== "string" || Number.isNaN(Date.parse(meta.generated_at))) {
    return `bad generated_at: ${String(meta.generated_at)}`;
  }
  return null;
}

describe("route registry invariants", () => {
  it("every registered route is a GET (no write endpoint can exist)", () => {
    const nonGet = routes.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
    expect(nonGet, `non-GET routes are forbidden: ${nonGet.join(", ")}`).toEqual([]);
  });

  it("registers at least the scaffold routes under the versioned base", () => {
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const route of routes) expect(route.path.startsWith(`${API_BASE}/`)).toBe(true);
  });
});

describe("envelope + method contract on every route", () => {
  it("enveloped routes return a valid freshness envelope; operational routes do not", async () => {
    const server = await startServer({ assertionKey: TEST_ASSERTION_KEY });
    try {
      for (const route of routes) {
        const { url, init } = validRequest(route, server.baseUrl);
        const res = await fetch(url, init);
        expect(res.status, `${route.path} should 200`).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/application\/json/);
        // Rate-limit headers are present on every response (defensive posture).
        expect(res.headers.get("ratelimit-limit")).not.toBeNull();
        const body = await res.json();
        if (route.enveloped) {
          expect(isValidEnvelope(body), `${route.path} envelope`).toBeNull();
        } else {
          expect(isValidEnvelope(body)).not.toBeNull(); // operational routes are intentionally un-enveloped
        }
      }
    } finally {
      await server.close();
    }
  });

  it("rejects every write verb on every route with 405 + Allow (read-only)", async () => {
    const server = await startServer();
    try {
      for (const route of routes) {
        for (const method of WRITE_METHODS) {
          const res = await fetch(`${server.baseUrl}${route.path}`, { method });
          expect(res.status, `${method} ${route.path}`).toBe(405);
          expect(res.headers.get("allow")).toContain("GET");
        }
      }
    } finally {
      await server.close();
    }
  });

  it("returns 404 (enveloped-free error) for an unknown route", async () => {
    const server = await startServer();
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/does-not-exist`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("not_found");
    } finally {
      await server.close();
    }
  });
});

describe("honest-empty state (default reader: no data plane wired)", () => {
  it("/metrics reports the exact ProgramMetrics field set, all honestly null", async () => {
    const server = await startServer();
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/metrics`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown> };
      expect(Object.keys(body.data).sort()).toEqual([
        "epoch_count",
        "participant_count",
        "program_started_at",
      ]);
      expect(body.data.participant_count).toBeNull();
      expect(body.data.program_started_at).toBeNull();
      expect(body.data.epoch_count).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("/epochs and /incidents return empty arrays with null heights (no fabrication)", async () => {
    // /validators is covered by its own case below: since PR 3.1 it returns a
    // ValidatorsPayload object, not a bare array.
    const server = await startServer();
    try {
      for (const path of [`${API_BASE}/epochs`, `${API_BASE}/incidents`]) {
        const res = await fetch(`${server.baseUrl}${path}`);
        expect(res.status, path).toBe(200);
        const body = (await res.json()) as {
          data: unknown[];
          meta: { indexed_height: unknown };
        };
        expect(body.data, path).toEqual([]);
        expect(body.meta.indexed_height, path).toBeNull();
      }
    } finally {
      await server.close();
    }
  });

  it("/epochs is pagination-bounded like every collection route", async () => {
    // /validators takes no pagination since PR 3.1 (whole current set).
    const server = await startServer();
    try {
      const ok = await fetch(`${server.baseUrl}${API_BASE}/epochs?limit=48`);
      expect(ok.status).toBe(200);
      for (const qs of ["?limit=0", "?limit=201", "?offset=-1"]) {
        const res = await fetch(`${server.baseUrl}${API_BASE}/epochs${qs}`);
        expect(res.status, qs).toBe(400);
      }
    } finally {
      await server.close();
    }
  });

  it("/validators reports an empty set and /status says unwired", async () => {
    const server = await startServer();
    try {
      const validators = await fetch(`${server.baseUrl}${API_BASE}/validators`);
      expect(validators.status).toBe(200);
      const vBody = (await validators.json()) as {
        data: { validators: unknown[]; set_health: Record<string, number> };
        meta: { indexed_height: unknown };
      };
      expect(vBody.data.validators).toEqual([]);
      expect(vBody.data.set_health).toEqual({ total: 0, active: 0, eligible: 0, in_arrears: 0 });
      expect(vBody.meta.indexed_height).toBeNull();

      const status = await fetch(`${server.baseUrl}${API_BASE}/status`);
      const sBody = (await status.json()) as { data: { data_source: string } };
      expect(sBody.data.data_source).toBe("unwired");
    } finally {
      await server.close();
    }
  });

  it("/market serves the honest 'coming soon' empty state (§13 decision 4)", async () => {
    const server = await startServer();
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/market`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { sample: unknown; bridged_supply: unknown[] };
        meta: { indexed_height: unknown };
      };
      expect(body.data.sample).toBeNull();
      expect(body.data.bridged_supply).toEqual([]);
      expect(body.meta.indexed_height).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("address-scoped routes serve honest-empty facts for an unseen address", async () => {
    const server = await startServer({ assertionKey: TEST_ASSERTION_KEY });
    const auth = { authorization: mintAssertion(`address:${EXAMPLE_ADDRESS}`) };
    try {
      const portfolio = await fetch(
        `${server.baseUrl}${API_BASE}/portfolio?address=${EXAMPLE_ADDRESS}`,
        { headers: auth },
      );
      expect(portfolio.status).toBe(200);
      const pBody = (await portfolio.json()) as { data: Record<string, unknown> };
      expect(pBody.data).toEqual({
        address: EXAMPLE_ADDRESS,
        first_activity_at: null,
        transaction_count: 0,
        escrowed_shares: "0",
        active_redemptions: [],
      });

      const transactions = await fetch(
        `${server.baseUrl}${API_BASE}/transactions?address=${EXAMPLE_ADDRESS}`,
        { headers: auth },
      );
      expect(transactions.status).toBe(200);
      const tBody = (await transactions.json()) as { data: unknown[] };
      expect(tBody.data).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("/portfolio/metrics serves the fold's empty output for an unseen address", async () => {
    const server = await startServer({ assertionKey: TEST_ASSERTION_KEY });
    const auth = { authorization: mintAssertion(`address:${EXAMPLE_ADDRESS}`) };
    try {
      const res = await fetch(
        `${server.baseUrl}${API_BASE}/portfolio/metrics?address=${EXAMPLE_ADDRESS}`,
        { headers: auth },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown> };
      // No history: zeros for balances/basis, null APR, empty series — never
      // a fabricated figure (§12.1 honesty).
      expect(body.data).toEqual({
        address: EXAMPLE_ADDRESS,
        history_state: "complete",
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
      });
    } finally {
      await server.close();
    }
  });
});

describe("populated portfolio metrics (M6.1 derived fold behind the route)", () => {
  const ADDR = "pb1walletaqq";
  const metricsFacts: FakeFacts = {
    reconcilerRun: { chainHeight: 4242n, indexedHeight: 4200n },
    // NAV rises 1.0 → 2.2 between the two settled epochs; the deposit lands
    // between them, so it is held into epoch 2's repricing.
    epochs: [
      { epochIndex: 1n, endedAtSeconds: 1_000n, tvvAfter: 1_000n, totalShares: 1_000n, netAprBps: 400, endHeight: 10n },
      { epochIndex: 2n, endedAtSeconds: 2_000n, tvvAfter: 2_200n, totalShares: 1_000n, netAprBps: 500, endHeight: 20n },
    ],
    transactions: [
      { txhash: "DEP", msgIndex: 0, address: ADDR, kind: "swap_in", shares: 1_000n, nhash: 1_000n, navAtHeight: 1_000_000_000n, height: 15n, blockTime: new Date(1_500 * 1000) },
    ],
  };

  it("derives basis, balances, accrual heights, and yield behind the route", async () => {
    const server = await startServer({ assertionKey: TEST_ASSERTION_KEY }, undefined, fakeReader(metricsFacts));
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/portfolio/metrics?address=${ADDR}`, {
        headers: { authorization: mintAssertion(`address:${ADDR}`) },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          history_state: string;
          indexed_share_balance: string;
          escrowed_share_balance: string;
          cost_basis_nhash: string;
          escrowed_basis_nhash: string;
          realized_gain_nhash: string;
          effective_apr_bps: number | null;
          yield_by_epoch: Array<Record<string, unknown>>;
          accrual: Array<{ height: number; value_nhash: string }>;
          accrual_truncated: boolean;
          accrual_markers: Array<Record<string, unknown>>;
          markers_truncated: boolean;
        };
        meta: { indexed_height: number };
      };
      expect(body.data.history_state).toBe("complete");
      expect(body.data.indexed_share_balance).toBe("1000");
      expect(body.data.escrowed_share_balance).toBe("0");
      expect(body.data.cost_basis_nhash).toBe("1000");
      expect(body.data.escrowed_basis_nhash).toBe("0");
      expect(body.data.realized_gain_nhash).toBe("0");
      // Accrual carries the REAL synthesized heights (event height, epoch end
      // height) and the value repriced at each step's NAV.
      expect(body.data.accrual.map((p) => p.height)).toEqual([15, 20]);
      expect(body.data.accrual.map((p) => p.value_nhash)).toEqual(["1000", "2200"]);
      // Only epoch 2 spans time after the deposit; its program net APR rides
      // alongside the (unattributable-here) personal figure.
      expect(body.data.yield_by_epoch).toEqual([
        { epoch_index: 2, ended_at: new Date(2_000 * 1000).toISOString(), personal_apr_bps: null, net_apr_bps: 500 },
      ]);
      expect(typeof body.data.effective_apr_bps).toBe("number");
      expect(body.data.accrual_markers.map((m) => m.kind)).toEqual(["swap_in"]);
      expect(body.data.accrual_truncated).toBe(false);
      expect(body.data.markers_truncated).toBe(false);
      expect(body.meta.indexed_height).toBe(4200);
    } finally {
      await server.close();
    }
  });
});

describe("populated reader (PR 3.1: real derivations behind the frozen shapes)", () => {
  // Corpus NAV goldens (@nvhash/fixtures queries/vault/get.json) — the same
  // values pinning the shared helper, now proven through the HTTP surface.
  const FIXTURE_TVV = 315397882283n;
  const FIXTURE_SHARES = 309963777029000000n;

  const facts: FakeFacts = {
    reconcilerRun: { chainHeight: 4242n, indexedHeight: 4200n },
    metrics: {
      indexed: true,
      participantCount: 3,
      firstActivityAt: new Date("2026-06-01T00:00:00Z"),
      epochCount: 2,
    },
    epochs: [
      // Epoch 11's clean ratio (3e11 nhash over 3e17 shares) gives an exact
      // 1 HASH/nvHASH NAV — the premium denominator the [R6] test pins.
      { epochIndex: 11n, endedAtSeconds: 1_764_547_200n, tvvAfter: 300_000_000_000n, totalShares: 300_000_000_000_000_000n, netAprBps: 410 },
      { epochIndex: 12n, endedAtSeconds: 1_767_225_600n, tvvAfter: FIXTURE_TVV, totalShares: FIXTURE_SHARES, netAprBps: 431 },
    ],
    marketSamples: [
      {
        venue: "uniswap-v3",
        pool: "0xpool",
        priceNhash: 1_030_000_000n,
        depthBands: [{ side: "buy", slippage_bps: 50, amount: "1000000000000000" }],
        // Between epoch 11's and epoch 12's settlements: the [R6] rule must
        // pick epoch 11's NAV (1e9) even though epoch 12 exists by now.
        sampledAt: new Date(1_765_000_000 * 1000),
      },
    ],
    bridgedSupply: [
      { chain: "base", remoteSupply: 1_000n, sampledAt: new Date("2026-07-01T00:00:00Z") },
      { chain: "base", remoteSupply: 2_000n, sampledAt: new Date("2026-07-10T00:00:00Z") },
      { chain: "ethereum", remoteSupply: 500n, sampledAt: new Date("2026-07-05T00:00:00Z") },
    ],
    incidents: [
      { kind: "indexer_lag", severity: "warning", openedAt: new Date("2026-07-01T00:00:00Z"), closedAt: null, openedHeight: 900n },
    ],
    registry: [
      { valoper: "pbvaloper1aaa", moniker: "alpha", unregisteredAt: null },
      { valoper: "pbvaloper1bbb", moniker: "bravo", unregisteredAt: null },
    ],
    validatorEpochs: [
      { valoper: "pbvaloper1aaa", epochIndex: 11n, uptimeBps: 9000, eligible: false, failingReasons: ["uptime"], programDelegation: 1n, commissionDue: 9n },
      { valoper: "pbvaloper1aaa", epochIndex: 12n, uptimeBps: 9990, eligible: true, failingReasons: [], programDelegation: 1_000_000_000n, commissionDue: 5n },
      // pbvaloper1bbb: enrolled, never sampled — per-epoch fields must be null.
    ],
  };

  it("serves real envelope heights from the reconciler run on every data route", async () => {
    const server = await startServer({}, undefined, fakeReader(facts));
    try {
      for (const path of ["/status", "/metrics", "/epochs", "/incidents", "/validators", "/market"]) {
        const res = await fetch(`${server.baseUrl}${API_BASE}${path}`);
        const body = (await res.json()) as { meta: { chain_height: number; indexed_height: number } };
        expect(body.meta.chain_height, path).toBe(4242);
        expect(body.meta.indexed_height, path).toBe(4200);
      }
    } finally {
      await server.close();
    }
  });

  it("/status reports the wired data source", async () => {
    const server = await startServer({}, undefined, fakeReader(facts));
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/status`);
      const body = (await res.json()) as { data: { data_source: string } };
      expect(body.data.data_source).toBe("api_reader");
    } finally {
      await server.close();
    }
  });

  it("/metrics serves the derived aggregates", async () => {
    const server = await startServer({}, undefined, fakeReader(facts));
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/metrics`);
      const body = (await res.json()) as { data: Record<string, unknown> };
      expect(body.data).toEqual({
        participant_count: 3,
        program_started_at: "2026-06-01T00:00:00.000Z",
        epoch_count: 2,
      });
    } finally {
      await server.close();
    }
  });

  it("/epochs serves newest-first rows with the corpus NAV golden value", async () => {
    const server = await startServer({}, undefined, fakeReader(facts));
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/epochs`);
      const body = (await res.json()) as { data: Array<Record<string, unknown>> };
      expect(body.data.map((r) => r.epoch_index)).toEqual([12, 11]);
      expect(body.data[0]).toEqual({
        epoch_index: 12,
        ended_at: "2026-01-01T00:00:00.000Z",
        nav: "1.0175", // the shared-helper golden ([R1]) through the HTTP surface
        tvv: FIXTURE_TVV.toString(),
        net_apr_bps: 431,
      });

      const limited = await fetch(`${server.baseUrl}${API_BASE}/epochs?limit=1&offset=1`);
      const page = (await limited.json()) as { data: Array<Record<string, unknown>> };
      expect(page.data.map((r) => r.epoch_index)).toEqual([11]);
    } finally {
      await server.close();
    }
  });

  it("/incidents serves derived rows", async () => {
    const server = await startServer({}, undefined, fakeReader(facts));
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/incidents`);
      const body = (await res.json()) as { data: Array<Record<string, unknown>> };
      expect(body.data).toEqual([
        { kind: "indexer_lag", severity: "warning", opened_at: "2026-07-01T00:00:00.000Z", closed_at: null, height: 900 },
      ]);
    } finally {
      await server.close();
    }
  });

  it("/market computes the premium against the NAV current at the SAMPLE's time ([R6])", async () => {
    const server = await startServer({}, undefined, fakeReader(facts));
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/market`);
      const body = (await res.json()) as {
        data: {
          sample: Record<string, unknown>;
          bridged_supply: Array<Record<string, unknown>>;
        };
      };
      expect(body.data.sample).toEqual({
        venue: "uniswap-v3",
        pool: "0xpool",
        price: "1030000000",
        // vs epoch 11's exact 1e9 NAV (the epoch settled before the sample),
        // NOT epoch 12's — a newer NAV never retroactively reprices a sample.
        premium_discount_bps: 300,
        depth_bands: [{ side: "buy", slippage_bps: 50, amount: "1000000000000000" }],
        sampled_at: new Date(1_765_000_000 * 1000).toISOString(),
      });
      // Latest reading per chain: base keeps only its newest sample.
      expect(body.data.bridged_supply).toEqual([
        { chain: "base", supply: "2000", sampled_at: "2026-07-10T00:00:00.000Z" },
        { chain: "ethereum", supply: "500", sampled_at: "2026-07-05T00:00:00.000Z" },
      ]);
    } finally {
      await server.close();
    }
  });

  it("/validators joins latest samples, nulls the unsampled, aggregates health", async () => {
    const server = await startServer({}, undefined, fakeReader(facts));
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/validators`);
      const body = (await res.json()) as {
        data: { validators: Array<Record<string, unknown>>; set_health: Record<string, number> };
      };
      const alpha = body.data.validators.find((v) => v.valoper === "pbvaloper1aaa");
      expect(alpha).toEqual({
        valoper: "pbvaloper1aaa",
        moniker: "alpha",
        active: true,
        epoch_index: 12,
        uptime_bps: 9990,
        eligible: true,
        failing_reasons: [],
        program_delegation: "1000000000",
        commission_due: "5",
      });
      const bravo = body.data.validators.find((v) => v.valoper === "pbvaloper1bbb");
      expect(bravo?.epoch_index).toBeNull();
      expect(bravo?.eligible).toBeNull();
      expect(body.data.set_health).toEqual({ total: 2, active: 2, eligible: 1, in_arrears: 1 });
    } finally {
      await server.close();
    }
  });
});

describe("zod query bounds on the paginated route (/incidents)", () => {
  const path = `${API_BASE}/incidents`;

  it("accepts in-bounds pagination", async () => {
    const server = await startServer();
    try {
      for (const qs of ["", "?limit=1", "?limit=200", "?offset=0", "?limit=50&offset=1000"]) {
        const res = await fetch(`${server.baseUrl}${path}${qs}`);
        expect(res.status, `"${qs}" should be accepted`).toBe(200);
      }
    } finally {
      await server.close();
    }
  });

  it("rejects out-of-bounds / malformed pagination with 400", async () => {
    const server = await startServer();
    try {
      for (const qs of ["?limit=0", "?limit=201", "?limit=-1", "?limit=abc", "?limit=1.5", "?offset=-1", "?offset=99999999"]) {
        const res = await fetch(`${server.baseUrl}${path}${qs}`);
        expect(res.status, `"${qs}" should be rejected`).toBe(400);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("invalid_query");
      }
    } finally {
      await server.close();
    }
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the window ceiling is exceeded", async () => {
    const server = await startServer({ rateLimitMax: 3, rateLimitWindowMs: 60_000 });
    try {
      const url = `${server.baseUrl}${API_BASE}/status`;
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await fetch(url)).status);
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      const limited = await fetch(url);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).not.toBeNull();
      const body = (await limited.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("rate_limited");
    } finally {
      await server.close();
    }
  });
});
