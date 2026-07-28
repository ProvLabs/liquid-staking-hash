// Raw chain event -> typed DomainEvent, or null when the event is not a
// program-scoped vault/NAV event. Every value read goes through the
// JSON-string-stripping helpers in src/decode/attributes.ts. Scoping (vault
// address on vault events, receipt denom on NAV markers, contract address on
// `wasm` events) drops other vaults'/contracts' events so a shared chain never
// cross-contaminates this program's rows.
//
// `decodeTxPayments` (M6.4) is the one PAIR decoder here: it reads a whole tx's
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
 * (M6.4 §2.1). Unlike the single-event decoders above this is a PAIR decode,
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
 * So an ambiguous pairing yields an `undecodable` entry instead: the payment is
 * skipped (never a fabricated amount), everything else in the window still
 * commits, and `sources.ts` logs it. The omission is recoverable — indexing is
 * idempotent and rebuildable from chain, so a later decoder that understands
 * the shape picks the row up on replay, which a wedged worker never does.
 */
export function decodeTxPayments(
  events: readonly RawEvent[],
  ctx: TxContext,
  scope: EventScope,
): TxPaymentsDecode {
  const payments: OperatorPaymentEvent[] = [];
  const undecodable: UndecodablePayment[] = [];

  for (const event of events) {
    if (event.type !== WASM_EVENT) continue;
    if (optionalAttr(event, "_contract_address") !== scope.contractAddress) continue;
    const paymentType = PAYMENT_TYPE_BY_ACTION.get(optionalAttr(event, "action") ?? "");
    if (paymentType === undefined) continue;

    const msgIndex = msgIndexOf(event);
    const funds = fundsForMsg(events, msgIndex, scope, paymentType);
    if (!funds.ok) {
      undecodable.push({ msgIndex, reason: funds.reason });
      continue;
    }

    if (paymentType === "commission") {
      // The contract publishes the per-payment amount here too; a disagreement
      // means the two planes cannot both be describing this payment. Refuse to
      // pick a winner — but skip rather than stop the stream, since which
      // transfer we paired is a function of the tx's composition.
      const declared = attr(event, "amount");
      if (declared !== funds.amount.toString()) {
        undecodable.push({
          msgIndex,
          reason: `attribute amount ${declared} disagrees with the attached funds ${funds.amount.toString()}`,
        });
        continue;
      }
    }

    payments.push({
      kind: "operator_payment",
      paymentType,
      valoper: attr(event, "valoper"),
      payer: funds.payer,
      amount: funds.amount,
      height: ctx.height,
      blockTime: ctx.blockTime,
      txhash: ctx.txhash,
      msgIndex,
    });
  }

  return { payments, undecodable };
}

type FundsResult =
  | { readonly ok: true; readonly amount: bigint; readonly payer: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The single bank transfer of a payment msg's attached funds into the contract:
 * exactly one, exactly one coin. A count other than one is AMBIGUITY about the
 * enclosing tx (returned, not thrown — see `decodeTxPayments`); a coin string
 * that will not parse is our own shape drift and still throws.
 */
function fundsForMsg(
  events: readonly RawEvent[],
  msgIndex: number,
  scope: EventScope,
  paymentType: OperatorPaymentType,
): FundsResult {
  const path = `${TRANSFER_EVENT}[${PAYMENT_ACTION[paymentType]}#${msgIndex}]`;
  const matches = events.filter(
    (e) =>
      e.type === TRANSFER_EVENT &&
      optionalAttr(e, "msg_index") !== undefined &&
      msgIndexOf(e) === msgIndex &&
      optionalAttr(e, "recipient") === scope.contractAddress,
  );
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly one funds transfer into the contract, found ${matches.length}`,
    };
  }
  const transfer = matches[0]!;
  const coin = parseCoinString(attr(transfer, "amount"), `${path}.amount`);
  if (coin.amount <= 0n) {
    // `must_pay` cannot produce this; a non-positive attached amount means the
    // transfer we paired is not the payment's funds at all.
    return { ok: false, reason: `expected a positive attached amount, got ${coin.amount.toString()}` };
  }
  return { ok: true, amount: coin.amount, payer: attr(transfer, "sender") };
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
