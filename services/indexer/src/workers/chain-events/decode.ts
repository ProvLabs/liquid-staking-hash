// Raw chain event -> typed DomainEvent, or null when the event is not a
// program-scoped vault/NAV event. Every value read goes through the
// JSON-string-stripping helpers in src/decode/attributes.ts. Scoping (vault
// address on vault events, receipt denom on NAV markers) drops other vaults'
// events so a multi-vault chain never cross-contaminates this program's rows.

import { attr, coinAttr, optionalAttr, type RawEvent } from "../../decode/attributes.ts";
import {
  NAV_EVENT,
  VAULT_EVENT,
  type DomainEvent,
  type EventScope,
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
