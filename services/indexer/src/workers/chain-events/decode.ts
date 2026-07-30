// Raw chain event -> typed DomainEvent, or null when the event is not a
// program-scoped vault/NAV event. Every value read goes through the
// JSON-string-stripping helpers in src/decode/attributes.ts. Scoping (vault
// address on vault events, receipt denom on NAV markers, contract address on
// `wasm` events) drops other vaults'/contracts' events so a shared chain never
// cross-contaminates this program's rows.
//
// `decodeTxPayments` is the one PAIR decoder here: it reads a whole tx's
// events because an operator payment's amount lives in the funds transfer, not
// in the contract's own event. Its coin DENOM is not re-checked against the
// program's underlying — `cw_utils::must_pay(underlying_denom)` is what let the
// execute succeed at all, so a decoded payment is underlying by construction.

import {
  attr,
  coinAttr,
  optionalAttr,
  parseCoinString,
  type RawEvent,
} from "../../decode/attributes.ts";
import {
  NAV_EVENT,
  PAYMENT_ACTION,
  TRANSFER_EVENT,
  VAULT_EVENT,
  WASM_EVENT,
  type DomainEvent,
  type EventScope,
  type OperatorPaymentEvent,
  type OperatorPaymentType,
} from "./events.ts";

/** Context for a tx-search (DeliverTx) event: has a txhash + msg index. */
export interface TxContext {
  readonly height: bigint;
  readonly blockTime: Date;
  readonly txhash: string;
}

/** Context for an EndBlocker (block_results) event: no tx. */
export interface BlockContext {
  readonly height: bigint;
  readonly blockTime: Date;
}

