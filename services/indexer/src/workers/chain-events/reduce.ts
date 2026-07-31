// Fold a window's height-ordered DomainEvents into `transactions` and
// `redemption_requests` writes. Pure over an abstract `Store` so the same logic
// runs against Postgres (production) and an in-memory map (the replay property
// test) — which is what lets us PROVE byte-identical convergence for replay
// from height 0 and from any restart point (SECURITY.md idempotent replay).
//
// Two properties make replay converge regardless of where it resumes:
//   1. Every write is an upsert keyed on chain-derived identity — Transaction
//      by (txhash, msgIndex) with a deterministic synthetic txhash for txless
//      EndBlocker rows; RedemptionRequest by requestId.
//   2. The redemption status lattice only advances (terminal states never
//      regress), and the running NAV is seeded from durable state each call
//      (`Store.readNav`) — so a resumed run derives the same value a full
//      replay would, even across a window boundary.

import type { DomainEvent, OperatorPaymentType } from "./events.ts";

export type TxKind =
  | "swap_in"
  | "swap_out_request"
  | "redemption_payout"
  | "redemption_refund"
  | "transfer_in"
  | "transfer_out";

export type RedemptionStatus = "enqueued" | "expedited" | "matured" | "refunded";

export interface TransactionRow {
  readonly txhash: string;
  readonly msgIndex: number;
  readonly address: string;
  readonly kind: TxKind;
  readonly shares: bigint;
  readonly nhash: bigint;
  readonly navAtHeight: bigint;
  readonly height: bigint;
  readonly blockTime: Date;
}

export interface RedemptionRow {
  readonly requestId: string;
  readonly owner: string;
  readonly shares: bigint;
  readonly status: RedemptionStatus;
  readonly enqueuedAt: Date;
  readonly expeditedAt: Date | null;
  readonly maturedAt: Date | null;
  readonly refundedAt: Date | null;
  readonly lastHeight: bigint;
  readonly lastTxhash: string;
}

export interface OperatorPaymentRow {
  readonly txhash: string;
  readonly msgIndex: number;
  /** Sibling discriminator within (txhash, msgIndex) — part of the key. */
  readonly ordinal: number;
  readonly valoper: string;
  readonly payer: string;
  readonly paymentType: OperatorPaymentType;
  readonly amount: bigint;
  /** Always null at ingest — see prisma/operator_payments.prisma: the crediting
   * epoch closes at a LATER crank, and reading another worker's table here
   * would make replay order-sensitive. services/api joins `epoch_snapshots` at
   * read time for the §14.11 CSV column. */
  readonly epochIndex: bigint | null;
  readonly height: bigint;
  readonly occurredAt: Date;
}

/**
 * The write surface `applyEvents` needs. `readNav`/`writeNav` persist the
 * running marker NAV across windows (durable, so resume matches full replay);
 * the upserts are keyed on chain identity so re-application is idempotent.
 */
export interface Store {
  readNav(): Promise<bigint>;
  writeNav(nav: bigint): Promise<void>;
  getRedemption(requestId: string): Promise<RedemptionRow | null>;
  upsertTransaction(row: TransactionRow): Promise<void>;
  upsertRedemption(row: RedemptionRow): Promise<void>;
  upsertOperatorPayment(row: OperatorPaymentRow): Promise<void>;
}

// Monotonic status lattice: a terminal state (matured/refunded) never regresses
// to expedited/enqueued, so out-of-order replay still converges.
const STATUS_RANK: Record<RedemptionStatus, number> = {
  enqueued: 0,
  expedited: 1,
  matured: 2,
  refunded: 2,
};

