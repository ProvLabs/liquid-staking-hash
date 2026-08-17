// The C7 equality gate for the materialized holder-lifecycle fold (8.2 commit
// D): the truth is computed BOTH ways against real Postgres — the maintained
// `holder_lifecycles` table versus the original window-function fold over the
// same `transactions` rows — so breaking the maintenance SQL fails an
// assertion an in-memory double cannot green (the M7.5–7.6 round-4 lesson).
// Runs in the `test:grants` job (Postgres service), never the DB-free suite.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/prisma.ts";
import { PrismaStore } from "../../src/workers/chain-events/store.ts";

const URL =
  process.env.DATABASE_URL ??
  process.env.ADMIN_DATABASE_URL ??
  "postgresql://nvhash:nvhash-dev@postgres:5432/nvhash?schema=indexed";

const prisma = new PrismaClient({ datasources: { db: { url: URL } } });

// A distinctive prefix so cleanup is surgical on a shared dev/CI database.
const P = "pb1lifecyclegate";
const A_HOLDS = `${P}qqqqqqqqqqqqqqqqqqqqqq`; // deposits, never exits
const A_EXITS = `${P}wwwwwwwwwwwwwwwwwwwwww`; // deposits, fully exits
const A_REJOINS = `${P}eeeeeeeeeeeeeeeeeeeeee`; // exits, then deposits again
const A_TRANSFER = `${P}rrrrrrrrrrrrrrrrrrrrrr`; // transfer-in only: NO row

interface TxSeed {
  txhash: string;
  address: string;
  kind: "swap_in" | "redemption_payout" | "transfer_in" | "transfer_out" | "swap_out_request";
  shares: bigint;
  height: bigint;
}

const TXS: TxSeed[] = [
  { txhash: "LG1", address: A_HOLDS, kind: "swap_in", shares: 100n, height: 10n },
  { txhash: "LG2", address: A_EXITS, kind: "swap_in", shares: 50n, height: 11n },
  // Escrow moves are net zero on the TOTAL position (the delta convention):
  { txhash: "LG3", address: A_EXITS, kind: "swap_out_request", shares: 50n, height: 12n },
  { txhash: "LG4", address: A_EXITS, kind: "redemption_payout", shares: 50n, height: 13n },
  { txhash: "LG5", address: A_REJOINS, kind: "swap_in", shares: 30n, height: 14n },
  { txhash: "LG6", address: A_REJOINS, kind: "transfer_out", shares: 30n, height: 15n },
  { txhash: "LG7", address: A_REJOINS, kind: "swap_in", shares: 10n, height: 16n },
  // A transfer-in with NO deposit ever: the fold yields no row (absence is
  // the unknown state, not a null-height fabrication).
  { txhash: "LG8", address: A_TRANSFER, kind: "transfer_in", shares: 5n, height: 17n },
];

const ADDRESSES = [A_HOLDS, A_EXITS, A_REJOINS, A_TRANSFER];

/** The ORIGINAL window-function fold, scoped to the gate's addresses — the
 * independent truth the maintained table is held to. */
async function foldTruth(): Promise<
  Array<{ address: string; firstDepositHeight: bigint; exitHeight: bigint | null }>
