// Internal alert-facts surface (`internal:notifier` scope; app-spec
// §9.4). Proves the three notifier reads over the in-memory fake — through the
// SAME derive.ts mappers the Prisma reader uses — for shape, cursor windowing,
// honest-empty, and the arrears active-registry join. The auth matrix
// (401/403/200) is the standing INTERNAL_PATHS gate in cross-address.test.ts;
// this suite is the data contract.

import { describe, expect, it } from "vitest";
import { API_BASE } from "../src/index.ts";
import { mintAssertion, TEST_ASSERTION_KEY } from "./assertions.ts";
import { startServer, type RunningServer } from "./helpers.ts";
import { fakeReader, type FakeFacts } from "./reader-fake.ts";

const NOTIFIER = { authorization: mintAssertion("internal:notifier") };

const OWNER_A = "pb1walletaqq";
const OWNER_B = "pb1walletzz2";

const facts: FakeFacts = {
  reconcilerRun: { chainHeight: 4242n, indexedHeight: 4200n },
  redemptions: [
    // lastHeight spread across the cursor boundary so windowing is observable.
    {
      requestId: "req-1",
      owner: OWNER_A,
      shares: 500n,
      status: "matured",
      enqueuedAt: new Date("2026-05-01T00:00:00Z"),
      expeditedAt: null,
      maturedAt: new Date("2026-05-20T00:00:00Z"),
      refundedAt: null,
      lastHeight: 100n,
      lastTxhash: "AA",
    },
    {
      requestId: "req-2",
      owner: OWNER_B,
      shares: 200n,
      status: "expedited",
      enqueuedAt: new Date("2026-05-02T00:00:00Z"),
      expeditedAt: new Date("2026-05-10T00:00:00Z"),
      maturedAt: null,
      refundedAt: null,
      lastHeight: 200n,
      lastTxhash: "BB",
    },
    {
      requestId: "req-3",
      owner: OWNER_A,
      shares: 300n,
      status: "refunded",
      enqueuedAt: new Date("2026-05-03T00:00:00Z"),
      expeditedAt: null,
      maturedAt: null,
      refundedAt: new Date("2026-06-01T00:00:00Z"),
      lastHeight: 300n,
      lastTxhash: "CC",
    },
  ],
  alertIncidents: [
    {
      id: 1n,
      kind: "vault_paused",
      severity: "critical",
      dedupeKey: "vault:1",
      openedAt: new Date("2026-06-01T00:00:00Z"),
      openedHeight: 150n,
    },
    {
      id: 2n,
      kind: "jail_report",
      severity: "warning",
      dedupeKey: "jail:pbvaloper1aaa",
      openedAt: new Date("2026-06-02T00:00:00Z"),
      openedHeight: 260n,
    },
    {
      id: 3n,
      kind: "reconciler_divergence",
      severity: "critical",
      dedupeKey: "recon:nav",
      openedAt: new Date("2026-06-03T00:00:00Z"),
      openedHeight: null,
    },
  ],
  registry: [
    { valoper: "pbvaloper1aaa", moniker: "alpha", unregisteredAt: null, operator: "pb1opalpha" },
    { valoper: "pbvaloper1bbb", moniker: "bravo", unregisteredAt: null, operator: "pb1opbravo" },
    // charlie is UNREGISTERED — its arrears must never surface.
    {
      valoper: "pbvaloper1ccc",
      moniker: "charlie",
      unregisteredAt: new Date("2026-05-01T00:00:00Z"),
      operator: "pb1opcharlie",
    },
  ],
  validatorEpochs: [
    // Latest epoch is 12. alpha owes; bravo is square; charlie owes but is unregistered.
    {
      valoper: "pbvaloper1aaa",
      epochIndex: 11n,
      uptimeBps: 9000,
      eligible: true,
      failingReasons: [],
      programDelegation: 1n,
      commissionDue: 999n,
    },
    {
      valoper: "pbvaloper1aaa",
      epochIndex: 12n,
      uptimeBps: 9990,
      eligible: true,
      failingReasons: [],
      programDelegation: 1n,
      commissionDue: 7n,
    },
    {
      valoper: "pbvaloper1bbb",
      epochIndex: 12n,
      uptimeBps: 9990,
      eligible: true,
      failingReasons: [],
      programDelegation: 1n,
      commissionDue: 0n,
    },
    {
      valoper: "pbvaloper1ccc",
      epochIndex: 12n,
      uptimeBps: 9990,
      eligible: true,
      failingReasons: [],
      programDelegation: 1n,
      commissionDue: 42n,
    },
  ],
};

