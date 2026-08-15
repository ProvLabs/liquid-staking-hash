// BigInt-only display math for chain amounts (§7 scales: HASH = 10^9 nhash,
// nvHASH = 10^15 base units). Floats NEVER touch an amount: every function
// here divides scaled integers and places the decimal point in the string.
// Pure and client-safe; gated by golden-value tests against the fixture
// corpus (test/amounts.test.ts).
//
// The NAV formula and the two exponents have ONE implementation, in
// `@nvhash/api-types` (app-spec §9.4 revision (d)): the API produces the
// historical NAV series with the same helper this module re-exports for the
// live figure, so the two cannot drift by a floor step. Re-exported here so
// call sites keep their `~/learn/amounts` import. The helpers below are
// display-only and web-local — they have no API-side twin.

export { HASH_EXPONENT, navHashPerShare, SHARE_EXPONENT } from "@nvhash/api-types";
import { HASH_EXPONENT } from "@nvhash/api-types";

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/**
 * Format a base-unit amount at `exponent` with exactly `fractionDigits`
 * decimals (truncated toward zero, never rounded up: display must not
 * overstate a balance).
 */
export function formatBaseAmount(base: bigint, exponent: number, fractionDigits = 2): string {
  const negative = base < 0n;
  const abs = negative ? -base : base;
  // Truncate the base amount to fractionDigits by scaling into an integer.
  const scaled = (abs * pow10(fractionDigits)) / pow10(exponent);
  const whole = scaled / pow10(fractionDigits);
  const fraction = scaled % pow10(fractionDigits);
  const digits =
    fractionDigits === 0 ? "" : `.${fraction.toString().padStart(fractionDigits, "0")}`;
  return `${negative ? "-" : ""}${whole}${digits}`;
}

/**
 * Basis points as a percent string with two decimals, integer math only
 * (4844 bps → "48.44"). Handles negative bps for signed measures.
 */
export function bpsToPercent(bps: number): string {
  if (!Number.isSafeInteger(bps)) throw new RangeError(`bps must be a safe integer, got ${bps}`);
  const negative = bps < 0;
  const abs = Math.abs(bps);
  const whole = Math.floor(abs / 100);
  const fraction = (abs % 100).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

const COMPACT_TIERS: ReadonlyArray<{ floor: bigint; suffix: string }> = [
  { floor: 1_000_000_000n, suffix: "B" },
  { floor: 1_000_000n, suffix: "M" },
  { floor: 1_000n, suffix: "K" },
];

/**
 * Compact HASH display for large figures like TVL: base nhash → "315.39",
 * "12.50K", "1.20B" (two decimals, truncated). Stays exact by scaling with
 * BigInt before the decimal point is placed.
 */
export function formatHashCompact(baseNhash: bigint): string {
  const negative = baseNhash < 0n;
  const abs = negative ? -baseNhash : baseNhash;
  const wholeHash = abs / pow10(HASH_EXPONENT);
  for (const tier of COMPACT_TIERS) {
    if (wholeHash >= tier.floor) {
      const scaled = (abs * 100n) / (pow10(HASH_EXPONENT) * tier.floor);
      const whole = scaled / 100n;
      const fraction = (scaled % 100n).toString().padStart(2, "0");
      return `${negative ? "-" : ""}${whole}.${fraction}${tier.suffix}`;
    }
  }
  return `${negative ? "-" : ""}${formatBaseAmount(abs, HASH_EXPONENT, 2)}`;
}
