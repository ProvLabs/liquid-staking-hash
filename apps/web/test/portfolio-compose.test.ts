// Portfolio position composition goldens: BigInt-only math for
// current value (held + escrow priced at live TVV/shares), signed accrued
// gain (including a post-slash basis > value case), the divergence flag, and
// the indexed-plane fallback when live reads are null. Floats never touch
// these figures (SECURITY.md amount rules; test/amounts.test.ts precedent).

import { describe, expect, it } from "vitest";

import { composePosition } from "~/portfolio/portfolio.server";

const HASH = 10n ** 9n; // nhash per HASH
const SHARE = 10n ** 15n; // base units per nvHASH

describe("composePosition: live plane with escrow", () => {
  it("prices held + escrowed shares at live TVV/shares and signs the accrued gain", () => {
    const composed = composePosition(
      { balanceShares: 100n * SHARE, tvv: 150n * HASH, totalShares: 120n * SHARE },
      {
        indexedShareBalance: 100n * SHARE,
        escrowedShares: 20n * SHARE,
        heldBasis: 90n * HASH,
        escrowBasis: 18n * HASH,
        realizedGain: 5n * HASH,
        historyState: "complete",
        fallbackValueNhash: null,
      },
    );
    expect(composed.valuePlane).toBe("live");
    expect(composed.balanceShares).toBe(100n * SHARE);
    // (100 + 20) * 150 / 120 = 150 HASH
    expect(composed.currentValueNhash).toBe(150n * HASH);
    expect(composed.costBasisNhash).toBe(108n * HASH);
    // 150 - 108 + 5 = 47 HASH
    expect(composed.accruedGainNhash).toBe(47n * HASH);
    expect(composed.realizedGainNhash).toBe(5n * HASH);
    expect(composed.divergent).toBe(false);
    expect(composed.historyState).toBe("complete");
  });

  it("floors current value on a non-exact ratio (never rounds a balance up)", () => {
    const composed = composePosition(
      { balanceShares: 1n * SHARE, tvv: 10n, totalShares: 3n * SHARE },
      null,
    );
    // 1 * 10 / 3 = 3 (floor), not 3.33
    expect(composed.currentValueNhash).toBe(3n);
    expect(composed.valuePlane).toBe("live");
  });
});

describe("composePosition: signed accrued gain after a slash", () => {
  it("goes negative when basis exceeds the current value", () => {
    const composed = composePosition(
      { balanceShares: 100n * SHARE, tvv: 50n * HASH, totalShares: 100n * SHARE },
      {
        indexedShareBalance: 100n * SHARE,
        escrowedShares: 0n,
        heldBasis: 90n * HASH,
        escrowBasis: 0n,
        realizedGain: 0n,
        historyState: "complete",
        fallbackValueNhash: null,
      },
    );
    // 50 - 90 + 0 = -40 HASH
    expect(composed.currentValueNhash).toBe(50n * HASH);
    expect(composed.accruedGainNhash).toBe(-40n * HASH);
  });
});

describe("composePosition: divergence flag", () => {
  it("flags a live balance that differs from the indexed share balance", () => {
    const composed = composePosition(
      { balanceShares: 100n * SHARE, tvv: 100n * HASH, totalShares: 100n * SHARE },
      {
        indexedShareBalance: 95n * SHARE,
        escrowedShares: 0n,
        heldBasis: 90n * HASH,
        escrowBasis: 0n,
        realizedGain: 0n,
        historyState: "complete",
        fallbackValueNhash: null,
      },
    );
    expect(composed.divergent).toBe(true);
    // Basis-derived fields still populate; the flag carries the honesty state.
    expect(composed.accruedGainNhash).not.toBeNull();
  });
});

describe("composePosition: indexed-plane fallback", () => {
  it("uses the last accrual value and indexed balance when live reads are null", () => {
    const composed = composePosition(null, {
      indexedShareBalance: 100n * SHARE,
      escrowedShares: 0n,
      heldBasis: 100n * HASH,
      escrowBasis: 0n,
      realizedGain: 0n,
      historyState: "complete",
      fallbackValueNhash: 123n * HASH,
    });
    expect(composed.valuePlane).toBe("indexed");
    expect(composed.balanceShares).toBe(100n * SHARE);
    expect(composed.currentValueNhash).toBe(123n * HASH);
    expect(composed.accruedGainNhash).toBe(23n * HASH);
    // No live side: divergence is not asserted.
    expect(composed.divergent).toBe(false);
  });

  it("returns nulls with no plane when both planes are unavailable", () => {
    const composed = composePosition(null, null);
    expect(composed.valuePlane).toBeNull();
    expect(composed.balanceShares).toBeNull();
    expect(composed.currentValueNhash).toBeNull();
    expect(composed.accruedGainNhash).toBeNull();
    expect(composed.divergent).toBe(false);
    expect(composed.historyState).toBeNull();
  });
});

describe("composePosition: inconsistent history", () => {
  it("nulls the basis-derived figures but still prices the live position", () => {
    const composed = composePosition(
      { balanceShares: 100n * SHARE, tvv: 120n * HASH, totalShares: 100n * SHARE },
      {
        indexedShareBalance: 100n * SHARE,
        escrowedShares: 0n,
        heldBasis: null,
        escrowBasis: null,
        realizedGain: null,
        historyState: "inconsistent",
        fallbackValueNhash: null,
      },
    );
    expect(composed.currentValueNhash).toBe(120n * HASH);
    expect(composed.costBasisNhash).toBeNull();
    expect(composed.accruedGainNhash).toBeNull();
    expect(composed.realizedGainNhash).toBeNull();
    expect(composed.historyState).toBe("inconsistent");
  });
});