> {
  return prisma.$queryRaw`
    WITH deltas AS (
      SELECT "address", "height", "msgIndex",
             CASE "kind"
               WHEN 'swap_in'           THEN "shares"
               WHEN 'transfer_in'       THEN "shares"
               WHEN 'redemption_payout' THEN -"shares"
               WHEN 'transfer_out'      THEN -"shares"
               ELSE 0
             END AS delta
      FROM "indexed"."transactions"
      WHERE "address" = ANY(${ADDRESSES})
    ),
    running AS (
      SELECT "address", "height",
             SUM(delta) OVER (
               PARTITION BY "address" ORDER BY "height", "msgIndex"
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS position
      FROM deltas
    ),
    first_deposit AS (
      SELECT "address", MIN("height") AS first_height
      FROM "indexed"."transactions"
      WHERE "kind" = 'swap_in' AND "address" = ANY(${ADDRESSES})
      GROUP BY "address"
    ),
    exited AS (
      SELECT r."address", MIN(r."height") AS exit_height
      FROM running r
      JOIN first_deposit f ON f."address" = r."address"
      WHERE r."height" >= f.first_height AND r.position <= 0
      GROUP BY r."address"
    )
    SELECT f."address", f.first_height AS "firstDepositHeight", e.exit_height AS "exitHeight"
    FROM first_deposit f
    LEFT JOIN exited e ON e."address" = f."address"
    ORDER BY f."address" ASC`;
}

async function cleanup(): Promise<void> {
  await prisma.holderLifecycle.deleteMany({ where: { address: { startsWith: P } } });
  await prisma.transaction.deleteMany({ where: { address: { startsWith: P } } });
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1 FROM indexed.holder_lifecycles LIMIT 1`.catch(
    (cause: unknown) => {
      throw new Error(
        `indexed.holder_lifecycles is absent — run the indexer migration (migrate:deploy) ` +
          `before this test. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    },
  );
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("holder-lifecycle materialization equality (8.2 commit D)", () => {
  it("the maintained table equals the window-function fold over the same rows", async () => {
    // Apply through the REAL store + refresh, the way the worker's write
    // phase does, inside one transaction (the production shape).
    await prisma.$transaction(async (tx) => {
      const store = new PrismaStore(tx);
      for (const seed of TXS) {
        await store.upsertTransaction({
          txhash: seed.txhash,
          msgIndex: 0,
          address: seed.address,
          kind: seed.kind,
          shares: seed.shares,
          nhash: 0n,
          navAtHeight: 10_000n,
          height: seed.height,
          blockTime: new Date(Number(seed.height) * 1000),
        });
      }
      await store.refreshHolderLifecycles();
    });

    const table = await prisma.holderLifecycle.findMany({
      where: { address: { startsWith: P } },
      orderBy: { address: "asc" },
    });
    const truth = await foldTruth();
    expect(
      table.map((r) => ({
        address: r.address,
        firstDepositHeight: r.firstDepositHeight,
        exitHeight: r.exitHeight,
      })),
    ).toEqual(truth);

    // The semantic spot checks, so a both-ways-wrong SQL cannot pass quietly:
    const byAddress = new Map(table.map((r) => [r.address, r]));
    expect(byAddress.get(A_HOLDS)?.exitHeight).toBeNull(); // still holding
    expect(byAddress.get(A_EXITS)?.exitHeight).toBe(13n); // payout emptied it
    // Re-entry after a full exit: first deposit stays the FIRST one; the exit
    // recorded is the first zero-crossing (the fold's contract).
    expect(byAddress.get(A_REJOINS)?.firstDepositHeight).toBe(14n);
    expect(byAddress.get(A_REJOINS)?.exitHeight).toBe(15n);
    expect(byAddress.has(A_TRANSFER)).toBe(false); // no deposit → no row
  });

  it("re-applying the same window converges (replay idempotence)", async () => {
    await prisma.$transaction(async (tx) => {
      const store = new PrismaStore(tx);
      for (const seed of TXS) {
        await store.upsertTransaction({
          txhash: seed.txhash,
          msgIndex: 0,
          address: seed.address,
          kind: seed.kind,
          shares: seed.shares,
          nhash: 0n,
          navAtHeight: 10_000n,
          height: seed.height,
          blockTime: new Date(Number(seed.height) * 1000),
        });
      }
      await store.refreshHolderLifecycles();
    });
    const table = await prisma.holderLifecycle.findMany({
      where: { address: { startsWith: P } },
    });
    expect(table).toHaveLength(3); // A_TRANSFER still has no row
    expect(await foldTruth()).toHaveLength(3);
  });
});
