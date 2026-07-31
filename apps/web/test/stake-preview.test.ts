// Stake NAV-preview gate (app-spec §8.3, §10.3). The preview
// mirrors the vault's floor share-mint math (rounds in the vault's favour,
// never over-promises shares) and reports empty-vault honestly. e2e-live
// cross-checks the same math against the real EventSwapIn.

import { describe, expect, it } from "vitest";

import { nextEpochIso } from "~/stake/stake.server";
import { previewSharesOut } from "~/stake/preview";

describe("previewSharesOut", () => {
  it("floors shares = deposit × totalShares ÷ totalValue", () => {
    // A 1:1-ish vault: 100 HASH value, 100 nvHASH shares → 1 HASH ≈ 1 nvHASH.
    const r = previewSharesOut(1_000_000_000n, 100_000_000_000_000_000n, 100_000_000_000n);
    expect(r).toEqual({ ok: true, shares: 1_000_000_000_000_000n });
  });

  it("rounds down (vault's favour), never up", () => {
    // deposit 1, totalShares 3, totalValue 2 → floor(1*3/2) = 1, not 2.
    const r = previewSharesOut(1n, 3n, 2n);
    expect(r).toEqual({ ok: true, shares: 1n });
  });

  it("reports empty-vault when there is no value or no shares", () => {
    expect(previewSharesOut(1_000_000_000n, 0n, 0n)).toEqual({ ok: false, reason: "empty-vault" });
    expect(previewSharesOut(1_000_000_000n, 100n, 0n)).toEqual({
      ok: false,
      reason: "empty-vault",
    });
  });
});

describe("nextEpochIso (E-CAL calendar-month cadence, §14.12)", () => {
  it("returns the first of the next civil month (UTC)", () => {
    // last run 2026-07-14T16:04:03Z → next epoch eligible 2026-08-01T00:00:00Z
    const last = Math.floor(Date.UTC(2026, 6, 14, 16, 4, 3) / 1000);
    expect(nextEpochIso(last)).toBe("2026-08-01T00:00:00.000Z");
  });

  it("rolls the year at December", () => {
    const last = Math.floor(Date.UTC(2026, 11, 20, 0, 0, 0) / 1000);
    expect(nextEpochIso(last)).toBe("2027-01-01T00:00:00.000Z");
  });
});
