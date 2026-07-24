// Amount-input parsing gate (plan 5.3; SECURITY.md validate-and-bound,
// reject-never-clamp; spec §3 decision 8 no-floats). The one place user
// text becomes an on-chain amount must be strict at the boundary.

import { describe, expect, it } from "vitest";

import { baseToDecimalString, parseAmount } from "~/lib/amount";

const HASH = 9;
const SHARE = 15;

describe("parseAmount", () => {
  it("parses whole and fractional HASH to base units", () => {
    expect(parseAmount("1", HASH)).toEqual({ ok: true, base: 1_000_000_000n });
    expect(parseAmount("0.5", HASH)).toEqual({ ok: true, base: 500_000_000n });
    expect(parseAmount("12.000000001", HASH)).toEqual({ ok: true, base: 12_000_000_001n });
    expect(parseAmount(".5", HASH)).toEqual({ ok: true, base: 500_000_000n });
    expect(parseAmount("  3.25  ", HASH)).toEqual({ ok: true, base: 3_250_000_000n });
  });

  it("parses at the share exponent (15)", () => {
    expect(parseAmount("1", SHARE)).toEqual({ ok: true, base: 1_000_000_000_000_000n });
  });

  it("rejects over-precision rather than truncating (never clamp)", () => {
    expect(parseAmount("1.0000000001", HASH)).toEqual({ ok: false, error: "too-precise" });
  });

  it("rejects floats-as-text, signs, exponent notation, separators", () => {
    for (const bad of ["abc", "1e9", "-1", "+1", "1,000", "0x10", "1.2.3", "1..2", ""]) {
      expect(parseAmount(bad, HASH).ok, `"${bad}" must reject`).toBe(false);
    }
  });

  it("distinguishes zero from malformed (so the UI can message it)", () => {
    expect(parseAmount("0", HASH)).toEqual({ ok: false, error: "zero" });
    expect(parseAmount("0.000000000", HASH)).toEqual({ ok: false, error: "zero" });
    expect(parseAmount("x", HASH)).toEqual({ ok: false, error: "not-a-number" });
    expect(parseAmount("", HASH)).toEqual({ ok: false, error: "empty" });
  });

  it("round-trips through baseToDecimalString", () => {
    expect(baseToDecimalString(1_000_000_000n, HASH)).toBe("1");
    expect(baseToDecimalString(500_000_000n, HASH)).toBe("0.5");
    expect(baseToDecimalString(12_000_000_001n, HASH)).toBe("12.000000001");
    expect(baseToDecimalString(0n, HASH)).toBe("0");
    // parse ∘ format is identity for representable values
    const round = baseToDecimalString(3_250_000_000n, HASH);
    expect(parseAmount(round, HASH)).toEqual({ ok: true, base: 3_250_000_000n });
  });
});
