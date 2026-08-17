// Validators-page data shapes (assembled by validators.server.ts, consumed by
// the client components; same split as chrome/types.ts and learn/types.ts).
// Serializable loader data: BigInt amounts become display strings server-side.
//
// ValidatorRow is the CLOSED public projection (§8.6: the public view renders
// reliability, never operator economics). Commission, TIP, headroom, and
// arrears fields must never appear here; test/validators-data.test.ts asserts
// the serialized key set stays exactly this.

import type { FreshnessMeta } from "@nvhash/api-types";
import type { Completeness } from "~/api/completeness";

export interface ValidatorRow {
  valoper: string;
  /** x/staking moniker, or null when that read failed or had no match. */
  moniker: string | null;
  eligible: boolean;
  jailed: boolean;
  tombstoned: boolean;
  /** Uptime percent string, or null before the first capture ("n/a"). */
  uptimePercent: string | null;
  /** The live performance threshold from `Config {}`, percent string. */
  thresholdPercent: string;
  /** Program delegation in compact HASH, or null when that read failed. */
  programDelegation: string | null;
  /** Enrollment time, ISO-8601; tenure is rendered client-side from it. */
  enrolledAt: string;
}

/**
 * The public projection of `ValidatorSetHealth`: `in_arrears` is
 * deliberately NOT projected (operator economics stay off this page even as
 * an aggregate; the gating test forbids the substring).
 */
export interface SetHealthPublic {
  total: number;
  active: number;
  eligible: number;
}

export interface ValidatorsData {
  /** null = the contract validators read failed (page says unavailable). */
  rows: ValidatorRow[] | null;
  /** Live eligible count from the latest epoch snapshot, or null. */
  eligibleCount: number | null;
  /** Indexed set-health aggregates with their freshness meta; null = API
   * unreachable or off-shape. `completeness` is the wire flag's tri-state:
   * "partial" = the registry outgrew the producer cap and these aggregates
   * cover a flagged prefix; "unknown" = older API, no completeness claim. */
  setHealth: { data: SetHealthPublic; completeness: Completeness; meta: FreshnessMeta } | null;
}