function maxStatus(a: RedemptionStatus, b: RedemptionStatus): RedemptionStatus {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

/** Deterministic synthetic txhash for a txless EndBlocker row (payout/refund). */
export function syntheticTxhash(
  height: bigint,
  requestId: string,
  kind: "payout" | "refund",
): string {
  return `blk:${height}:${requestId}:${kind}`;
}

/**
 * Apply `events` (which MUST be sorted ascending by height then emission order)
 * to the store. Returns nothing; all effects are upserts.
 */
export async function applyEvents(store: Store, events: readonly DomainEvent[]): Promise<void> {
  let nav = await store.readNav();

  for (const ev of events) {
    switch (ev.kind) {
      case "nav":
        nav = ev.priceNhash;
        break;

      case "swap_in":
        await store.upsertTransaction({
          txhash: ev.txhash,
          msgIndex: ev.msgIndex,
          address: ev.owner,
          kind: "swap_in",
          shares: ev.sharesReceived,
          nhash: ev.nhashIn,
          navAtHeight: nav,
          height: ev.height,
          blockTime: ev.blockTime,
        });
        break;

      case "swap_out_requested":
        await store.upsertTransaction({
          txhash: ev.txhash,
          msgIndex: ev.msgIndex,
          address: ev.owner,
          kind: "swap_out_request",
          shares: ev.shares,
          nhash: 0n, // nhash owed is unknown at request time; set at payout
          navAtHeight: nav,
          height: ev.height,
          blockTime: ev.blockTime,
        });
        await store.upsertRedemption(mergeEnqueued(await store.getRedemption(ev.requestId), ev));
        break;

      case "expedited":
        await advance(store, ev.requestId, "expedited", ev.height, ev.txhash, {
          expeditedAt: ev.blockTime,
        });
        break;

      case "operator_payment":
        // A payment is a standalone fact — no lattice, no running state — so
        // re-application on replay is a byte-identical upsert.
        await store.upsertOperatorPayment({
          txhash: ev.txhash,
          msgIndex: ev.msgIndex,
          ordinal: ev.ordinal,
          valoper: ev.valoper,
          payer: ev.payer,
          paymentType: ev.paymentType,
          amount: ev.amount,
          epochIndex: null,
          height: ev.height,
          occurredAt: ev.blockTime,
        });
        break;

      case "swap_out_completed": {
        const existing = await store.getRedemption(ev.requestId);
        const txhash = syntheticTxhash(ev.height, ev.requestId, "payout");
        await store.upsertTransaction({
          txhash,
          msgIndex: 0,
          address: ev.owner,
          kind: "redemption_payout",
          shares: existing?.shares ?? 0n, // shares come from the request row
          nhash: ev.assetsNhash,
          navAtHeight: nav,
          height: ev.height,
          blockTime: ev.blockTime,
        });
        await advance(store, ev.requestId, "matured", ev.height, txhash, {
          maturedAt: ev.blockTime,
        });
        break;
      }

      case "swap_out_refunded": {
        const txhash = syntheticTxhash(ev.height, ev.requestId, "refund");
        await store.upsertTransaction({
          txhash,
          msgIndex: 0,
          address: ev.owner,
          kind: "redemption_refund",
          shares: ev.shares, // refund event carries the returned shares
          nhash: 0n,
          navAtHeight: nav,
          height: ev.height,
          blockTime: ev.blockTime,
        });
        await store.upsertRedemption(
          mergeRefunded(await store.getRedemption(ev.requestId), ev, txhash),
        );
        break;
      }
    }
  }

  await store.writeNav(nav);
}

function mergeEnqueued(
  existing: RedemptionRow | null,
  ev: Extract<DomainEvent, { kind: "swap_out_requested" }>,
): RedemptionRow {
  if (existing) {
    // Already known (replay) — keep terminal timestamps, refresh last-seen.
    return {
      ...existing,
      owner: ev.owner,
      shares: ev.shares,
      lastHeight: ev.height,
      lastTxhash: ev.txhash,
    };
  }
  return {
    requestId: ev.requestId,
    owner: ev.owner,
    shares: ev.shares,
    status: "enqueued",
    enqueuedAt: ev.blockTime,
    expeditedAt: null,
    maturedAt: null,
    refundedAt: null,
    lastHeight: ev.height,
    lastTxhash: ev.txhash,
  };
}

interface Timestamps {
  expeditedAt?: Date;
  maturedAt?: Date;
}

/**
 * Advance an existing redemption's status/timestamps. Timestamps are set-once
 * (a re-seen event does not overwrite). If the row is missing — an ordering
 * violation that should not occur against a well-formed chain (the request
 * always precedes its terminal events) — the update is skipped rather than
 * fabricating a row with a non-null owner/shares it cannot know.
 */
async function advance(
  store: Store,
  requestId: string,
  status: RedemptionStatus,
  height: bigint,
  txhash: string,
  ts: Timestamps,
): Promise<void> {
  const row = await store.getRedemption(requestId);
  if (!row) return;
  await store.upsertRedemption({
    ...row,
    status: maxStatus(row.status, status),
    expeditedAt: row.expeditedAt ?? ts.expeditedAt ?? null,
    maturedAt: row.maturedAt ?? ts.maturedAt ?? null,
    lastHeight: height > row.lastHeight ? height : row.lastHeight,
    lastTxhash: txhash,
  });
}

function mergeRefunded(
  existing: RedemptionRow | null,
  ev: Extract<DomainEvent, { kind: "swap_out_refunded" }>,
  txhash: string,
): RedemptionRow {
  const base: RedemptionRow = existing ?? {
    // Defensive: refund carries owner+shares, so a valid row is reconstructable
    // if the request was somehow never seen (enqueuedAt best-effort = refund
    // time). Should not occur in-order; documented so it is not silent.
    requestId: ev.requestId,
    owner: ev.owner,
    shares: ev.shares,
    status: "enqueued",
    enqueuedAt: ev.blockTime,
    expeditedAt: null,
    maturedAt: null,
    refundedAt: null,
    lastHeight: ev.height,
    lastTxhash: txhash,
  };
  return {
    ...base,
    status: maxStatus(base.status, "refunded"),
    refundedAt: base.refundedAt ?? ev.blockTime,
    lastHeight: ev.height > base.lastHeight ? ev.height : base.lastHeight,
    lastTxhash: txhash,
  };
}
