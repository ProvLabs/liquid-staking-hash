// The M6.4 operator surface (app-spec §8.6/§9.4, plan §2.2/§3 commit B).
//
// The cross-address gate (`test/cross-address.test.ts`) already holds these
// three routes: it is registry-derived, so they joined it automatically. What
// it CANNOT hold is the second boundary these routes add — the address→valoper
// ownership mapping — because that is not a scope mismatch: the assertion is
// valid and the address is its own, but the requested valoper belongs to
// somebody else. This suite is that gate, plus the §14.11 CSV contract.
//
// The leak-free posture is the point: a valoper the caller does not operate is
// answered honest-EMPTY, not 403. A 403 would confirm the valoper exists and
// belongs to another operator — an oracle on who operates what, over a surface
// whose whole purpose is that an operator sees only its own validators.

import { describe, expect, it } from "vitest";
import {
  API_BASE,
  OPERATOR_PAYMENTS_CSV_COLUMNS,
  bech32ValoperSchema,
  operatorPaymentsCsv,
} from "../src/index.ts";
import {
  paymentEpochIndex,
  resolveOwnedValoper,
  toOperatorPaymentRow,
  type OperatorPaymentFacts,
  type OperatorRegistryFacts,
} from "../src/derive.ts";
import { mintAssertion, TEST_ASSERTION_KEY } from "./assertions.ts";
import { startServer, type RunningServer } from "./helpers.ts";
import { fakeReader, type FakeFacts } from "./reader-fake.ts";

const OPERATOR_A = "pb1walletaqq";
const OPERATOR_B = "pb1walletzz2";
const VALOPER_A = "pbvaloper1walletaqq";
const VALOPER_A2 = "pbvaloper1walletaq2";
const VALOPER_B = "pbvaloper1walletzz2";

const auth = (address: string): Record<string, string> => ({
  authorization: mintAssertion(`address:${address}`),
});

/** Two operators, each with validators, so scoping is visible in the data. */
const facts: FakeFacts = {
  reconcilerRun: { chainHeight: 4242n, indexedHeight: 4200n },
  // Epoch boundaries: epoch 1 closes at height 100, epoch 2 at 200.
  epochs: [
    { epochIndex: 1n, endedAtSeconds: 1_700_000_000n, tvvAfter: 1_000n, totalShares: 1_000n, netAprBps: 500, endHeight: 100n },
    { epochIndex: 2n, endedAtSeconds: 1_700_100_000n, tvvAfter: 2_000n, totalShares: 1_000n, netAprBps: 600, endHeight: 200n },
  ],
  operatorRegistry: [
    { valoper: VALOPER_A, operator: OPERATOR_A, moniker: "alpha", enrolledAt: new Date("2026-01-01T00:00:00Z"), unregisteredAt: null },
    { valoper: VALOPER_A2, operator: OPERATOR_A, moniker: "beta", enrolledAt: new Date("2026-02-01T00:00:00Z"), unregisteredAt: new Date("2026-05-01T00:00:00Z") },
    { valoper: VALOPER_B, operator: OPERATOR_B, moniker: "gamma", enrolledAt: new Date("2026-03-01T00:00:00Z"), unregisteredAt: null },
  ],
  operatorEpochs: [
    { valoper: VALOPER_A, epochIndex: 1n, uptimeBps: 9_900, eligible: true, failingReasons: [], tip: 10n, commissionAccrued: 100n, commissionPaid: 100n, commissionDue: 0n, programDelegation: 5_000n, height: 100n, observedAt: new Date("2026-04-01T00:00:00Z") },
    { valoper: VALOPER_A, epochIndex: 2n, uptimeBps: 9_800, eligible: false, failingReasons: ["in_arrears"], tip: 20n, commissionAccrued: 300n, commissionPaid: 100n, commissionDue: 200n, programDelegation: 6_000n, height: 200n, observedAt: new Date("2026-05-01T00:00:00Z") },
    { valoper: VALOPER_B, epochIndex: 2n, uptimeBps: 9_700, eligible: true, failingReasons: [], tip: 99n, commissionAccrued: 900n, commissionPaid: 900n, commissionDue: 0n, programDelegation: 9_000n, height: 200n, observedAt: new Date("2026-05-01T00:00:00Z") },
  ],
  operatorPayments: [
    // Heights 50 and 100 fall in epoch 1 (closes at 100); 150 falls in epoch 2.
    { txhash: "P1", msgIndex: 0, valoper: VALOPER_A, payer: OPERATOR_A, paymentType: "commission", amount: 100n, height: 50n, occurredAt: new Date("2026-03-01T00:00:00Z") },
    { txhash: "P2", msgIndex: 1, valoper: VALOPER_A, payer: "pb1cooppartner", paymentType: "tip", amount: 20n, height: 100n, occurredAt: new Date("2026-03-02T00:00:00Z") },
    { txhash: "P3", msgIndex: 0, valoper: VALOPER_A, payer: OPERATOR_A, paymentType: "commission", amount: 7n, height: 150n, occurredAt: new Date("2026-04-02T00:00:00Z") },
    // Past the last indexed boundary (200): its crediting epoch is still open.
    { txhash: "P4", msgIndex: 0, valoper: VALOPER_A, payer: OPERATOR_A, paymentType: "tip", amount: 3n, height: 900n, occurredAt: new Date("2026-06-02T00:00:00Z") },
    { txhash: "PB", msgIndex: 0, valoper: VALOPER_B, payer: OPERATOR_B, paymentType: "commission", amount: 900n, height: 60n, occurredAt: new Date("2026-03-03T00:00:00Z") },
  ],
};

