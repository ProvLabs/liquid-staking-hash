// BigInt-only display math for chain amounts (§7 scales: HASH = 10^9 nhash,
// nvHASH = 10^15 base units). Floats NEVER touch an amount: every function
// here divides scaled integers and places the decimal point in the string.
// Pure and client-safe; gated by golden-value tests against the fixture
// corpus (test/amounts.test.ts).

/** Base-unit exponent of HASH (nhash). */
export const HASH_EXPONENT = 9;
/** Base-unit exponent of nvHASH shares. */
export const SHARE_EXPONENT = 15;

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
    fractionDigits === 0
      ? ""
      : `.${fraction.toString().padStart(fractionDigits, "0")}`;
  return `${negative ? "-" : ""}${whole}${digits}`;
}

/**
 * NAV in HASH per nvHASH from live vault state:
 * (tvv/10^9) / (shares/10^15) = tvv * 10^6 / shares, truncated to
 * `fractionDigits`. Returns null for zero shares (an empty vault has no NAV,
 * and the UI must say so rather than fabricate one).
 */
export function navHashPerShare(
  tvvBase: bigint,
  sharesBase: bigint,
  fractionDigits = 4,
): string | null {
  if (sharesBase <= 0n) return null;
  const scaled = (tvvBase * pow10(SHARE_EXPONENT - HASH_EXPONENT + fractionDigits)) / sharesBase;
  const whole = scaled / pow10(fractionDigits);
  const fraction = scaled % pow10(fractionDigits);
  return `${whole}.${fraction.toString().padStart(fractionDigits, "0")}`;
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
