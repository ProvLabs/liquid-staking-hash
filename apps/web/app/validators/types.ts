// Validators-page data shapes (assembled by validators.server.ts, consumed by
// the client components; same split as chrome/types.ts and learn/types.ts).
// Serializable loader data: BigInt amounts become display strings server-side.
//
// ValidatorRow is the CLOSED public projection (§8.6: the public view renders
// reliability, never operator economics). Commission, TIP, headroom, and
// arrears fields must never appear here; test/validators-data.test.ts asserts
// the serialized key set stays exactly this.

import type { Envelope, ValidatorSetEpochRow } from "@nvhash/api-types";

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

export interface ValidatorsData {
  /** null = the contract validators read failed (page says unavailable). */
  rows: ValidatorRow[] | null;
  /** Live eligible count from the latest epoch snapshot, or null. */
  eligibleCount: number | null;
  /** Indexed per-settlement set health; null = API unreachable/off-shape. */
  setHistory: Envelope<ValidatorSetEpochRow[]> | null;
}
