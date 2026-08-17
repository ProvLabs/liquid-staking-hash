// operator_payments round-trip — the database gate. The unit
// suites prove the DECODE (fixture shapes) and the CONVERGENCE (pure reducer
// over an in-memory store); this proves the third leg neither can: that the
// row survives real Postgres unchanged.
//
// What it holds:
//   * amount discipline (app-spec §5.8) — a full Uint128-scale nhash amount
//     goes in as a bigint and comes back the same bigint, never rounded
//     through a JS number by the Decimal(39,0) column;
//   * idempotency at the STORAGE layer — re-applying the same window upserts
//     on (txhash, msgIndex, ordinal) instead of duplicating, so a replay
//     converges in
//     the database and not only in the reducer;
//   * `epochIndex` really is null at ingest (services/api derives it by
//     joining `epoch_snapshots` — see prisma/operator_payments.prisma).
//
// Runs in the app-ci `db-grants` job (Postgres service) alongside the
// grant-boundary and reconciler-alarm gates; brings its own Prisma client.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/prisma.ts";
import { applyEvents } from "../../src/workers/chain-events/reduce.ts";
import { PrismaStore } from "../../src/workers/chain-events/store.ts";
import type { DomainEvent } from "../../src/workers/chain-events/events.ts";

const URL =
  process.env.DATABASE_URL ??
  process.env.ADMIN_DATABASE_URL ??
  "postgresql://nvhash:nvhash-dev@postgres:5432/nvhash?schema=indexed";

const prisma = new PrismaClient({ datasources: { db: { url: URL } } });

// Distinctive hashes so cleanup is surgical on a shared dev/CI database.
const TX_COMMISSION = "M64TESTCOMMISSION";
const TX_TIP = "M64TESTTIP";
const VALOPER = "tpvaloper1m64roundtrip";

// A deliberately huge amount: 39 digits is the column's full precision, so a
// value that survives this cannot have gone through a double.
const BIG_AMOUNT = 10n ** 38n - 1n;

const events: DomainEvent[] = [
  {
    kind: "operator_payment",
    ordinal: 0,
    paymentType: "commission",
    valoper: VALOPER,
    payer: "tp1m64payer",
    amount: BIG_AMOUNT,
    height: 4242n,
    blockTime: new Date("2026-07-27T16:13:19.000Z"),
    txhash: TX_COMMISSION,
    msgIndex: 0,
  },
  {
    kind: "operator_payment",
    ordinal: 0,
    paymentType: "tip",
    valoper: VALOPER,
    payer: "tp1m64otherpayer",
    amount: 2_750_000_000n,
    height: 4243n,
    blockTime: new Date("2026-07-27T16:13:25.000Z"),
    txhash: TX_TIP,
    msgIndex: 1,
  },
];

async function cleanup(): Promise<void> {
  await prisma.operatorPayment.deleteMany({ where: { valoper: VALOPER } });
}

/** Run one window exactly as production does: the reducer over PrismaStore,
 * inside the transaction `runWindow` would open. */
async function applyWindow(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await applyEvents(new PrismaStore(tx), events);
  });
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("operator_payments round-trip (M6.4 §2.1)", () => {
  it("stores both payment types with byte-exact amounts and a null ingest epoch", async () => {
    await applyWindow();

    const rows = await prisma.operatorPayment.findMany({
      where: { valoper: VALOPER },
      orderBy: { height: "asc" },
    });
    expect(rows).toHaveLength(2);

    expect(rows[0]).toMatchObject({
      txhash: TX_COMMISSION,
      msgIndex: 0,
      valoper: VALOPER,
      payer: "tp1m64payer",
      paymentType: "commission",
      epochIndex: null,
      height: 4242n,
    });
    // The whole point: a 38-digit amount returns identical, not rounded.
    expect(BigInt(rows[0]!.amount.toFixed(0))).toBe(BIG_AMOUNT);
    expect(rows[0]!.occurredAt.toISOString()).toBe("2026-07-27T16:13:19.000Z");

    expect(rows[1]).toMatchObject({
      txhash: TX_TIP,
      msgIndex: 1,
      payer: "tp1m64otherpayer",
      paymentType: "tip",
      epochIndex: null,
      height: 4243n,
    });
    expect(BigInt(rows[1]!.amount.toFixed(0))).toBe(2_750_000_000n);
  });

  it("re-applying the same window upserts on (txhash, msgIndex) — no duplicates", async () => {
    await applyWindow();
    await applyWindow();

    const rows = await prisma.operatorPayment.findMany({ where: { valoper: VALOPER } });
    expect(rows).toHaveLength(2);
    expect(BigInt(rows.find((r) => r.txhash === TX_COMMISSION)!.amount.toFixed(0))).toBe(
      BIG_AMOUNT,
    );
  });

  it("keeps BATCHED siblings as distinct rows, not one overwriting the other", async () => {
    // Review, third P1. A message that batches several payments emits
    // siblings sharing (txhash, msgIndex); under the old two-part key each one
    // upserted onto the previous row, so the operator's history, lifetime
    // totals and §14.11 CSV would show ONE payment where several occurred —
    // silently, with nothing logged. The ordinal completes the natural key.
    const TX_BATCH = "M64TESTBATCH";
    const batched: DomainEvent[] = [0, 1, 2].map((ordinal) => ({
      kind: "operator_payment",
      ordinal,
      paymentType: "tip",
      valoper: VALOPER,
      payer: "tp1m64batcher",
      amount: BigInt(100 + ordinal),
      height: 5000n,
      blockTime: new Date("2026-07-28T00:00:00.000Z"),
      txhash: TX_BATCH,
      msgIndex: 0,
    }));

    await prisma.$transaction(async (tx) => {
      await applyEvents(new PrismaStore(tx), batched);
    });

    const rows = await prisma.operatorPayment.findMany({
      where: { txhash: TX_BATCH },
      orderBy: { ordinal: "asc" },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => BigInt(r.amount.toFixed(0)))).toEqual([100n, 101n, 102n]);

    // And re-applying the same batch still converges — idempotency must hold
    // per SIBLING, not just per message.
    await prisma.$transaction(async (tx) => {
      await applyEvents(new PrismaStore(tx), batched);
    });
    expect(await prisma.operatorPayment.count({ where: { txhash: TX_BATCH } })).toBe(3);

    await prisma.operatorPayment.deleteMany({ where: { txhash: TX_BATCH } });
  });
});