function msgIndexOf(event: RawEvent): number {
  const raw = optionalAttr(event, "msg_index");
  const n = raw === undefined ? 0 : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** Decode a DeliverTx event, or null if it is not an in-scope vault event. */
export function decodeTxEvent(event: RawEvent, ctx: TxContext, scope: EventScope): DomainEvent | null {
  switch (event.type) {
    case VAULT_EVENT.swapIn: {
      if (attr(event, "vault_address") !== scope.vaultAddress) return null;
      return {
        kind: "swap_in",
        owner: attr(event, "owner"),
        nhashIn: coinAttr(event, "amount_in").amount,
        sharesReceived: coinAttr(event, "shares_received").amount,
        height: ctx.height,
        blockTime: ctx.blockTime,
        txhash: ctx.txhash,
        msgIndex: msgIndexOf(event),
      };
    }
    case VAULT_EVENT.swapOutRequested: {
      if (attr(event, "vault_address") !== scope.vaultAddress) return null;
      return {
        kind: "swap_out_requested",
        owner: attr(event, "owner"),
        requestId: attr(event, "request_id"),
        shares: coinAttr(event, "shares").amount,
        redeemDenom: attr(event, "redeem_denom"),
        height: ctx.height,
        blockTime: ctx.blockTime,
        txhash: ctx.txhash,
        msgIndex: msgIndexOf(event),
      };
    }
    case VAULT_EVENT.expedited: {
      if (attr(event, "vault") !== scope.vaultAddress) return null;
      return {
        kind: "expedited",
        requestId: attr(event, "request_id"),
        height: ctx.height,
        blockTime: ctx.blockTime,
        txhash: ctx.txhash,
        msgIndex: msgIndexOf(event),
      };
    }
    default:
      return null;
  }
}

const PAYMENT_TYPE_BY_ACTION: ReadonlyMap<string, OperatorPaymentType> = new Map([
  [PAYMENT_ACTION.commission, "commission"],
  [PAYMENT_ACTION.tip, "tip"],
]);

/** A payment event whose funds could not be paired unambiguously: recorded and
 * skipped, never guessed — and never fatal to the window (see below). */
export interface UndecodablePayment {
  readonly msgIndex: number;
  readonly reason: string;
}

export interface TxPaymentsDecode {
  readonly payments: OperatorPaymentEvent[];
  readonly undecodable: readonly UndecodablePayment[];
}

/**
 * Decode this program's operator payments out of ONE tx's full event list
 *. Unlike the single-event decoders above this is a PAIR decode,
 * and it has to be: the contract's `pay_tip` wasm event reports the
 * epoch-cumulative `tip_epoch`, never the payment's own nhash. The amount and
 * the payer are therefore read from the bank `transfer` emitted at the same
 * `msg_index` with the contract as recipient — the msg's attached funds, which
 * `cw_utils::must_pay` bounds to exactly one coin in the underlying denom.
 *
 * Chain input is untrusted (SECURITY.md), and this decoder splits untrusted
 * input into TWO categories, which the 2026-07-28 review separated:
 *
 *   - **Our own event's shape** — a missing `valoper`/`amount` attribute on the
 *     contract's own wasm event, or an unparseable coin string. Only a contract
 *     upgrade or a decoder bug produces that, so it still throws `DecodeError`:
 *     loud, and the right thing to stop on.
 *   - **How the surrounding TRANSACTION was composed** — how many funds
 *     transfers landed at this `msg_index`. That is not ours to control: paying
 *     is permissionless, and a contract that batches two `pay_tip` sub-calls in
 *     one message legally produces two transfers into the contract at one
 *     `msg_index`. Throwing there let one unusual-but-legal transaction abort
 *     `collectWindow` forever — the runner re-collects the same window on
 *     restart (`runtime/worker.ts`), so the chain-events stream, and with it
 *     `transactions` and `redemption_requests`, stalled permanently on a block
 *     that is not going to change.
 *
 * **A batch is DECODED, not dropped**. Grouping by `msg_index`
 * and pairing the k-th payment event with the k-th funds transfer is well
 * founded: events are appended in EXECUTION order, and a (sub-)message's
 * attached-funds transfer is emitted when that sub-message runs, immediately
 * before the contract's own event for it — so the two sequences advance
 * together. Dropping the batch instead would have lost a real payment from the
 * operator's history, totals and §14.11 CSV, which is a wrong statement of
 * fact, not merely a missing one.
 *
 * Caveat, stated rather than hidden: the batched shape has NOT been observed on
 * devnet (the fixture corpus carries single-payment txs only), so the pairing
 * rests on the ordering argument above. `pay_commission` publishes its own
 * amount, which cross-checks the pairing whenever a commission is in the batch;
 * a pure-tip batch has no equivalent check. Worth a devnet exercise before a
 * batching caller exists in the wild (§7 Q1 precedent).
 *
 * A bucket that still cannot be paired — a transfer count that does not match
 * the payment count — yields `undecodable` entries: those payments are skipped
 * (never a fabricated amount), everything else in the window still commits, and
 * `sources.ts` logs it. That omission is recoverable, since ingest is
 * idempotent and rebuildable from chain; a wedged worker never is.
 */
export function decodeTxPayments(
  events: readonly RawEvent[],
  ctx: TxContext,
  scope: EventScope,
): TxPaymentsDecode {
  const payments: OperatorPaymentEvent[] = [];
  const undecodable: UndecodablePayment[] = [];

  // Bucket by `msg_index`, PRESERVING EMISSION ORDER within each bucket — that
  // order is what makes a batch decodable (see `pairFunds`).
  const byMsgIndex = new Map<number, { payments: RawEvent[]; transfers: RawEvent[] }>();
  const bucketFor = (msgIndex: number) => {
    let bucket = byMsgIndex.get(msgIndex);
    if (bucket === undefined) {
      bucket = { payments: [], transfers: [] };
      byMsgIndex.set(msgIndex, bucket);
    }
    return bucket;
  };

  for (const event of events) {
    if (event.type === WASM_EVENT) {
      if (optionalAttr(event, "_contract_address") !== scope.contractAddress) continue;
      if (PAYMENT_TYPE_BY_ACTION.get(optionalAttr(event, "action") ?? "") === undefined) continue;
      bucketFor(msgIndexOf(event)).payments.push(event);
    } else if (event.type === TRANSFER_EVENT) {
      // A transfer with no `msg_index` is not a message's attached funds (the
      // tx-level fee transfer is the case that matters), so it never pairs.
      if (optionalAttr(event, "msg_index") === undefined) continue;
      if (optionalAttr(event, "recipient") !== scope.contractAddress) continue;
      bucketFor(msgIndexOf(event)).transfers.push(event);
    }
  }

  for (const [msgIndex, bucket] of byMsgIndex) {
    if (bucket.payments.length === 0) continue;

    // One transfer per payment, or the bucket is genuinely unpairable.
    if (bucket.transfers.length !== bucket.payments.length) {
      for (const _ of bucket.payments) {
        undecodable.push({
          msgIndex,
          reason:
            `expected one funds transfer into the contract per payment, found ` +
            `${bucket.transfers.length} for ${bucket.payments.length} payment(s)`,
        });
      }
      continue;
    }

    for (const [k, event] of bucket.payments.entries()) {
      const paymentType = PAYMENT_TYPE_BY_ACTION.get(optionalAttr(event, "action") ?? "")!;
      const transfer = bucket.transfers[k]!;
      const path = `${TRANSFER_EVENT}[${PAYMENT_ACTION[paymentType]}#${msgIndex}#${k}]`;
      const coin = parseCoinString(attr(transfer, "amount"), `${path}.amount`);
      if (coin.amount <= 0n) {
        // `must_pay` cannot produce this; a non-positive attached amount means
        // the transfer paired here is not this payment's funds at all.
        undecodable.push({
          msgIndex,
          reason: `expected a positive attached amount, got ${coin.amount.toString()}`,
        });
        continue;
      }

      if (paymentType === "commission") {
        // The contract publishes the per-payment amount on its own event, so a
        // commission is a SELF-CHECK ON THE PAIRING: if the k-th transfer were
        // not this payment's funds, the two would disagree and we refuse rather
        // than store a guess. (A tip carries only the epoch-cumulative
        // `tip_epoch`, so a pure-tip batch has no equivalent check — the
        // ordering argument alone carries it.)
        const declared = attr(event, "amount");
        if (declared !== coin.amount.toString()) {
          undecodable.push({
            msgIndex,
            reason: `attribute amount ${declared} disagrees with the attached funds ${coin.amount.toString()}`,
          });
          continue;
        }
      }

      payments.push({
        kind: "operator_payment",
        ordinal: k,
        paymentType,
        valoper: attr(event, "valoper"),
        payer: attr(transfer, "sender"),
        amount: coin.amount,
        height: ctx.height,
        blockTime: ctx.blockTime,
        txhash: ctx.txhash,
        msgIndex,
      });
    }
  }

  return { payments, undecodable };
}

/** Decode an EndBlocker event, or null if it is not an in-scope event. */
export function decodeBlockEvent(event: RawEvent, ctx: BlockContext, scope: EventScope): DomainEvent | null {
  switch (event.type) {
    case VAULT_EVENT.swapOutCompleted: {
      if (attr(event, "vault_address") !== scope.vaultAddress) return null;
      return {
        kind: "swap_out_completed",
        owner: attr(event, "owner"),
        requestId: attr(event, "request_id"),
        assetsNhash: coinAttr(event, "assets").amount,
        height: ctx.height,
        blockTime: ctx.blockTime,
      };
    }
    case VAULT_EVENT.swapOutRefunded: {
      if (attr(event, "vault_address") !== scope.vaultAddress) return null;
      return {
        kind: "swap_out_refunded",
        owner: attr(event, "owner"),
        requestId: attr(event, "request_id"),
        shares: coinAttr(event, "shares").amount,
        reason: attr(event, "reason"),
        height: ctx.height,
        blockTime: ctx.blockTime,
      };
    }
    case NAV_EVENT: {
      if (attr(event, "denom") !== scope.receiptDenom) return null;
      // `price` is a coin string (`<amount>nhash`); `volume` is a bare Uint128.
      return {
        kind: "nav",
        priceNhash: coinAttr(event, "price").amount,
        height: ctx.height,
        blockTime: ctx.blockTime,
      };
    }
    default:
      return null;
  }
}
