// Market-page data shapes (assembled by market.server.ts, consumed by the
// client components; same split as chrome/learn/validators types). All
// display strings are prepared server-side (BigInt never crosses); market
// figures carry their venue + sample time because market data has no
// chain-canonical plane (§8.5/§12.1) — a figure is never separated from its
// where/when.

import type { Envelope, EpochRow, FreshnessMeta } from "@nvhash/api-types";

export interface DepthRowView {
  side: "buy" | "sell";
  slippageBps: number;
  /** Executable size, whole nvHASH display string. */
  sizeNvhash: string;
}

export interface MarketSampleView {
  venue: string;
  /** HASH per nvHASH display string (from the base-unit integer price). */
  priceHash: string;
  /** Signed percent string, or null (no NAV at the sample's time: "n/a"). */
  premiumPercent: string | null;
  /** ISO-8601 sample time (age rendered client-side). */
  sampledAt: string;
  depth: DepthRowView[];
}

export interface BridgedRowView {
  chain: string;
  /** Whole nvHASH display string. */
  supplyNvhash: string;
  sampledAt: string;
}

export interface MarketData {
  /** null = /market unreachable or off-shape (unavailable state). A non-null
   * value with `sample: null` is the honest v1 "forthcoming" shell. */
  market: {
    sample: MarketSampleView | null;
    bridged: BridgedRowView[];
    meta: FreshnessMeta;
  } | null;
  /** Live local nvHASH supply (vault total shares), or null on read failure. */
  localSupply: string | null;
  /** Settlement history for the §8.5 views; null = unreachable/off-shape. */
  epochs: Envelope<EpochRow[]> | null;
}
