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

/** What scopes an event to THIS program (ignore other vaults/denoms on chain). */
export interface EventScope {
  readonly vaultAddress: string;
  readonly receiptDenom: string;
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

export type DomainEvent =
  | SwapInEvent
  | SwapOutRequestedEvent
  | ExpeditedEvent
  | SwapOutCompletedEvent
  | SwapOutRefundedEvent
  | NavEvent;
