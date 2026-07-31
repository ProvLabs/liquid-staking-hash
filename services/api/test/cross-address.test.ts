// THE cross-address-rejection contract gate (ADR-001 Decision 2
// §4) — a STANDING services/api CI gate, never a one-time
// audit. It proves the address-scoped authorization is an in-process
// mechanism: an assertion for address A requesting address B → 403;
// absent/expired/invalid → 401; `internal:notifier` on a personal endpoint →
// 403; public endpoints accept credential-free requests. The [R4] pipeline
// order (401 before 400 before 403) and the [R7d] clock-skew bound are part
// of the matrix, as are the §14.11 CSV export contract ([R3] freshness
// headers + the pinned column set).

import { describe, expect, it } from "vitest";
import { API_BASE, routes, TRANSACTIONS_CSV_COLUMNS, csvField } from "../src/index.ts";
import { mintAssertion, TEST_ASSERTION_KEY } from "./assertions.ts";
import { startServer, type RunningServer } from "./helpers.ts";
import { fakeReader } from "./reader-fake.ts";

const ADDR_A = "pb1walletaqq";
const ADDR_B = "pb1walletzz2";

// Two addresses with history, so scoping is observable in the data itself.
const facts = {
  reconcilerRun: { chainHeight: 4242n, indexedHeight: 4200n },
  transactions: [
    {
      txhash: "AA",
      msgIndex: 0,
      address: ADDR_A,
      kind: "swap_in" as const,
      shares: 1_000n,
      nhash: 1_017n,
      navAtHeight: 1_017_500_000n,
      height: 100n,
      blockTime: new Date("2026-06-01T00:00:00Z"),
    },
    {
      txhash: "BB",
      msgIndex: 0,
      address: ADDR_B,
      kind: "swap_in" as const,
      shares: 2_000n,
      nhash: 2_035n,
      navAtHeight: 1_017_500_000n,
      height: 200n,
      blockTime: new Date("2026-06-02T00:00:00Z"),
    },
    {
      txhash: "CC",
      msgIndex: 0,
      address: ADDR_A,
      kind: "swap_out_request" as const,
      shares: 500n,
      nhash: 0n,
      navAtHeight: 1_017_500_000n,
      height: 300n,
      blockTime: new Date("2026-06-03T00:00:00Z"),
    },
  ],
  redemptions: [
    {
      requestId: "req-1",
      owner: ADDR_A,
      shares: 500n,
      status: "enqueued" as const,
      enqueuedAt: new Date("2026-06-03T00:00:00Z"),
      expeditedAt: null,
      maturedAt: null,
      refundedAt: null,
      lastHeight: 300n,
      lastTxhash: "CC",
    },
    {
      requestId: "req-0",
      owner: ADDR_A,
      shares: 100n,
      status: "matured" as const,
      enqueuedAt: new Date("2026-05-01T00:00:00Z"),
      expeditedAt: null,
      maturedAt: new Date("2026-05-20T00:00:00Z"),
      refundedAt: null,
      lastHeight: 50n,
      lastTxhash: "OLD",
    },
  ],
};

function startAuthServer(): Promise<RunningServer> {
  return startServer({ assertionKey: TEST_ASSERTION_KEY }, undefined, fakeReader(facts));
}

// Registry-derived, like INTERNAL_PATHS below: every current AND future
// `auth: "address"` route joins the cross-address matrix automatically. It was
// a hand-kept list; three routes can land at once, and a
// hand-kept list is exactly the thing that silently misses the fourth.
const PERSONAL_PATHS = routes.filter((r) => r.auth === "address").map((r) => r.path);

// Routes whose zod schema requires a `valoper` alongside `address`; the
// cross-address matrix must send one or a 400 would mask the 403 it is testing.
/** Public routes requiring a query param — same declaration as the envelope
 * harness, for the same reason: an undeclared required param 400s, and a 400
 * would pass a "not refused" assertion for the wrong reason. */
const PUBLIC_REQUIRED_QUERY: Record<string, string> = {
  "/api/v1/governance/proposal": "id=1",
};

