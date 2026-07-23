// Typical time-to-payout display (plan 5.4; app-spec §8.4, §9.5.3, §14.12).
// Pure mapping of the API's PayoutStats into what the exit surface may show.
// The NORMATIVE rule (§8.4): the 60-day ceiling is always the promise; the
// typical statistic is shown only when present and always LABELED typical —
// never promoted into the promise position (a layout concern the component +
// e2e enforce). This helper only decides whether a typical figure exists and
// converts it to whole days within the physical band.

import type { PayoutStats } from "@nvhash/api-types";

const SECONDS_PER_DAY = 24 * 60 * 60;

export interface TypicalDisplay {
  /** Whether a sample-sufficient, non-cold-start typical figure exists. */
  hasTypical: boolean;
  medianDays: number | null;
  p90Days: number | null;
  /** The guarantee ceiling in days (always shown — the promise position). */
  guaranteeDays: number;
  /** Reason the typical is withheld, for honest copy. */
  withheld: "cold-start" | "insufficient-sample" | null;
}

export function typicalDisplay(stats: PayoutStats | null): TypicalDisplay {
  const guaranteeDays = stats
    ? Math.round(stats.band_ceiling_seconds / SECONDS_PER_DAY)
    : 60; // the fixed ceiling stands even if the stats read failed
  if (stats === null || stats.median_seconds === null || stats.p90_seconds === null) {
    return {
      hasTypical: false,
      medianDays: null,
      p90Days: null,
      guaranteeDays,
      withheld: stats?.cold_start ? "cold-start" : "insufficient-sample",
    };
  }
  return {
    hasTypical: true,
    medianDays: Math.round(stats.median_seconds / SECONDS_PER_DAY),
    p90Days: Math.round(stats.p90_seconds / SECONDS_PER_DAY),
    guaranteeDays,
    withheld: null,
  };
}
