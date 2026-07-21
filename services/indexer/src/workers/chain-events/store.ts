// Prisma-backed `Store` for the chain-events reducer, bound to one window's
// transaction client so every write lands inside the atomic `runWindow` (the
// cursor advance commits with the data). Amount columns are Decimal(39,0); we
// pass base-unit bigints as canonical integer strings and read them back as
// bigint — the JS-number boundary is never crossed (app-spec §13).
//
// The running marker NAV is persisted durably as a reserved `meta:` checkpoint
// row (no schema change): `meta:chain-events:nav` holds the latest NAV price in
// its `cursorPage` string. `meta:`-prefixed rows are markers, not worker
// cursors — lag accounting (PR 2.5) excludes them.

import type { Prisma } from "@prisma/client";
import type { RedemptionRow, Store, TransactionRow } from "./reduce.ts";

const NAV_MARKER_STREAM = "meta:chain-events:nav";

/** Prisma Decimal-ish -> bigint (Decimal(39,0) is always an integer). */
function toBigint(value: { toFixed(dp: number): string }): bigint {
  return BigInt(value.toFixed(0));
}

export class PrismaStore implements Store {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async readNav(): Promise<bigint> {
    const row = await this.tx.indexerCheckpoint.findUnique({ where: { stream: NAV_MARKER_STREAM } });
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
