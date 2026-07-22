// Learn-page data shapes (assembled by app/learn/learn.server.ts, consumed by
// the client components; same split as app/chrome/types.ts). Everything here
// is serializable loader data: BigInt amounts were already converted to
// display strings server-side, and indexed figures keep their envelope meta
// so the UI can label freshness (§12.1).

import type { Envelope, EpochRow, IncidentRow, ProgramMetrics } from "@nvhash/api-types";

export interface LearnLive {
  /** HASH per nvHASH, 4 decimals, or null (read failed / empty vault). */
  nav: string | null;
  /** Compact HASH TVL, or null when the vault read failed. */
  tvl: string | null;
  /** Net APR percent string, or null (read failed / below minimum window). */
  netAprPercent: string | null;
  /** Gross APR percent for the caption, same nullability as net. */
  grossAprPercent: string | null;
  /** Window behind the APR figure, seconds, when APR is shown. */
  aprWindowSeconds: number | null;
  /** True when APR exists on chain but history is below MIN_APR_EPOCHS. */
  aprInsufficientHistory: boolean;
  /** Yield decomposition in compact HASH, or null with the APR read. */
  yieldSources: {
    rewards: string;
    commission: string;
    tips: string;
    aumFee: string;
  } | null;
  /** Eligible validator count from the latest snapshot, or null. */
  eligibleValidators: number | null;
}

export interface LearnData {
  live: LearnLive;
  /** Indexed figures keep their envelopes so the UI labels freshness. */
  metrics: Envelope<ProgramMetrics> | null;
  epochs: Envelope<EpochRow[]> | null;
  incidents: Envelope<IncidentRow[]> | null;
}