const VALOPER_PATHS = new Set<string>([
  `${API_BASE}/operator/epochs`,
  `${API_BASE}/operator/payments`,
]);
const VALOPER_A = "pbvaloper1walletaqq";

/** The query string a personal route needs to reach its scope check. */
function personalQuery(path: string, address: string): string {
  return VALOPER_PATHS.has(path) ? `address=${address}&valoper=${VALOPER_A}` : `address=${address}`;
}

// Registry-derived, like the public-route loop below: every current AND future
// `internal:notifier` route joins this matrix automatically — a new internal
// route cannot slip past the gate.
const INTERNAL_PATHS = routes.filter((r) => r.auth === "internal:notifier").map((r) => r.path);

describe("cross-address rejection (standing gate, ADR-001 Decision 2)", () => {
  it("rejects an assertion for A requesting B with 403 on every personal route", async () => {
    const server = await startAuthServer();
    try {
      // The registry-derived list is the gate's coverage: assert it is real and
      // that every `valoper`-taking route is in VALOPER_PATHS, so a future
      // route with a new required param cannot silently 400 its way past the
      // 403 assertions below.
      expect(PERSONAL_PATHS.length).toBeGreaterThanOrEqual(6);
      for (const path of VALOPER_PATHS) expect(PERSONAL_PATHS).toContain(path);

      for (const path of PERSONAL_PATHS) {
        const res = await fetch(`${server.baseUrl}${path}?${personalQuery(path, ADDR_B)}`, {
          headers: { authorization: mintAssertion(`address:${ADDR_A}`) },
        });
        expect(res.status, path).toBe(403);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code, path).toBe("forbidden");
      }
    } finally {
      await server.close();
    }
  });

  it("rejects absent, malformed, and mis-signed assertions with 401", async () => {
    const server = await startAuthServer();
    try {
      const cases: Array<Record<string, string>> = [
        {}, // absent
        { authorization: "Bearer not-a-token" },
        { authorization: "Basic abc" },
        {
          authorization: mintAssertion(`address:${ADDR_A}`, {
            key: "wrong-key-wrong-key-wrong-key-wrong",
          }),
        },
      ];
      for (const headers of cases) {
        for (const path of PERSONAL_PATHS) {
          const res = await fetch(`${server.baseUrl}${path}?${personalQuery(path, ADDR_A)}`, {
            headers,
          });
          expect(res.status, `${path} ${JSON.stringify(headers)}`).toBe(401);
        }
      }
    } finally {
      await server.close();
    }
  });

  it("rejects expired, over-long-lifetime, and future-minted assertions with 401", async () => {
    const server = await startAuthServer();
    try {
      const now = Math.floor(Date.now() / 1000);
      const cases = [
        mintAssertion(`address:${ADDR_A}`, { iat: now - 120, exp: now - 65 }), // expired
        mintAssertion(`address:${ADDR_A}`, { iat: now, exp: now + 120 }), // exp − iat > 60 (ADR-001)
        mintAssertion(`address:${ADDR_A}`, { iat: now + 60, exp: now + 115 }), // [R7d] minted in the future
      ];
      for (const authorization of cases) {
        const res = await fetch(`${server.baseUrl}${API_BASE}/portfolio?address=${ADDR_A}`, {
          headers: { authorization },
        });
        expect(res.status, authorization).toBe(401);
      }
    } finally {
      await server.close();
    }
  });

  it("rejects the internal:notifier scope on personal endpoints with 403", async () => {
    const server = await startAuthServer();
    try {
      for (const path of PERSONAL_PATHS) {
        const res = await fetch(`${server.baseUrl}${path}?${personalQuery(path, ADDR_A)}`, {
          headers: { authorization: mintAssertion("internal:notifier") },
        });
        expect(res.status, path).toBe(403);
      }
    } finally {
      await server.close();
    }
  });

  it("holds the INTERNAL_PATHS matrix: no cred → 401, address scope → 403, notifier → 200", async () => {
    const server = await startAuthServer();
    try {
      expect(INTERNAL_PATHS.length).toBeGreaterThan(0); // the routes exist (M6.2)
      for (const path of INTERNAL_PATHS) {
        // No credential → 401 (credential validity precedes everything else).
        const noCred = await fetch(`${server.baseUrl}${path}`);
        expect(noCred.status, `${path} no-cred`).toBe(401);

        // An `address:` scope never grants an internal path → 403.
        const addrScope = await fetch(`${server.baseUrl}${path}`, {
          headers: { authorization: mintAssertion(`address:${ADDR_A}`) },
        });
        expect(addrScope.status, `${path} address-scope`).toBe(403);

        // The `internal:notifier` scope is accepted → 200 (enveloped).
        const notifier = await fetch(`${server.baseUrl}${path}`, {
          headers: { authorization: mintAssertion("internal:notifier") },
        });
        expect(notifier.status, `${path} notifier`).toBe(200);
        const body = (await notifier.json()) as { data: unknown; meta: { source: string } };
        expect(Array.isArray(body.data), `${path} data is an array`).toBe(true);
        expect(body.meta.source).toBe("indexed");
      }
    } finally {
      await server.close();
    }
  });

  it("accepts credential-free requests on every public route (registry-driven)", async () => {
    const server = await startAuthServer();
    try {
      for (const route of routes.filter((r) => r.auth === "public")) {
        const query = PUBLIC_REQUIRED_QUERY[route.path];
        const res = await fetch(
          `${server.baseUrl}${route.path}${query === undefined ? "" : `?${query}`}`,
        );
        // What this asserts is that no credential is NEEDED. A single-resource
        // lookup the dataless reader cannot satisfy answers 404 — still proof the
        // request was not refused for lack of a credential, which is the property
        // under test here.
        expect([200, 404], route.path).toContain(res.status);
      }
    } finally {
      await server.close();
    }
  });

  it("fails closed with 401 when no assertion key is configured", async () => {
    // Default server: no assertionKey — a well-formed assertion cannot verify.
    const server = await startServer({}, undefined, fakeReader(facts));
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/portfolio?address=${ADDR_A}`, {
        headers: { authorization: mintAssertion(`address:${ADDR_A}`) },
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("bounds ?address= with the bech32 schema (400 after 401, per the [R4] order)", async () => {
    const server = await startAuthServer();
    try {
      // No credential + bad address → 401 (credential validity precedes zod).
      const unauth = await fetch(`${server.baseUrl}${API_BASE}/portfolio?address=NOT_BECH32`);
      expect(unauth.status).toBe(401);
      // Valid credential + bad address → 400 from the bech32 bound.
      for (const bad of ["NOT_BECH32", "pb1WALLETAQQ", "pb1short", "pb1walletbio"]) {
        const res = await fetch(`${server.baseUrl}${API_BASE}/portfolio?address=${bad}`, {
          headers: { authorization: mintAssertion(`address:${ADDR_A}`) },
        });
        expect(res.status, bad).toBe(400);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code, bad).toBe("invalid_query");
      }
    } finally {
      await server.close();
    }
  });

  it("serves the authorized address its own scoped facts (A never sees B)", async () => {
    const server = await startAuthServer();
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/transactions?address=${ADDR_A}`, {
        headers: { authorization: mintAssertion(`address:${ADDR_A}`) },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ txhash: string }> };
      expect(body.data.map((r) => r.txhash)).toEqual(["CC", "AA"]); // newest first; BB (address B) absent

      const portfolio = await fetch(`${server.baseUrl}${API_BASE}/portfolio?address=${ADDR_A}`, {
        headers: { authorization: mintAssertion(`address:${ADDR_A}`) },
      });
      const pBody = (await portfolio.json()) as {
        data: {
          transaction_count: number;
          escrowed_shares: string;
          active_redemptions: Array<{ request_id: string }>;
        };
      };
      expect(pBody.data.transaction_count).toBe(2);
      expect(pBody.data.escrowed_shares).toBe("500"); // enqueued only; the matured req-0 does not escrow
      expect(pBody.data.active_redemptions.map((r) => r.request_id)).toEqual(["req-1"]);
    } finally {
      await server.close();
    }
  });
});

