// Golden-value gate for the shared NAV helper ([R1],
// app-spec §9.4): the SAME fixture values are pinned from the consumer side
// too (apps/web/test/amounts.test.ts, driving the web re-export), so the one
// implementation is held to one set of values from two sides — and a
// re-introduced local web copy would fail the web goldens the moment it
// drifted by a floor step. Values come from the captured corpus
// (@nvhash/fixtures queries/vault/get.json), never hand-invented.

import { describe, expect, it } from "vitest";
import { navHashPerShare } from "../src/amounts.ts";

// From @nvhash/fixtures queries/vault/get.json (verbatim captured).
const FIXTURE_TVV = 315397882283n; // nhash
const FIXTURE_SHARES = 309963777029000000n; // nvhash base units

describe("navHashPerShare (fixture golden values, pinned to the web suite)", () => {
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
