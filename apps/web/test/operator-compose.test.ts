// Operator-view pure composition (M6.4 §2.3). Everything here is a fold over
// explicit inputs — no fetch, no clock — so the arithmetic an operator would
// act on is pinned by goldens rather than by whatever the loader happened to
// produce. Two things this suite exists to prevent:
//
//   1. A prepaid validator being rendered as merely "current". Program
//      commission is CUMULATIVE and never reset by the epoch rollover
//      (contracts/src/validators.rs), so an overpayment is a standing state,
//      not a transient one — and the payment events cannot show it at all.
//   2. The earnings ESTIMATE quietly becoming zero when an input is missing.
//      "You earned nothing" and "we cannot say" are different claims, and only
//      one of them is honest.

import { describe, expect, it } from "vitest";

import {
  buildEarningsSteps,
  commissionStanding,
  estimateOperatorEarnings,
  parseCommissionRate,
  prepaidCredit,
} from "~/validators/mine.server";

const HASH = 10n ** 9n;

describe("commission standing (the three states)", () => {
  it("is in-arrears whenever the contract says so, regardless of totals", () => {
    expect(
      commissionStanding({ inArrears: true, commissionPaid: 0n, commissionAccrued: 100n }),
    ).toBe("in-arrears");
  });

  it("is current when nothing is owed and nothing is ahead", () => {
    expect(
      commissionStanding({ inArrears: false, commissionPaid: 100n, commissionAccrued: 100n }),
    ).toBe("current");
  });

  it("is prepaid when cumulative paid exceeds cumulative accrued", () => {
    expect(
      commissionStanding({ inArrears: false, commissionPaid: 300n, commissionAccrued: 100n }),
    ).toBe("prepaid");
  });

  it("reports the prepaid credit, and nothing when there is none", () => {
    expect(prepaidCredit({ commissionPaid: 300n, commissionAccrued: 100n })).toBe(200n);
    expect(prepaidCredit({ commissionPaid: 100n, commissionAccrued: 100n })).toBeNull();
    expect(prepaidCredit({ commissionPaid: 50n, commissionAccrued: 100n })).toBeNull();
  });

  it("a validator that has paid ahead is never merely 'current'", () => {
    // The regression this guards: the contract's `outstanding` attribute
    // saturates at 0 for an overpayment, so anything reading the payment plane
    // sees "nothing outstanding" and would call this current.
    const paidAhead = { inArrears: false, commissionPaid: 5n * HASH, commissionAccrued: 1n * HASH };
    expect(commissionStanding(paidAhead)).not.toBe("current");
    expect(prepaidCredit(paidAhead)).toBe(4n * HASH);
  });
});

describe("commission-rate parsing (sdk.Dec, 18 decimals)", () => {
  it("parses the chain's rate strings at full scale", () => {
    expect(parseCommissionRate("0.100000000000000000")).toBe(10n ** 17n);
    expect(parseCommissionRate("0.050000000000000000")).toBe(5n * 10n ** 16n);
    expect(parseCommissionRate("1.000000000000000000")).toBe(10n ** 18n);
    expect(parseCommissionRate("0")).toBe(0n);
  });

  it("returns null on a shape the chain would not produce — never 0", () => {
    // Silently becoming 0 would render "you earn nothing" instead of "n/a".
    for (const bad of ["", "abc", "-0.1", "0.1e3", "1.0000000000000000000"]) {
      expect(parseCommissionRate(bad), bad).toBeNull();
    }
  });
});

describe("earnings estimate (BigInt scale-then-floor)", () => {
  const YEAR = 365n * 24n * 60n * 60n;

  it("computes a full-year step as delegation × apr × rate", () => {
    // 1000 HASH delegated for exactly one year at 10% program APR, 10% rate:
    // 1000 × 0.10 × 0.10 = 10 HASH.
    const earnings = estimateOperatorEarnings(
      [{ programDelegation: 1000n * HASH, netAprBps: 1000, durationSeconds: YEAR }],
      10n ** 17n,
    );
    expect(earnings).toBe(10n * HASH);
  });

  it("scales linearly with the step's real duration", () => {
    const half = estimateOperatorEarnings(
      [{ programDelegation: 1000n * HASH, netAprBps: 1000, durationSeconds: YEAR / 2n }],
      10n ** 17n,
    );
    expect(half).toBe(5n * HASH);
  });

  it("sums independent steps", () => {
    const total = estimateOperatorEarnings(
      [
        { programDelegation: 1000n * HASH, netAprBps: 1000, durationSeconds: YEAR / 2n },
        { programDelegation: 2000n * HASH, netAprBps: 1000, durationSeconds: YEAR / 2n },
      ],
      10n ** 17n,
    );
    expect(total).toBe(15n * HASH);
  });

  it("floors a negative program APR to zero rather than subtracting it", () => {
    // A slash epoch is a loss to the PROGRAM; it does not make the validator's
    // staking commission negative. Subtracting it would invent a debt.
    const earnings = estimateOperatorEarnings(
      [{ programDelegation: 1000n * HASH, netAprBps: -5000, durationSeconds: YEAR }],
      10n ** 17n,
    );
    expect(earnings).toBe(0n);
  });

  it("ignores steps with no delegation or no elapsed time", () => {
    expect(
      estimateOperatorEarnings(
        [
          { programDelegation: 0n, netAprBps: 1000, durationSeconds: YEAR },
          { programDelegation: 1000n * HASH, netAprBps: 1000, durationSeconds: 0n },
        ],
        10n ** 17n,
      ),
    ).toBe(0n);
  });

  it("never produces a float — a sub-unit result floors to zero, not 0.5", () => {
    const earnings = estimateOperatorEarnings(
      [{ programDelegation: 1n, netAprBps: 1, durationSeconds: 1n }],
      1n,
    );
    expect(earnings).toBe(0n);
    expect(Number.isInteger(Number(earnings))).toBe(true);
  });
});

describe("earnings steps (pairing delegation with the program's epochs)", () => {
  const boundaries = [
    { epochIndex: 1, endedAtSeconds: 1_000_000, netAprBps: 500 },
    { epochIndex: 2, endedAtSeconds: 2_000_000, netAprBps: 600 },
    { epochIndex: 3, endedAtSeconds: 3_000_000, netAprBps: 700 },
  ];

  it("measures each step from the PREVIOUS epoch's close", () => {
    const steps = buildEarningsSteps(
      new Map([
        [2, 100n],
        [3, 200n],
      ]),
      boundaries,
    );
    expect(steps).toEqual([
      { programDelegation: 100n, netAprBps: 600, durationSeconds: 1_000_000n },
      { programDelegation: 200n, netAprBps: 700, durationSeconds: 1_000_000n },
    ]);
  });

  it("contributes no step for the first epoch — there is no prior close", () => {
    // Assuming a month here would be inventing a duration.
    const steps = buildEarningsSteps(new Map([[1, 100n]]), boundaries);
    expect(steps).toEqual([]);
  });

  it("skips an epoch the validator had no delegation in", () => {
    const steps = buildEarningsSteps(new Map([[3, 200n]]), boundaries);
    expect(steps.map((s) => s.programDelegation)).toEqual([200n]);
  });

  it("skips an epoch with no program APR rather than assuming zero", () => {
    const steps = buildEarningsSteps(
      new Map([[2, 100n]]),
      [
        { epochIndex: 1, endedAtSeconds: 1_000_000, netAprBps: 500 },
        { epochIndex: 2, endedAtSeconds: 2_000_000, netAprBps: null },
      ],
    );
    expect(steps).toEqual([]);
  });
});
