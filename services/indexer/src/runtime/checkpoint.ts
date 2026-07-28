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

/**
 * How long a window's writes may take before Postgres aborts the transaction.
 *
 * Set EXPLICITLY because Prisma's default for an interactive transaction is 5
 * seconds, which is a latency default, not a throughput one — and a window is a
 * throughput unit. A worker applies its rows one `upsert` at a time (each
 * worker's `reduce.ts`), and `INDEX_WINDOW_SPAN` is 500 heights by default, so
 * a busy window (or any genesis backfill) issues thousands of sequential
 * round-trips inside this transaction. Crossing 5 s aborted the window, and
 * because the runner re-collects an aborted window on restart
 * (`runtime/worker.ts`), that abort repeated forever — the stream never
 * advanced past its first busy range. M6.4's `operator_payments` made this
 * materially more reachable: it is fed by a PERMISSIONLESS write path (anyone
 * may PayTip for any validator), so events-per-window is no longer bounded by
 * program activity alone (2026-07-28 review).
 *
 * 120 s is an operational ceiling, not a target: it is long enough that only a
 * genuinely stuck window trips it, and short enough that a stuck window still
 * fails loudly instead of hanging the worker indefinitely. It is deliberately a
 * constant rather than an env knob — raising it is a "why is a window this
 * slow" conversation, not a deployment tweak.
 *
 * NOTE (remaining, characterized): this removes the abort, not its cause. The
 * per-row `upsert` fold is still O(rows) round-trips per window. Batching it
 * needs `INSERT … ON CONFLICT DO UPDATE` — `createMany({ skipDuplicates })`
 * would NOT do, because skipping on conflict breaks the "derived tables are
 * rebuildable" contract: a replay after a decoder fix must UPDATE stale rows,
 * not leave them.
 */
export const WINDOW_TX_TIMEOUT_MS = 120_000;
/** How long to wait for a connection before starting the window transaction. */
export const WINDOW_TX_MAX_WAIT_MS = 10_000;

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
  await prisma.$transaction(
    async (tx) => {
      await fn(tx, window);
      await tx.indexerCheckpoint.upsert({
        where: { stream },
        create: { stream, cursorHeight: window.to },
        update: { cursorHeight: window.to },
      });
    },
    { timeout: WINDOW_TX_TIMEOUT_MS, maxWait: WINDOW_TX_MAX_WAIT_MS },
  );
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
