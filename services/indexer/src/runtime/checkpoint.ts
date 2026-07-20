// The atomic block-window helper — the SINGLE place the app-spec §9.2 invariant
// "the cursor advances only after the full block window commits in one DB
// transaction" is enforced. Workers never write their checkpoint directly; they
// hand a window's worth of upserts to `runWindow`, which wraps those writes AND
// the cursor advance in one `prisma.$transaction`. If the worker's work throws,
// the transaction rolls back and the cursor does not move — so a restart
// re-processes the window from the last committed height (idempotent replay,
// SECURITY.md "handle reorgs/replays idempotently").

import type { Prisma, PrismaClient } from "@prisma/client";

/** A closed height range `[from, to]` to process as one unit. */
export interface Window {
  readonly from: bigint;
  readonly to: bigint;
}

/** Worker body: all data upserts for `window`, on the SAME transaction client. */
export type WindowFn = (tx: Prisma.TransactionClient, window: Window) => Promise<void>;

/** The last committed height for a stream, or `null` if it has never run. */
export async function readCheckpoint(prisma: PrismaClient, stream: string): Promise<bigint | null> {
  const row = await prisma.indexerCheckpoint.findUnique({ where: { stream } });
  return row?.cursorHeight ?? null;
}

/**
 * Run `fn` and advance the `stream` cursor to `window.to` in ONE transaction.
 * The cursor upsert is the last statement, so any failure in `fn` aborts the
 * whole window — data and cursor move together or not at all.
 */
export async function runWindow(
  prisma: PrismaClient,
  stream: string,
  window: Window,
  fn: WindowFn,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await fn(tx, window);
    await tx.indexerCheckpoint.upsert({
      where: { stream },
      create: { stream, cursorHeight: window.to },
      update: { cursorHeight: window.to },
    });
  });
}

/**
 * The highest height safe to process: the head minus a confirmation depth.
 * Provenance has instant finality (depth 0 acceptable, app-spec §9.2/§14.5), so
 * the default trails nothing. Returns `-1n` when nothing is yet safe.
 */
export function trailingTarget(head: bigint, confirmationDepth = 0): bigint {
  if (confirmationDepth < 0) throw new Error("confirmationDepth must be >= 0");
  const target = head - BigInt(confirmationDepth);
  return target < 0n ? -1n : target;
}