function startOperatorServer(over: Partial<FakeFacts> = {}): Promise<RunningServer> {
  return startServer({ assertionKey: TEST_ASSERTION_KEY }, undefined, fakeReader({ ...facts, ...over }));
}

async function json<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

describe("operator summary (address→valoper mapping enforced server-side)", () => {
  it("serves only the validators the asserted address operates", async () => {
    const server = await startOperatorServer();
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/operator/summary?address=${OPERATOR_A}`, {
        headers: auth(OPERATOR_A),
      });
      expect(res.status).toBe(200);
      const data = await json<{ address: string; validators: Array<Record<string, unknown>> }>(res);
      expect(data.address).toBe(OPERATOR_A);
      // alpha + beta, never gamma (operator B's) — moniker order.
      expect(data.validators.map((v) => v.valoper)).toEqual([VALOPER_A, VALOPER_A2]);
    } finally {
      await server.close();
    }
  });

  it("carries the latest epoch's economics and lifetime payment totals", async () => {
    const server = await startOperatorServer();
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/operator/summary?address=${OPERATOR_A}`, {
        headers: auth(OPERATOR_A),
      });
      const data = await json<{ validators: Array<Record<string, unknown>> }>(res);
      expect(data.validators[0]).toMatchObject({
        valoper: VALOPER_A,
        moniker: "alpha",
        operator: OPERATOR_A,
        active: true,
        unregistered_at: null,
        epoch_index: 2, // the LATEST sample, not the first
        uptime_bps: 9_800,
        eligible: false,
        failing_reasons: ["in_arrears"],
        commission_accrued: "300",
        commission_paid: "100",
        commission_due: "200",
        tip: "20",
        // 100 + 7 commission, 20 + 3 tip, 4 rows.
        commission_paid_total: "107",
        tip_paid_total: "23",
        payment_count: 4,
      });
    } finally {
      await server.close();
    }
  });

  it("reports null per-epoch fields and zero totals for a never-sampled validator", async () => {
    // beta has no validator_epochs row and no payments: null is the honest
    // "no sample yet" state, and "0" is an honest sum over zero rows.
    const server = await startOperatorServer();
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/operator/summary?address=${OPERATOR_A}`, {
        headers: auth(OPERATOR_A),
      });
      const data = await json<{ validators: Array<Record<string, unknown>> }>(res);
      expect(data.validators[1]).toMatchObject({
        valoper: VALOPER_A2,
        active: false,
        unregistered_at: "2026-05-01T00:00:00.000Z",
        epoch_index: null,
        uptime_bps: null,
        eligible: null,
        failing_reasons: [],
        program_delegation: null,
        commission_due: null,
        commission_paid_total: "0",
        tip_paid_total: "0",
        payment_count: 0,
      });
    } finally {
      await server.close();
    }
  });

  it("answers honest-empty for an address that operates nothing (no oracle)", async () => {
    const server = await startOperatorServer();
    try {
      const stranger = "pb1strangerqq";
      const res = await fetch(`${server.baseUrl}${API_BASE}/operator/summary?address=${stranger}`, {
        headers: auth(stranger),
      });
      expect(res.status).toBe(200);
      const data = await json<{ address: string; validators: unknown[] }>(res);
      expect(data).toEqual({ address: stranger, validators: [] });
    } finally {
      await server.close();
    }
  });

  it("omits peer context entirely (plan §7 Q5 not approved)", async () => {
    const server = await startOperatorServer();
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/operator/summary?address=${OPERATOR_A}`, {
        headers: auth(OPERATOR_A),
      });
      const data = await json<{ validators: Array<Record<string, unknown>> }>(res);
      for (const row of data.validators) {
        for (const forbidden of ["rank_by_tip", "eligible_count", "enrolled_count"]) {
          expect(Object.keys(row)).not.toContain(forbidden);
        }
      }
    } finally {
      await server.close();
    }
  });
});

