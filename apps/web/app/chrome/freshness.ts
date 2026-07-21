// Freshness display rule (app-spec §9.4, §12.1): a null indexed height (or no
// meta at all) renders as "n/a", never a fabricated number. Pure and
// client-safe; the footer component and the unit gate both consume it.

import type { FreshnessMeta } from "@nvhash/api-types";

export type FreshnessDisplay =
  | { kind: "na" }
  | { kind: "indexed"; height: number; ageSeconds: number };

/** Classify freshness meta for the footer. `nowMs` is injectable for tests. */
export function describeFreshness(
  meta: FreshnessMeta | null,
  nowMs: number,
): FreshnessDisplay {
  if (meta === null || meta.indexed_height === null) return { kind: "na" };
  const generated = Date.parse(meta.generated_at);
  const ageSeconds = Number.isFinite(generated)
    ? Math.max(0, Math.round((nowMs - generated) / 1000))
    : 0;
  return { kind: "indexed", height: meta.indexed_height, ageSeconds };
}

/** Compact age: seconds under 90 s, minutes under 90 min, hours beyond. */
export function formatAge(ageSeconds: number): string {
  if (ageSeconds < 90) return `${ageSeconds}s`;
  if (ageSeconds < 5_400) return `${Math.round(ageSeconds / 60)}m`;
  return `${Math.round(ageSeconds / 3_600)}h`;
}
