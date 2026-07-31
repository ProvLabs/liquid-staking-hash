// Golden-value gate for the BigInt display math (a float in
// the amount path is a review-rejectable defect). Expected values are
// computed independently from the fixture corpus numbers, not from
// the functions under test.

import { describe, expect, it } from "vitest";

import {
  bpsToPercent,
  formatBaseAmount,
  formatHashCompact,
  navHashPerShare,
} from "~/learn/amounts";

// From @nvhash/fixtures queries/vault/get.json (verbatim captured).
const FIXTURE_TVV = 315397882283n; // nhash
const FIXTURE_SHARES = 309963777029000000n; // nvhash base units

describe("navHashPerShare (fixture golden values)", () => {
  it("computes the corpus NAV exactly", () => {
    // 315397882283 * 10^10 / 309963777029000000 = 10175 (truncated)
    expect(navHashPerShare(FIXTURE_TVV, FIXTURE_SHARES)).toBe("1.0175");
  });

  it("returns null for an empty vault instead of fabricating a NAV", () => {
    expect(navHashPerShare(FIXTURE_TVV, 0n)).toBeNull();
  });

  it("returns null for a negative TVV instead of a mangled string", () => {
    expect(navHashPerShare(-1n, FIXTURE_SHARES)).toBeNull();
  });

  it("truncates rather than rounds up (display must not overstate)", () => {
    // 1.999999999 HASH over exactly one nvHASH: displays 1.9999, never 2.0000
    expect(navHashPerShare(1_999_999_999n, 10n ** 15n)).toBe("1.9999");
  });
});

describe("formatBaseAmount / formatHashCompact", () => {
  it("formats the corpus TVL compactly", () => {
    expect(formatHashCompact(FIXTURE_TVV)).toBe("315.39");
  });

  it("formats the corpus epoch rewards", () => {
    expect(formatBaseAmount(66_483_236n, 9, 2)).toBe("0.06");
  });

  it("applies K/M/B tiers with truncation", () => {
    expect(formatHashCompact(12_500_000_000_000n)).toBe("12.50K");
    expect(formatHashCompact(1_234_000_000_000_000n)).toBe("1.23M");
    expect(formatHashCompact(12_500_000_000_000_000_000n)).toBe("12.50B");
  });

  it("handles negatives (signed measures like net deposits)", () => {
    expect(formatBaseAmount(-37_058_359n, 9, 2)).toBe("-0.03");
    expect(formatHashCompact(-12_500_000_000_000n)).toBe("-12.50K");
  });
});

describe("bpsToPercent (integer math only)", () => {
  it("converts the corpus APR", () => {
    expect(bpsToPercent(4844)).toBe("48.44");
  });

  it("pads and signs correctly", () => {
    expect(bpsToPercent(5)).toBe("0.05");
    expect(bpsToPercent(-50)).toBe("-0.50");
    expect(bpsToPercent(0)).toBe("0.00");
  });

  it("rejects non-integers at the boundary", () => {
    expect(() => bpsToPercent(48.44)).toThrow(RangeError);
  });
});
