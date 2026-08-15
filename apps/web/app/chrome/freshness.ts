// Freshness display rule (app-spec §9.4, §12.1): a null indexed height (or no
// meta at all) renders as "n/a", never a fabricated number. Pure and
// client-safe; the footer component and the unit gate both consume it.

import type { FreshnessMeta } from "@nvhash/api-types";

export type FreshnessDisplay =
  | { kind: "na" }
  | { kind: "indexed"; height: number; ageSeconds: number };

/**
 * Classify freshness meta for the footer. `nowMs` is injectable for tests.
 *
 * The age derives from `reconciledAt ?? generated_at` — the DATA'S age when
 * the API reports one (the reconciler run's ranAt), falling back to the
 * response clock only when no data age exists (cold start, or an older API).
 * With a dead indexer, `generated_at` stays current while `reconciledAt`
 * grows: "(5m ago)" must describe the data, not the HTTP response (8.1 §2.2).
 */
export function describeFreshness(
  meta: FreshnessMeta | null,
  nowMs: number,
  reconciledAt: string | null = null,
): FreshnessDisplay {
  if (meta === null || meta.indexed_height === null) return { kind: "na" };
  const stamp = Date.parse(reconciledAt ?? meta.generated_at);
  const ageSeconds = Number.isFinite(stamp) ? Math.max(0, Math.round((nowMs - stamp) / 1000)) : 0;
  return { kind: "indexed", height: meta.indexed_height, ageSeconds };
}

/** Compact age: seconds under 90 s, minutes under 90 min, hours beyond. */
export function formatAge(ageSeconds: number): string {
  if (ageSeconds < 90) return `${ageSeconds}s`;
  if (ageSeconds < 5_400) return `${Math.round(ageSeconds / 60)}m`;
  return `${Math.round(ageSeconds / 3_600)}h`;
}
