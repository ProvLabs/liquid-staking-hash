// Prisma reads/writes for the reconciler. Reads assemble the IndexedPlane the
// pure `deriveActions` consumes; `applyActions` writes the reconciler_run and
// opens/closes incidents in ONE transaction (the run and its linked divergence
// incident move together). The reconciler is the SOLE writer of `incidents`
// (app-spec §9.6).

import { Prisma, type PrismaClient } from "@prisma/client";
import type { IndexedPlane, ReconcileActions } from "./incidents.ts";

function toBig(value: { toFixed(dp: number): string }): bigint {
  return BigInt(value.toFixed(0));
}

/** Read the indexed plane; `chainEpoch` is the chain's latest epoch (or null). */
export async function readIndexedPlane(prisma: PrismaClient, chainEpoch: bigint | null): Promise<IndexedPlane> {
  const maxRow = await prisma.epochSnapshot.findFirst({
    orderBy: { epochIndex: "desc" },
    select: { epochIndex: true },
  });
  const chainEpochRow =
    chainEpoch === null
      ? null
      : await prisma.epochSnapshot.findUnique({
          where: { epochIndex: chainEpoch },
          select: { totalShares: true, tvvAfter: true },
        });
  const checkpoints = await prisma.indexerCheckpoint.findMany({ select: { stream: true, cursorHeight: true } });
  const writeDownRows = await prisma.epochSnapshot.findMany({
    where: { writeDown: { gt: 0 } },
    select: { epochIndex: true },
  });
  const refunded = await prisma.redemptionRequest.findMany({
    where: { status: "refunded" },
    select: { requestId: true },
  });
  // Point-in-time incidents already recorded — so we open only new facts each
  // pass, not the whole lifetime history (bounded per-pass write work).
  const existing = await prisma.incident.findMany({
    where: { kind: { in: ["slash_write_down", "redemption_refund"] } },
    select: { kind: true, dedupeKey: true },
  });

  return {
    maxEpoch: maxRow?.epochIndex ?? null,
    chainEpochRow: chainEpochRow
      ? { totalShares: toBig(chainEpochRow.totalShares), tvvAfter: toBig(chainEpochRow.tvvAfter) }
      : null,
    checkpoints: checkpoints.map((c) => ({ stream: c.stream, cursorHeight: c.cursorHeight })),
    writeDownEpochs: writeDownRows.map((r) => r.epochIndex),
    refundedRequestIds: refunded.map((r) => r.requestId),
    existingPointInTimeKeys: new Set(existing.map((i) => `${i.kind} ${i.dedupeKey}`)),
  };
}

/** Apply the derived actions: open/close incidents + write the run, atomically. */
export async function applyActions(prisma: PrismaClient, actions: ReconcileActions): Promise<void> {
  await prisma.$transaction(async (tx) => {
    let divergenceIncidentId: bigint | null = null;

    for (const o of actions.open) {
      const row = await tx.incident.upsert({
        where: { kind_dedupeKey: { kind: o.kind, dedupeKey: o.dedupeKey } },
        create: {
          kind: o.kind,
          severity: o.severity,
          dedupeKey: o.dedupeKey,
          openedAt: actions.run.ranAt,
          openedHeight: o.openedHeight,
          payload: o.payload as Prisma.InputJsonValue,
        },
        // Reopen (clear closedAt) and refresh severity/payload; keep openedAt.
        update: { severity: o.severity, closedAt: null, payload: o.payload as Prisma.InputJsonValue },
        select: { id: true },
      });
      if (o.linkToRun) divergenceIncidentId = row.id;
    }

    for (const c of actions.close) {
      await tx.incident.updateMany({
        where: { kind: c.kind, dedupeKey: c.dedupeKey, closedAt: null },
        data: { closedAt: actions.run.ranAt },
      });
    }

    await tx.reconcilerRun.create({
      data: {
        ranAt: actions.run.ranAt,
        chainHeight: actions.run.chainHeight,
        indexedHeight: actions.run.indexedHeight,
        deltas: actions.run.deltas as Prisma.InputJsonValue,
        withinTolerance: actions.run.withinTolerance,
        incidentId: divergenceIncidentId,
      },
    });
  });
}