describe("operator epochs + payments (ownership is enforced, not assumed)", () => {
  it("serves an owned valoper's epoch history newest first", async () => {
    const server = await startOperatorServer();
    try {
      const res = await fetch(
        `${server.baseUrl}${API_BASE}/operator/epochs?address=${OPERATOR_A}&valoper=${VALOPER_A}`,
        { headers: auth(OPERATOR_A) },
      );
      expect(res.status).toBe(200);
      const rows = await json<Array<Record<string, unknown>>>(res);
      expect(rows.map((r) => r.epoch_index)).toEqual([2, 1]);
      expect(rows[0]).toMatchObject({
        valoper: VALOPER_A,
        commission_due: "200",
        commission_accrued: "300",
        program_delegation: "6000",
        height: 200,
        observed_at: "2026-05-01T00:00:00.000Z",
      });
    } finally {
      await server.close();
    }
  });

  it("answers EMPTY — not 403 — when A asks for B's valoper", async () => {
    const server = await startOperatorServer();
    try {
      // A's own assertion, A's own address: the scope check passes. Only the
      // ownership mapping stands between the caller and another operator's
      // history, and it must not answer in a way that confirms VALOPER_B is
      // real and operated by somebody.
      for (const path of ["operator/epochs", "operator/payments"]) {
        const res = await fetch(
          `${server.baseUrl}${API_BASE}/${path}?address=${OPERATOR_A}&valoper=${VALOPER_B}`,
          { headers: auth(OPERATOR_A) },
        );
        expect(res.status, path).toBe(200);
        expect(await json<unknown[]>(res), path).toEqual([]);
      }
    } finally {
      await server.close();
    }
  });

  it("answers identically for a well-formed valoper that does not exist at all", async () => {
    // The indistinguishability that makes the previous case leak-free: an
    // unknown valoper and another operator's valoper produce the same answer.
    const server = await startOperatorServer();
    try {
      const ghost = "pbvaloper1ghqstqqq";
      const real = await fetch(
        `${server.baseUrl}${API_BASE}/operator/epochs?address=${OPERATOR_A}&valoper=${VALOPER_B}`,
        { headers: auth(OPERATOR_A) },
      );
      const fake = await fetch(
        `${server.baseUrl}${API_BASE}/operator/epochs?address=${OPERATOR_A}&valoper=${ghost}`,
        { headers: auth(OPERATOR_A) },
      );
      expect(real.status).toBe(fake.status);
      expect(await json<unknown[]>(real)).toEqual(await json<unknown[]>(fake));
    } finally {
      await server.close();
    }
  });

  it("bounds ?valoper= with the valoper schema — an ACCOUNT address is rejected", async () => {
    const server = await startOperatorServer();
    try {
      for (const bad of [OPERATOR_A, "NOT_BECH32", "pbvaloper1", "pbVALOPER1walletaqq"]) {
        const res = await fetch(
          `${server.baseUrl}${API_BASE}/operator/epochs?address=${OPERATOR_A}&valoper=${bad}`,
          { headers: auth(OPERATOR_A) },
        );
        expect(res.status, bad).toBe(400);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code, bad).toBe("invalid_query");
      }
    } finally {
      await server.close();
    }
  });

  it("serves payments newest first with the payer and the derived epoch", async () => {
    const server = await startOperatorServer();
    try {
      const res = await fetch(
        `${server.baseUrl}${API_BASE}/operator/payments?address=${OPERATOR_A}&valoper=${VALOPER_A}`,
        { headers: auth(OPERATOR_A) },
      );
      const rows = await json<Array<Record<string, unknown>>>(res);
      expect(rows.map((r) => r.txhash)).toEqual(["P4", "P3", "P2", "P1"]);
      expect(rows[3]).toMatchObject({
        txhash: "P1",
        payment_type: "commission",
        amount: "100",
        payer: OPERATOR_A,
        epoch_index: 1, // height 50 → epoch 1 (closes at 100)
      });
      // The permissionless-payment case Q6 kept the column for.
      expect(rows[2]).toMatchObject({ txhash: "P2", payer: "pb1cooppartner", epoch_index: 1 });
      // Height 150 lands in epoch 2 (closes at 200).
      expect(rows[1]).toMatchObject({ txhash: "P3", epoch_index: 2 });
      // Past the last closed epoch: null, never the latest epoch.
      expect(rows[0]).toMatchObject({ txhash: "P4", epoch_index: null });
    } finally {
      await server.close();
    }
  });
});

