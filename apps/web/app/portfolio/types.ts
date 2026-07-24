// Portfolio-page view models (assembled by portfolio.server.ts, consumed by
// the client components; same server-prepares-display-strings split as
// chrome/market/learn). BigInt never crosses the wire: every amount is a
// display string prepared server-side. The one exception is the accrual chart
// points, which carry plottable numbers (render-time percent/HASH conversion
// is allowed by app-spec §9.5) and confine that conversion to that mapping.

import type { FreshnessMeta } from "@nvhash/api-types";

/** Which plane the position value was composed from, or null when neither read. */
export type PortfolioPlane = "live" | "indexed" | null;

export interface PositionSummaryVM {
  /** Whole-nvHASH share display, or null when no plane answered. */
  balanceHash: string | null;
  /** Position value in HASH from nhash, or null when not priceable. */
  currentValueHash: string | null;
  valuePlane: PortfolioPlane;
  /** NAV in HASH per nvHASH from the live plane, or null. */
  currentNav: string | null;
  /** Signed accrued gain in HASH, or null when basis is not trustable. */
  accruedGainHash: string | null;
  costBasisHash: string | null;
  /** Signed realized gain in HASH, or null when inconsistent. */
  realizedGainHash: string | null;
  /** Constant: the UI renders the §14.11 "aid, not a tax position" label. */
  basisIsAid: true;
  /** Live share balance differs from the indexed share balance. */
  divergent: boolean;
  historyState: "complete" | "has_transfers" | "inconsistent" | null;
}

export interface YieldPointVM {
  epochIndex: number;
  endedAt: string;
  personalAprBps: number | null;
  netAprBps: number | null;
}

export interface AccrualPointVM {
  time: string;
  /** Plottable HASH value (render-time conversion, app-spec §9.5). */
  valueHash: number;
}

export interface AccrualMarkerVM {
  time: string;
  txhash: string;
  kind: string;
  sharesDisplay: string;
  nhashDisplay: string;
}

export interface AccrualVM {
  points: AccrualPointVM[];
  markers: AccrualMarkerVM[];
  /** Marker cap trimmed older events. */
  truncated: boolean;
  /** Accrual series cap trimmed earlier history (most recent points kept). */
  historyTruncated: boolean;
}

export interface RedemptionVM {
  requestId: string;
  sharesDisplay: string;
  status: "enqueued" | "expedited" | "matured" | "refunded";
  enqueuedAt: string;
  statusTimestamps: {
    expeditedAt: string | null;
    maturedAt: string | null;
    refundedAt: string | null;
  };
}

export interface HistoryRowVM {
  time: string;
  kind: string;
  sharesDisplay: string;
  nhashDisplay: string;
  navDisplay: string;
  txhash: string;
  explorerHref: string | null;
}

export interface HistoryPageVM {
  rows: HistoryRowVM[];
  page: number;
  pageSize: 50;
  hasMore: boolean;
}

export interface PortfolioData {
  address: string;
  summary: PositionSummaryVM;
  effectiveAprBps: number | null;
  yieldByEpoch: YieldPointVM[];
  accrual: AccrualVM | null;
  activeRedemptions: RedemptionVM[];
  firstActivityAt: string | null;
  history: HistoryPageVM | null;
  /** False when the assertion key is unset or the API is unreachable. */
  personalReadsAvailable: boolean;
  /** Freshness of the indexed personal reads, or null when unavailable. */
  freshness: FreshnessMeta | null;
}
