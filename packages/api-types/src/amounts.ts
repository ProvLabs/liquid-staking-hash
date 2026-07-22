// Shared BigInt-only NAV math (app plan PR 3.1, review resolution [R1] in
// docs/plans/2026-07-22-app-m3-query-api.md).
//
// The API is the producer of the historical NAV series (`EpochRow.nav`) while
// apps/web computes the live current-NAV figure with the same formula
// (apps/web/app/learn/amounts.ts). If the two implementations drifted, one
// chart would carry two inconsistent NAV conventions — so the pure helper
// lives here, in the shared zero-runtime-dependency contract package, and a
// golden test (test/amounts.test.ts) pins its output to the web
// implementation's fixture-corpus values. The web-side switch to this shared
// copy is a recorded follow-on (PR 3.1 stays services-only).
//
// Floats NEVER touch an amount (app-spec §5.8): scale with BigInt, floor by
// integer division, and place the decimal point in the string.

/** Base-unit exponent of HASH (nhash = 10^-9 HASH). */
export const HASH_EXPONENT = 9;
/** Base-unit exponent of nvHASH shares (10^15 base units per nvHASH). */
export const SHARE_EXPONENT = 15;

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/**
 * NAV in HASH per nvHASH from base-unit TVV and total shares:
 * (tvv/10^9) / (shares/10^15) = tvv * 10^6 / shares, truncated to
 * `fractionDigits` (scale-then-floor: display must not overstate a value).
 * Returns null for zero shares (an empty vault has no NAV — say so rather
 * than fabricate one) and for a negative TVV (impossible on chain, but a
 * corrupted value must not format as a mangled string).
 */
export function navHashPerShare(
  tvvBase: bigint,
  sharesBase: bigint,
  fractionDigits = 4,
): string | null {
  if (sharesBase <= 0n || tvvBase < 0n) return null;
  const scaled = (tvvBase * pow10(SHARE_EXPONENT - HASH_EXPONENT + fractionDigits)) / sharesBase;
  const whole = scaled / pow10(fractionDigits);
  const fraction = scaled % pow10(fractionDigits);
  return `${whole}.${fraction.toString().padStart(fractionDigits, "0")}`;
}