describe("operator CSV export (§14.11 pinned columns; [R3] freshness headers)", () => {
  it("serves text/csv with exactly the six decided columns", async () => {
    const server = await startOperatorServer();
    try {
      const res = await fetch(
        `${server.baseUrl}${API_BASE}/operator/payments?address=${OPERATOR_A}&valoper=${VALOPER_A}&format=csv`,
        { headers: auth(OPERATOR_A) },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/csv/);
      expect(res.headers.get("content-disposition")).toContain("operator-payments.csv");
      expect(res.headers.get("x-chain-height")).toBe("4242");
      expect(res.headers.get("x-indexed-height")).toBe("4200");
      expect(res.headers.get("x-generated-at")).not.toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");

      const lines = (await res.text()).trimEnd().split("\n");
      expect(lines[0]).toBe("datetime_utc,block_height,epoch_index,payment_type,hash_amount,txhash");
      expect(lines[0]).toBe(OPERATOR_PAYMENTS_CSV_COLUMNS.join(","));
      // Ascending by (height, msg_index) — a statement of fact reads forward.
      expect(lines[1]).toBe("2026-03-01T00:00:00.000Z,50,1,commission,100,P1");
      expect(lines[2]).toBe("2026-03-02T00:00:00.000Z,100,1,tip,20,P2");
      expect(lines[3]).toBe("2026-04-02T00:00:00.000Z,150,2,commission,7,P3");
      // Open crediting epoch → EMPTY cell, never a guessed epoch.
      expect(lines[4]).toBe("2026-06-02T00:00:00.000Z,900,,tip,3,P4");
    } finally {
      await server.close();
    }
  });

  it("never carries `payer` — the column set is pinned by §14.11, not by the row", async () => {
    const server = await startOperatorServer();
    try {
      const res = await fetch(
        `${server.baseUrl}${API_BASE}/operator/payments?address=${OPERATOR_A}&valoper=${VALOPER_A}&format=csv`,
        { headers: auth(OPERATOR_A) },
      );
      const body = await res.text();
      expect(body).not.toContain("payer");
      expect(body).not.toContain("pb1cooppartner");
    } finally {
      await server.close();
    }
  });

  it("exports the COMPLETE history, ignoring the JSON pagination bounds", async () => {
    // More rows than the JSON `limit` ceiling (200): an export that inherited
    // that bound would silently drop an operator's older payments.
    const ROWS = 260;
    const many: OperatorPaymentFacts[] = Array.from({ length: ROWS }, (_, i) => ({
      txhash: `TX${i}`,
      msgIndex: 0,
      valoper: VALOPER_A,
      payer: OPERATOR_A,
      paymentType: i % 2 === 0 ? ("commission" as const) : ("tip" as const),
      amount: BigInt(i + 1),
      height: BigInt(i + 1),
      occurredAt: new Date((1_700_000_000 + i) * 1000),
    }));
    const server = await startOperatorServer({ operatorPayments: many });
    try {
      const csv = await fetch(
        `${server.baseUrl}${API_BASE}/operator/payments?address=${OPERATOR_A}&valoper=${VALOPER_A}&format=csv`,
        { headers: auth(OPERATOR_A) },
      );
      const lines = (await csv.text()).trimEnd().split("\n");
      expect(lines).toHaveLength(ROWS + 1); // header + every row, none truncated
      expect(lines[1]!.split(",")[5]).toBe("TX0");
      expect(lines[ROWS]!.split(",")[5]).toBe(`TX${ROWS - 1}`);

      // The JSON view still paginates at the schema ceiling.
      const json200 = await fetch(
        `${server.baseUrl}${API_BASE}/operator/payments?address=${OPERATOR_A}&valoper=${VALOPER_A}&limit=200`,
        { headers: auth(OPERATOR_A) },
      );
      expect(((await json200.json()) as { data: unknown[] }).data).toHaveLength(200);
    } finally {
      await server.close();
    }
  });

  it("requires the same authorization and ownership as the JSON view", async () => {
    const server = await startOperatorServer();
    try {
      const bare = await fetch(
        `${server.baseUrl}${API_BASE}/operator/payments?address=${OPERATOR_A}&valoper=${VALOPER_A}&format=csv`,
      );
      expect(bare.status).toBe(401);
      const cross = await fetch(
        `${server.baseUrl}${API_BASE}/operator/payments?address=${OPERATOR_B}&valoper=${VALOPER_B}&format=csv`,
        { headers: auth(OPERATOR_A) },
      );
      expect(cross.status).toBe(403);
      // A's own scope, B's valoper: header only, no rows.
      const unowned = await fetch(
        `${server.baseUrl}${API_BASE}/operator/payments?address=${OPERATOR_A}&valoper=${VALOPER_B}&format=csv`,
        { headers: auth(OPERATOR_A) },
      );
      expect(unowned.status).toBe(200);
      expect((await unowned.text()).trimEnd().split("\n")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("guards formula injection in every operator CSV field", () => {
    const rendered = operatorPaymentsCsv([
      {
        // A formula lead AND a comma: the guard prefixes, then RFC-4180
        // quoting wraps, so neither a spreadsheet nor a parser is fooled.
        txhash: "=SUM(A1,A9)",
        msg_index: 0,
        valoper: VALOPER_A,
        payer: OPERATOR_A,
        payment_type: "commission",
        amount: "1",
        epoch_index: 1,
        height: 1,
        occurred_at: "@2026-01-01",
      },
    ]);
    const row = rendered.trimEnd().split("\n")[1]!;
    // Leading `@` guarded on the first field…
    expect(row.startsWith("'@2026-01-01,")).toBe(true);
    // …and the comma-bearing formula guarded AND quoted, so it stays one field.
    expect(row.endsWith(`"'=SUM(A1,A9)"`)).toBe(true);
  });
});

describe("pure ownership + epoch-assignment rules", () => {
  const owned: OperatorRegistryFacts[] = [
    { valoper: VALOPER_A, operator: OPERATOR_A, moniker: "alpha", enrolledAt: new Date(0), unregisteredAt: null },
  ];

  it("resolveOwnedValoper returns the valoper only when it is in the owned set", () => {
    expect(resolveOwnedValoper(owned, VALOPER_A)).toBe(VALOPER_A);
    expect(resolveOwnedValoper(owned, VALOPER_B)).toBeNull();
    expect(resolveOwnedValoper([], VALOPER_A)).toBeNull();
  });

  it("an UNREGISTERED validator is still owned — history does not disappear", () => {
    // Registry rows are never deleted; unregistering ends participation, not
    // the operator's right to its own past economics and payment record.
    const past: OperatorRegistryFacts[] = [
      { valoper: VALOPER_A2, operator: OPERATOR_A, moniker: "beta", enrolledAt: new Date(0), unregisteredAt: new Date(1) },
    ];
    expect(resolveOwnedValoper(past, VALOPER_A2)).toBe(VALOPER_A2);
  });

  it("paymentEpochIndex picks the FIRST epoch closing at or after the height", () => {
    const boundaries = [
      { epochIndex: 1n, endHeight: 100n },
      { epochIndex: 2n, endHeight: 200n },
      { epochIndex: 3n, endHeight: 300n },
    ];
    expect(paymentEpochIndex(1n, boundaries)).toBe(1n);
    expect(paymentEpochIndex(100n, boundaries)).toBe(1n); // closes AT the height
    expect(paymentEpochIndex(101n, boundaries)).toBe(2n);
    expect(paymentEpochIndex(300n, boundaries)).toBe(3n);
    // Past every closed epoch: the crediting epoch is still open.
    expect(paymentEpochIndex(301n, boundaries)).toBeNull();
    // No epoch has closed at all.
    expect(paymentEpochIndex(1n, [])).toBeNull();
  });

  it("toOperatorPaymentRow surfaces a null epoch rather than the latest one", () => {
    const fact: OperatorPaymentFacts = {
      txhash: "X",
      msgIndex: 0,
      valoper: VALOPER_A,
      payer: OPERATOR_A,
      paymentType: "tip",
      amount: 5n,
      height: 9_999n,
      occurredAt: new Date("2026-07-01T00:00:00Z"),
    };
    expect(toOperatorPaymentRow(fact, [{ epochIndex: 1n, endHeight: 100n }])).toMatchObject({
      epoch_index: null,
      amount: "5",
    });
  });

  it("bech32ValoperSchema separates valoper addresses from account addresses", () => {
    expect(bech32ValoperSchema.safeParse(VALOPER_A).success).toBe(true);
    expect(bech32ValoperSchema.safeParse("tpvaloper1l39wu7cht0zcycc5rkcd90sdd4ksjmxwjqvnjp").success).toBe(true);
    expect(bech32ValoperSchema.safeParse(OPERATOR_A).success).toBe(false);
    expect(bech32ValoperSchema.safeParse("pbvaloper1UPPER").success).toBe(false);
    expect(bech32ValoperSchema.safeParse(`pbvaloper1${"q".repeat(100)}`).success).toBe(false);
  });
});