describe("CSV export contract (§14.11; [R3] freshness headers)", () => {
  it("serves text/csv with the pinned column set and X- freshness headers", async () => {
    const server = await startAuthServer();
    try {
      const res = await fetch(
        `${server.baseUrl}${API_BASE}/transactions?address=${ADDR_A}&format=csv`,
        { headers: { authorization: mintAssertion(`address:${ADDR_A}`) } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/csv/);
      expect(res.headers.get("content-disposition")).toContain("transactions.csv");
      expect(res.headers.get("x-chain-height")).toBe("4242");
      expect(res.headers.get("x-indexed-height")).toBe("4200");
      expect(res.headers.get("x-generated-at")).not.toBeNull();
      // Defensive headers still apply to the non-JSON representation.
      expect(res.headers.get("cache-control")).toBe("no-store");

      const lines = (await res.text()).trimEnd().split("\n");
      expect(lines[0]).toBe(TRANSACTIONS_CSV_COLUMNS.join(","));
      expect(lines).toHaveLength(3); // header + AA + CC (§14.11: full history, ascending)
      expect(lines[1]).toBe("2026-06-01T00:00:00.000Z,100,AA,0,swap_in,1000,1017,1017500000");
      expect(lines[2]).toBe("2026-06-03T00:00:00.000Z,300,CC,0,swap_out_request,500,0,1017500000");
    } finally {
      await server.close();
    }
  });

  it("requires the same address-scoped authorization as the JSON view", async () => {
    const server = await startAuthServer();
    try {
      const cross = await fetch(
        `${server.baseUrl}${API_BASE}/transactions?address=${ADDR_B}&format=csv`,
        { headers: { authorization: mintAssertion(`address:${ADDR_A}`) } },
      );
      expect(cross.status).toBe(403);
      const bare = await fetch(
        `${server.baseUrl}${API_BASE}/transactions?address=${ADDR_A}&format=csv`,
      );
      expect(bare.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("exports the COMPLETE history ascending, ignoring JSON pagination bounds (§14.11)", async () => {
    // More rows than the JSON `limit` max (200): the CSV must never inherit
    // that bound, or an export would silently drop a holder's older events.
    const ROWS = 260;
    const many = Array.from({ length: ROWS }, (_, i) => ({
      txhash: `TX${i}`,
      msgIndex: 0,
      address: ADDR_A,
      kind: "swap_in" as const,
      shares: BigInt(i + 1),
      nhash: BigInt(i + 1),
      navAtHeight: 1_000_000_000n,
      height: BigInt(i + 1),
      blockTime: new Date((1_700_000_000 + i) * 1000),
    }));
    const server = await startServer(
      { assertionKey: TEST_ASSERTION_KEY },
      undefined,
      fakeReader({
        reconcilerRun: { chainHeight: 4242n, indexedHeight: 4200n },
        transactions: many,
      }),
    );
    try {
      const auth = { authorization: mintAssertion(`address:${ADDR_A}`) };
      const csv = await fetch(
        `${server.baseUrl}${API_BASE}/transactions?address=${ADDR_A}&format=csv`,
        {
          headers: auth,
        },
      );
      expect(csv.status).toBe(200);
      const lines = (await csv.text()).trimEnd().split("\n");
      expect(lines).toHaveLength(ROWS + 1); // header + every row, none truncated
      // Ascending by (height, msg_index): TX0 first data row, TX259 last.
      expect(lines[1]!.split(",")[2]).toBe("TX0");
      expect(lines[ROWS]!.split(",")[2]).toBe(`TX${ROWS - 1}`);

      // The JSON view still paginates at the schema ceiling (200).
      const json = await fetch(
        `${server.baseUrl}${API_BASE}/transactions?address=${ADDR_A}&limit=200`,
        {
          headers: auth,
        },
      );
      const body = (await json.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(200);
    } finally {
      await server.close();
    }
  });

  it("csvField guards formula injection and quotes per RFC 4180", () => {
    expect(csvField("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-1")).toBe("'-1");
    expect(csvField("@cmd")).toBe("'@cmd");
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField("plain")).toBe("plain");
  });
});