function server(): Promise<RunningServer> {
  return startServer({ assertionKey: TEST_ASSERTION_KEY }, undefined, fakeReader(facts));
}

async function getData<T>(
  s: RunningServer,
  path: string,
  headers = NOTIFIER,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${s.baseUrl}${path}`, { headers });
  const body = (await res.json()) as { data: T };
  return { status: res.status, data: body.data };
}

describe("internal alert-facts: redemptions", () => {
  it("returns owner + terminal timestamps + height, and NO amount field", async () => {
    const s = await server();
    try {
      const { status, data } = await getData<Array<Record<string, unknown>>>(
        s,
        `${API_BASE}/internal/alert-facts/redemptions`,
      );
      expect(status).toBe(200);
      // Ascending by height; all three past cursor 0.
      expect(data.map((r) => r.request_id)).toEqual(["req-1", "req-2", "req-3"]);
      expect(data[0]).toEqual({
        request_id: "req-1",
        owner: OWNER_A,
        status: "matured",
        enqueued_at: "2026-05-01T00:00:00.000Z",
        expedited_at: null,
        matured_at: "2026-05-20T00:00:00.000Z",
        refunded_at: null,
        last_height: 100,
      });
      // Payload minimalism: no amount-bearing key leaks.
      for (const row of data) {
        for (const key of Object.keys(row)) {
          expect(key).not.toMatch(/shares|amount|nhash/i);
        }
      }
    } finally {
      await s.close();
    }
  });

  it("windows by the compound cursor and honors the page limit", async () => {
    const s = await server();
    try {
      // Empty after_id: the boundary height is INCLUDED (tuple (100, id) >
      // (100, "")) — a height-only cursor re-scans its boundary and the
      // notifier's unique constraint absorbs it.
      const { data } = await getData<Array<{ request_id: string }>>(
        s,
        `${API_BASE}/internal/alert-facts/redemptions?since_height=100`,
      );
      expect(data.map((r) => r.request_id)).toEqual(["req-1", "req-2", "req-3"]);

      // With the tie-break, the boundary row itself is excluded.
      const strict = await getData<Array<{ request_id: string }>>(
        s,
        `${API_BASE}/internal/alert-facts/redemptions?since_height=100&after_id=req-1`,
      );
      expect(strict.data.map((r) => r.request_id)).toEqual(["req-2", "req-3"]);

      const limited = await getData<Array<{ request_id: string }>>(
        s,
        `${API_BASE}/internal/alert-facts/redemptions?limit=1`,
      );
      expect(limited.data.map((r) => r.request_id)).toEqual(["req-1"]);
    } finally {
      await s.close();
    }
  });

  it("pages through a same-height burst via the after_id tie-break (no loss)", async () => {
    // Mass maturation at an epoch settlement puts MANY rows on ONE lastHeight;
    // a strictly-greater height cursor alone would skip whatever overflows the
    // page. The compound `(since_height, after_id)` cursor resumes inside the
    // height instead.
    const burst: FakeFacts = {
      redemptions: ["req-a", "req-b", "req-c"].map((requestId) => ({
        requestId,
        owner: OWNER_A,
        shares: 100n,
        status: "matured" as const,
        enqueuedAt: new Date("2026-05-01T00:00:00Z"),
        expeditedAt: null,
        maturedAt: new Date("2026-05-20T00:00:00Z"),
        refundedAt: null,
        lastHeight: 500n,
        lastTxhash: "DD",
      })),
    };
    const s = await startServer({ assertionKey: TEST_ASSERTION_KEY }, undefined, fakeReader(burst));
    try {
      const first = await getData<Array<{ request_id: string }>>(
        s,
        `${API_BASE}/internal/alert-facts/redemptions?limit=2`,
      );
      expect(first.data.map((r) => r.request_id)).toEqual(["req-a", "req-b"]);
      const rest = await getData<Array<{ request_id: string }>>(
        s,
        `${API_BASE}/internal/alert-facts/redemptions?since_height=500&after_id=req-b`,
      );
      expect(rest.data.map((r) => r.request_id)).toEqual(["req-c"]); // resumed, not skipped
    } finally {
      await s.close();
    }
  });

  it("rejects out-of-bounds query params with 400 (bounded at entry)", async () => {
    const s = await server();
    try {
      for (const qs of [
        "?limit=0",
        "?limit=501",
        "?since_height=-1",
        "?limit=abc",
        `?after_id=${"x".repeat(129)}`,
      ]) {
        const res = await fetch(`${s.baseUrl}${API_BASE}/internal/alert-facts/redemptions${qs}`, {
          headers: NOTIFIER,
        });
        expect(res.status, qs).toBe(400);
      }
    } finally {
      await s.close();
    }
  });
});

describe("internal alert-facts: incidents", () => {
  it("returns id + (kind, dedupe_key) identity with no payload passthrough", async () => {
    const s = await server();
    try {
      const { data } = await getData<Array<Record<string, unknown>>>(
        s,
        `${API_BASE}/internal/alert-facts/incidents`,
      );
      expect(data.map((r) => r.id)).toEqual([1, 2, 3]); // ascending by id
      expect(data[0]).toEqual({
        id: 1,
        kind: "vault_paused",
        severity: "critical",
        dedupe_key: "vault:1",
        opened_at: "2026-06-01T00:00:00.000Z",
        opened_height: 150,
      });
      // Height-less incident serves null, never a fabricated 0.
      expect(data[2]!.opened_height).toBeNull();
      // No `payload` field crosses the boundary.
      for (const row of data) expect("payload" in row).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("windows by the since_id cursor", async () => {
    const s = await server();
    try {
      const { data } = await getData<Array<{ id: number }>>(
        s,
        `${API_BASE}/internal/alert-facts/incidents?since_id=1`,
      );
      expect(data.map((r) => r.id)).toEqual([2, 3]); // 1 excluded (gt)
    } finally {
      await s.close();
    }
  });
});

describe("internal alert-facts: arrears", () => {
  it("returns latest-epoch arrears joined to the operator, excluding unregistered", async () => {
    const s = await server();
    try {
      const { data } = await getData<Array<Record<string, unknown>>>(
        s,
        `${API_BASE}/internal/alert-facts/arrears`,
      );
      // Only alpha (epoch 12, due 7, active). bravo is square (due 0); charlie
      // owes but is UNREGISTERED → excluded.
      expect(data).toEqual([
        { valoper: "pbvaloper1aaa", operator: "pb1opalpha", epoch_index: 12, commission_due: "7" },
      ]);
    } finally {
      await s.close();
    }
  });
});

describe("internal alert-facts: honest-empty (default dataless reader)", () => {
  it("every internal route serves an empty array with null heights", async () => {
    const s = await startServer({ assertionKey: TEST_ASSERTION_KEY }); // default emptyReader
    try {
      for (const path of [
        `${API_BASE}/internal/alert-facts/redemptions`,
        `${API_BASE}/internal/alert-facts/incidents`,
        `${API_BASE}/internal/alert-facts/arrears`,
      ]) {
        const res = await fetch(`${s.baseUrl}${path}`, { headers: NOTIFIER });
        expect(res.status, path).toBe(200);
        const body = (await res.json()) as { data: unknown[]; meta: { indexed_height: unknown } };
        expect(body.data, path).toEqual([]);
        expect(body.meta.indexed_height, path).toBeNull();
      }
    } finally {
      await s.close();
    }
  });
});
