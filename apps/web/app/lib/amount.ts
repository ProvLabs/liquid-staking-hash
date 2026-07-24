// User-input amount parsing (plan 5.3): a decimal display string (HASH or
// nvHASH) → base-unit BigInt at a given exponent. This is the ONE place raw
// user text becomes an on-chain amount, so it is strict at the boundary
// (SECURITY.md: validate and bound; reject, never clamp — a value that
// cannot be represented exactly is an error, not a rounding opportunity).
//
// Amount discipline (app-spec §3 decision 8): no floating point ever — the
// string is split on the decimal point and assembled with BigInt. The
// display formatters live in app/learn/amounts.ts (base-unit → string);
// this is the inverse for the input path.

export type AmountParseError =
  | "empty"
  | "not-a-number"
  | "negative"
  | "too-precise" // more fraction digits than the exponent allows
  | "zero";

export type AmountParseResult =
  | { ok: true; base: bigint }
  | { ok: false; error: AmountParseError };

/**
 * Parse a decimal string to base units at `exponent` (e.g. 9 for HASH, 15
 * for nvHASH). Rejects blanks, signs, non-numeric characters, and
 * over-precise inputs. Zero parses to a distinct `zero` error so the caller
 * can message it as "enter an amount" rather than a malformed input.
 */
export function parseAmount(input: string, exponent: number): AmountParseResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: "empty" };
  // Plain decimal only: optional integer part, optional single fraction. No
  // sign, no exponent notation, no thousands separators, no leading '+'.
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (match === null) return { ok: false, error: "not-a-number" };
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (whole === "" && fraction === "") return { ok: false, error: "not-a-number" };
  if (fraction.length > exponent) return { ok: false, error: "too-precise" };

  const padded = fraction.padEnd(exponent, "0");
  const base = BigInt(`${whole === "" ? "0" : whole}${padded}`);
  if (base === 0n) return { ok: false, error: "zero" };
  return { ok: true, base };
}

/**
 * Format a base-unit BigInt back to a trimmed decimal string at `exponent`
 * (full precision, no rounding) — the round-trip inverse of `parseAmount`,
 * for echoing a max-balance value back into an input field.
 */
export function baseToDecimalString(base: bigint, exponent: number): string {
  if (exponent === 0) return base.toString();
  const s = base.toString().padStart(exponent + 1, "0");
  const whole = s.slice(0, -exponent);
  const fraction = s.slice(-exponent).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}
