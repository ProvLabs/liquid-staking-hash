// Domain events the chain-events worker derives from raw chain events, and the
// vault/marker event-type identifiers they decode from. Two provenances
// (fixture corpus, packages/fixtures/manifest.json):
//   - tx-search (DeliverTx): EventSwapIn, EventSwapOutRequested,
//     EventPendingSwapOutExpedited — carry a txhash + msg_index.
//   - block_results.finalize_block_events (EndBlocker): EventSwapOutCompleted
//     (payout), EventSwapOutRefunded (refund), and the marker
//     EventSetNetAssetValue (NAV) — no tx, so rows keyed by a synthetic id.
// Attribute VALUES are JSON-string-quoted; decoding goes through
// src/decode/attributes.ts (the one place that fact lives).
//
// M6.4 adds a third provenance on the tx-search plane: the program CONTRACT's
// own `wasm` events for PayCommission/PayTip. Those attribute values arrive
// BARE (the contract is not the vault module) — `dequote` tolerates both, so
// the decode path is unchanged.

/** Vault module event type URLs (provlabs.vault.v1). */
export const VAULT_EVENT = {
  swapIn: "provlabs.vault.v1.EventSwapIn",
  swapOutRequested: "provlabs.vault.v1.EventSwapOutRequested",
  expedited: "provlabs.vault.v1.EventPendingSwapOutExpedited",
  swapOutCompleted: "provlabs.vault.v1.EventSwapOutCompleted",
  swapOutRefunded: "provlabs.vault.v1.EventSwapOutRefunded",
} as const;

/** Marker NAV event (provenance.marker.v1). */
export const NAV_EVENT = "provenance.marker.v1.EventSetNetAssetValue";

/** CosmWasm's contract-emitted event type, and the bank event carrying a
 * message's attached funds. Operator payments are decoded from the PAIR
 * (M6.4 §2.1): `pay_tip`'s wasm event reports the epoch-cumulative
 * `tip_epoch`, never the payment's own nhash. */
export const WASM_EVENT = "wasm";
export const TRANSFER_EVENT = "transfer";

/** The contract `action` attribute values that mark an operator payment. */
export const PAYMENT_ACTION = {
  commission: "pay_commission",
  tip: "pay_tip",
} as const;

/** What scopes an event to THIS program (ignore other vaults/contracts/denoms
 * on chain). `contractAddress` scopes contract `wasm` events — the type is
 * shared by every CosmWasm contract, so the `_contract_address` attribute is
 * the only thing that makes one ours. */
export interface EventScope {
  readonly vaultAddress: string;
  readonly receiptDenom: string;
  readonly contractAddress: string;
}

interface Base {
  readonly height: bigint;
  readonly blockTime: Date;
}
interface TxBase extends Base {
  readonly txhash: string;
  readonly msgIndex: number;
}

export interface SwapInEvent extends TxBase {
  readonly kind: "swap_in";
  readonly owner: string;
  readonly nhashIn: bigint;
  readonly sharesReceived: bigint;
}
export interface SwapOutRequestedEvent extends TxBase {
  readonly kind: "swap_out_requested";
  readonly owner: string;
  readonly requestId: string;
  readonly shares: bigint;
  readonly redeemDenom: string;
}
export interface ExpeditedEvent extends TxBase {
  readonly kind: "expedited";
  readonly requestId: string;
}
export interface SwapOutCompletedEvent extends Base {
  readonly kind: "swap_out_completed";
  readonly owner: string;
  readonly requestId: string;
  readonly assetsNhash: bigint;
}
export interface SwapOutRefundedEvent extends Base {
  readonly kind: "swap_out_refunded";
  readonly owner: string;
  readonly requestId: string;
  readonly shares: bigint;
  readonly reason: string;
}
export interface NavEvent extends Base {
  readonly kind: "nav";
  readonly priceNhash: bigint;
}

export type OperatorPaymentType = "commission" | "tip";

/** A PayCommission/PayTip execute against the program contract (M6.4 §2.1).
 * `amount` is the msg's attached funds and `payer` its sender — both read from
 * the same-msg_index bank transfer to the contract, since the wasm event alone
 * cannot supply a tip's per-payment amount. */
export interface OperatorPaymentEvent extends TxBase {
  readonly kind: "operator_payment";
  readonly paymentType: OperatorPaymentType;
  readonly valoper: string;
  readonly payer: string;
  readonly amount: bigint;
}

export type DomainEvent =
  | SwapInEvent
  | SwapOutRequestedEvent
  | ExpeditedEvent
  | SwapOutCompletedEvent
  | SwapOutRefundedEvent
  | NavEvent
  | OperatorPaymentEvent;
