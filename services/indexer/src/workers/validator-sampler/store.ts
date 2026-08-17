// Prisma-backed ValidatorStore, bound to one window's transaction client so the
// registry/epoch writes + departure marks commit atomically with the cursor
// (runWindow). Amounts are Decimal(39,0) — passed as canonical integer strings;
// heights are BigInt; failingReasons is a text[]; jailedEvents is JSONB.

import { Prisma } from "../../prisma.ts";
import type { EpochRow, RegistryRow, ValidatorStore } from "./write.ts";

export class PrismaValidatorStore implements ValidatorStore {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async upsertRegistry(row: RegistryRow): Promise<void> {
    await this.tx.validatorRegistry.upsert({
      where: { valoper: row.valoper },
      // enrolledAt set-once (only in create); re-appearance clears unregisteredAt.
      create: {
        valoper: row.valoper,
        operator: row.operator,
        moniker: row.moniker,
        enrolledAt: row.enrolledAt,
        unregisteredAt: null,
      },
      update: { operator: row.operator, moniker: row.moniker, unregisteredAt: null },
    });
  }

  async upsertEpoch(row: EpochRow): Promise<void> {
    const data = {
      uptimeBps: row.uptimeBps,
      eligible: row.eligible,
      failingReasons: row.failingReasons,
      tip: row.tip.toString(),
      commissionAccrued: row.commissionAccrued.toString(),
      commissionPaid: row.commissionPaid.toString(),
      commissionDue: row.commissionDue.toString(),
      programDelegation: row.programDelegation.toString(),
      jailedEvents:
        row.jailedEvents === null ? Prisma.DbNull : (row.jailedEvents as Prisma.InputJsonValue),
      height: row.height,
      observedAt: row.observedAt,
    };
    await this.tx.validatorEpoch.upsert({
      where: { valoper_epochIndex: { valoper: row.valoper, epochIndex: row.epochIndex } },
      create: { valoper: row.valoper, epochIndex: row.epochIndex, ...data },
      update: data,
    });
  }

  async enrolledValopers(): Promise<string[]> {
    const rows = await this.tx.validatorRegistry.findMany({
      where: { unregisteredAt: null },
      select: { valoper: true },
    });
    return rows.map((r) => r.valoper);
  }

  async markUnregistered(valoper: string, at: Date): Promise<void> {
    await this.tx.validatorRegistry.update({ where: { valoper }, data: { unregisteredAt: at } });
  }
}
