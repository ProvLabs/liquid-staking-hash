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
  DecodeError,
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

/**
 * Decode this program's operator payments out of ONE tx's full event list
 * (M6.4 §2.1). Unlike the single-event decoders above this is a PAIR decode,
 * and it has to be: the contract's `pay_tip` wasm event reports the
 * epoch-cumulative `tip_epoch`, never the payment's own nhash. The amount and
 * the payer are therefore read from the bank `transfer` emitted at the same
 * `msg_index` with the contract as recipient — the msg's attached funds, which
 * `cw_utils::must_pay` bounds to exactly one coin in the underlying denom.
 *
 * Chain input is untrusted (SECURITY.md): a wasm payment event whose funds
 * transfer is absent, duplicated, or multi-coin, or a `pay_commission` whose
 * own `amount` attribute disagrees with the transferred funds, throws
 * `DecodeError` rather than storing a guess. Loud shape drift, never a
 * fabricated amount.
 */
export function decodeTxPayments(
  events: readonly RawEvent[],
  ctx: TxContext,
  scope: EventScope,
): OperatorPaymentEvent[] {
  const payments: OperatorPaymentEvent[] = [];

  for (const event of events) {
    if (event.type !== WASM_EVENT) continue;
    if (optionalAttr(event, "_contract_address") !== scope.contractAddress) continue;
    const paymentType = PAYMENT_TYPE_BY_ACTION.get(optionalAttr(event, "action") ?? "");
    if (paymentType === undefined) continue;

    const msgIndex = msgIndexOf(event);
    const funds = fundsForMsg(events, msgIndex, scope, paymentType);

    if (paymentType === "commission") {
      // The contract publishes the per-payment amount here too; a disagreement
      // means one of the two planes changed shape. Refuse to pick a winner.
      const declared = attr(event, "amount");
      if (declared !== funds.amount.toString()) {
        throw new DecodeError(
          `${WASM_EVENT}.${PAYMENT_ACTION.commission}`,
          `attribute amount ${declared} disagrees with the attached funds ${funds.amount.toString()}`,
        );
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

  return payments;
}

/** The single bank transfer of a payment msg's attached funds into the
 * contract: exactly one, exactly one coin. Anything else is shape drift. */
function fundsForMsg(
  events: readonly RawEvent[],
  msgIndex: number,
  scope: EventScope,
  paymentType: OperatorPaymentType,
): { readonly amount: bigint; readonly payer: string } {
  const path = `${TRANSFER_EVENT}[${PAYMENT_ACTION[paymentType]}#${msgIndex}]`;
  const matches = events.filter(
    (e) =>
      e.type === TRANSFER_EVENT &&
      optionalAttr(e, "msg_index") !== undefined &&
      msgIndexOf(e) === msgIndex &&
      optionalAttr(e, "recipient") === scope.contractAddress,
  );
  if (matches.length !== 1) {
    throw new DecodeError(
      path,
      `expected exactly one funds transfer into the contract, found ${matches.length}`,
    );
  }
  const transfer = matches[0]!;
  const coin = parseCoinString(attr(transfer, "amount"), `${path}.amount`);
  if (coin.amount <= 0n) {
    throw new DecodeError(path, "expected a positive attached amount", coin.amount.toString());
  }
  return { amount: coin.amount, payer: attr(transfer, "sender") };
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
