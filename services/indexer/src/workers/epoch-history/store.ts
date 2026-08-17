// Prisma-backed EpochStore, bound to one window's transaction client so the
// upsert commits atomically with the cursor advance (runWindow). Amount columns
// are Decimal(39,0): base-unit bigints are passed as canonical integer strings;
// heights/seconds/epoch index are BigInt columns.

import type { Prisma } from "../../prisma.ts";
import type { EpochRow } from "./snapshot.ts";
import type { EpochStore } from "./write.ts";

export class PrismaEpochStore implements EpochStore {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async upsertEpoch(row: EpochRow): Promise<void> {
    const data = {
      startedAtSeconds: row.startedAtSeconds,
      endedAtSeconds: row.endedAtSeconds,
      endHeight: row.endHeight,
      tvvBefore: row.tvvBefore.toString(),
      tvvAfter: row.tvvAfter.toString(),
      totalShares: row.totalShares.toString(),
      rewardsClaimed: row.rewardsClaimed.toString(),
      commissionReceived: row.commissionReceived.toString(),
      tipsReceived: row.tipsReceived.toString(),
      rewardsDeposited: row.rewardsDeposited.toString(),
      settled: row.settled.toString(),
      writeDown: row.writeDown.toString(),
      deployed: row.deployed.toString(),
      rebalanced: row.rebalanced.toString(),
      unbondedForRedemptions: row.unbondedForRedemptions.toString(),
      aumFeeEstimate: row.aumFeeEstimate.toString(),
      netDeposits: row.netDeposits.toString(),
      redemptionsExpedited: row.redemptionsExpedited,
      validatorsPurged: row.validatorsPurged,
      eligibleCount: row.eligibleCount,
      grossAprBps: row.grossAprBps,
      netAprBps: row.netAprBps,
      txhash: row.txhash,
      height: row.height,
      observedAt: row.observedAt,
    };
    await this.tx.epochSnapshot.upsert({
      where: { epochIndex: row.epochIndex },
      create: { epochIndex: row.epochIndex, ...data },
      update: data,
    });
  }
}
