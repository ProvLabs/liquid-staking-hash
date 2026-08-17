// Prisma-backed `Store` for the chain-events reducer, bound to one window's
// transaction client so every write lands inside the atomic `runWindow` (the
// cursor advance commits with the data). Amount columns are Decimal(39,0); we
// pass base-unit bigints as canonical integer strings and read them back as
// bigint — the JS-number boundary is never crossed (app-spec §13).
//
// The running marker NAV is persisted durably as a reserved `meta:` checkpoint
// row (no schema change): `meta:chain-events:nav` holds the latest NAV price in
// its `cursorPage` string. `meta:`-prefixed rows are markers, not worker
// cursors — lag accounting excludes them.

import type { Prisma } from "../../prisma.ts";
import type { OperatorPaymentRow, RedemptionRow, Store, TransactionRow } from "./reduce.ts";

const NAV_MARKER_STREAM = "meta:chain-events:nav";

/** Prisma Decimal-ish -> bigint (Decimal(39,0) is always an integer). */
function toBigint(value: { toFixed(dp: number): string }): bigint {
  return BigInt(value.toFixed(0));
}

export class PrismaStore implements Store {
  /** Addresses whose transactions this window touched — the bounded input of
   * the holder-lifecycle refresh (PR 8.2 commit D). */
  private readonly touchedAddresses = new Set<string>();

  constructor(private readonly tx: Prisma.TransactionClient) {}

  /**
   * Recompute `holder_lifecycles` for the addresses this window touched — a
   * recompute-from-truth over `transactions`, inside the window transaction,
   * so replay from 0 equals resume and re-apply is idempotent. Equality-gated
   * by test/integration/holder-lifecycle-materialization.test.ts.
   *
   * Delta convention matches derivePortfolioMetrics; exit = first height
   * at/after the first deposit where the running total reaches zero. No
   * `swap_in` yet = no row; the anti-join delete covers a replayed window
   * re-deriving an address out of existence.
   */
  async refreshHolderLifecycles(): Promise<void> {
    if (this.touchedAddresses.size === 0) return;
    const addresses = [...this.touchedAddresses];
    await this.tx.$executeRaw`
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
        WHERE "address" = ANY(${addresses})
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
        WHERE "kind" = 'swap_in' AND "address" = ANY(${addresses})
        GROUP BY "address"
      ),
      exited AS (
        SELECT r."address", MIN(r."height") AS exit_height
        FROM running r
        JOIN first_deposit f ON f."address" = r."address"
        WHERE r."height" >= f.first_height AND r.position <= 0
        GROUP BY r."address"
      )
      INSERT INTO "indexed"."holder_lifecycles" ("address", "firstDepositHeight", "exitHeight")
      SELECT f."address", f.first_height, e.exit_height
      FROM first_deposit f
      LEFT JOIN exited e ON e."address" = f."address"
      ON CONFLICT ("address") DO UPDATE
        SET "firstDepositHeight" = EXCLUDED."firstDepositHeight",
            "exitHeight" = EXCLUDED."exitHeight"`;
    this.touchedAddresses.clear();
  }

  async readNav(): Promise<bigint> {
    const row = await this.tx.indexerCheckpoint.findUnique({
      where: { stream: NAV_MARKER_STREAM },
    });
    return row?.cursorPage ? BigInt(row.cursorPage) : 0n;
  }

  async writeNav(nav: bigint): Promise<void> {
    const cursorPage = nav.toString();
    await this.tx.indexerCheckpoint.upsert({
      where: { stream: NAV_MARKER_STREAM },
      create: { stream: NAV_MARKER_STREAM, cursorHeight: 0n, cursorPage },
      update: { cursorPage },
    });
  }

  async getRedemption(requestId: string): Promise<RedemptionRow | null> {
    const row = await this.tx.redemptionRequest.findUnique({ where: { requestId } });
    if (!row) return null;
    return {
      requestId: row.requestId,
      owner: row.owner,
      shares: toBigint(row.shares),
      status: row.status,
      enqueuedAt: row.enqueuedAt,
      expeditedAt: row.expeditedAt,
      maturedAt: row.maturedAt,
      refundedAt: row.refundedAt,
      lastHeight: row.lastHeight,
      lastTxhash: row.lastTxhash,
    };
  }

  async upsertTransaction(row: TransactionRow): Promise<void> {
    this.touchedAddresses.add(row.address);
    const data = {
      address: row.address,
      kind: row.kind,
      shares: row.shares.toString(),
      nhash: row.nhash.toString(),
      navAtHeight: row.navAtHeight.toString(),
      height: row.height,
      blockTime: row.blockTime,
    };
    await this.tx.transaction.upsert({
      where: { txhash_msgIndex: { txhash: row.txhash, msgIndex: row.msgIndex } },
      create: { txhash: row.txhash, msgIndex: row.msgIndex, ...data },
      update: data,
    });
  }

  async upsertOperatorPayment(row: OperatorPaymentRow): Promise<void> {
    const data = {
      valoper: row.valoper,
      payer: row.payer,
      paymentType: row.paymentType,
      amount: row.amount.toString(),
      epochIndex: row.epochIndex,
      height: row.height,
      occurredAt: row.occurredAt,
    };
    // Keyed on the FULL natural key: a message that batches several payments
    // produces siblings sharing (txhash, msgIndex), and keying on that pair
    // alone made each one overwrite the last.
    await this.tx.operatorPayment.upsert({
      where: {
        txhash_msgIndex_ordinal: {
          txhash: row.txhash,
          msgIndex: row.msgIndex,
          ordinal: row.ordinal,
        },
      },
      create: { txhash: row.txhash, msgIndex: row.msgIndex, ordinal: row.ordinal, ...data },
      update: data,
    });
  }

  async upsertRedemption(row: RedemptionRow): Promise<void> {
    const data = {
      owner: row.owner,
      shares: row.shares.toString(),
      status: row.status,
      enqueuedAt: row.enqueuedAt,
      expeditedAt: row.expeditedAt,
      maturedAt: row.maturedAt,
      refundedAt: row.refundedAt,
      lastHeight: row.lastHeight,
      lastTxhash: row.lastTxhash,
    };
    await this.tx.redemptionRequest.upsert({
      where: { requestId: row.requestId },
      create: { requestId: row.requestId, ...data },
      update: data,
    });
  }
}
