// The shared tally helper (D17). Two things this suite is really protecting:
//
//   1. that "has it passed?" is decided by INTEGER math on unbounded weights, and
//   2. that "I cannot decide" is a distinct, reachable answer rather than a false.
//
// The second matters more than it looks. A boolean that silently means "no"
// whenever the input was unreadable would render a passed proposal as failed, and
// app-spec §12.1 forbids stating an outcome the data does not support.

import { describe, expect, it } from "vitest";
import {
  meetsThreshold,
  participationBps,
  percentageToScaled,
  totalVoted,
  type GovTallyCounts,
} from "../src/tally.ts";

const counts = (yes: string, no = "0", abstain = "0", veto = "0"): GovTallyCounts => ({
  yes,
  no,
  abstain,
  no_with_veto: veto,
});

describe("threshold rules", () => {
  it("passes when yes weight reaches the threshold", () => {
    expect(meetsThreshold(counts("2"), { kind: "threshold", threshold: "2" })).toBe(true);
    expect(meetsThreshold(counts("3"), { kind: "threshold", threshold: "2" })).toBe(true);
  });

  it("fails below the threshold", () => {
    expect(meetsThreshold(counts("1"), { kind: "threshold", threshold: "2" })).toBe(false);
  });

  it("compares against YES weight ALONE — no votes do not subtract", () => {
    // x/group's ThresholdDecisionPolicy is a yes-weight threshold. Implementing it
    // as `yes - no` would be a plausible-looking reimplementation of a DIFFERENT
    // module's rule, and it would report this passing proposal as failed.
    expect(meetsThreshold(counts("2", "5", "0", "3"), { kind: "threshold", threshold: "2" })).toBe(true);
  });

  it("ignores abstain for passage while counting it toward participation", () => {
    expect(meetsThreshold(counts("1", "0", "9"), { kind: "threshold", threshold: "2" })).toBe(false);
    expect(totalVoted(counts("1", "0", "9"))).toBe(10n);
  });

  it("handles weights far past 2^53 exactly", () => {
    // Member weights are unbounded chain integers. A JS number would round both
    // sides of this comparison into equality.
    const huge = (2n ** 70n).toString();
    const hugePlusOne = (2n ** 70n + 1n).toString();
    expect(meetsThreshold(counts(huge), { kind: "threshold", threshold: hugePlusOne })).toBe(false);
    expect(meetsThreshold(counts(hugePlusOne), { kind: "threshold", threshold: huge })).toBe(true);
  });
});

describe("percentage rules", () => {
  it("passes at exactly the fraction", () => {
    expect(meetsThreshold(counts("5"), { kind: "percentage", percentage: "0.5" }, "10")).toBe(true);
  });

  it("fails just below", () => {
    expect(meetsThreshold(counts("4"), { kind: "percentage", percentage: "0.5" }, "10")).toBe(false);
  });

  it("is exact where a float would round the wrong way", () => {
    // 1/3 of 3 is exactly one vote; binary floating point cannot represent the
    // fraction, so a float implementation decides this by rounding luck.
    expect(
      meetsThreshold(counts("1"), { kind: "percentage", percentage: "0.333333333333333333" }, "3"),
    ).toBe(true);
  });

  it("cannot decide without an electorate weight", () => {
    expect(meetsThreshold(counts("5"), { kind: "percentage", percentage: "0.5" })).toBeNull();
    expect(meetsThreshold(counts("5"), { kind: "percentage", percentage: "0.5" }, null)).toBeNull();
    // A zero electorate is undecidable, not a division by zero and not a false.
    expect(meetsThreshold(counts("5"), { kind: "percentage", percentage: "0.5" }, "0")).toBeNull();
  });

  it("scales a decimal fraction to exact fixed point", () => {
    expect(percentageToScaled("0.5")).toBe(5n * 10n ** 17n);
    expect(percentageToScaled("1")).toBe(10n ** 18n);
    expect(percentageToScaled("0")).toBe(0n);
  });

  it("rejects anything that is not a plain decimal fraction", () => {
    for (const bad of ["5e-1", "-0.5", "1.5", "2", ".5", "0,5", "", "0.5 ", "abc"]) {
      expect(percentageToScaled(bad)).toBeNull();
    }
  });
});

describe("undecidable is a first-class answer", () => {
  it("returns null for an unrecognized policy type", () => {
    // A chain upgrade that adds a policy kind must render as "not understood",
    // never be scored against a guessed rule.
    expect(meetsThreshold(counts("99"), { kind: "unknown" })).toBeNull();
  });

  it("returns null for a malformed count rather than treating it as zero", () => {
    expect(meetsThreshold(counts("1.5"), { kind: "threshold", threshold: "1" })).toBeNull();
    expect(meetsThreshold(counts("-1"), { kind: "threshold", threshold: "1" })).toBeNull();
    expect(meetsThreshold(counts(""), { kind: "threshold", threshold: "1" })).toBeNull();
    expect(meetsThreshold(counts("2"), { kind: "threshold", threshold: "two" })).toBeNull();
  });

  it("returns null from totalVoted when ANY count is malformed", () => {
    // Partial credit would be worse than none: summing three good counts and
    // ignoring a bad one produces a confident, wrong participation figure.
    expect(totalVoted(counts("1", "x"))).toBeNull();
    expect(totalVoted(counts("1", "2", "3", "4"))).toBe(10n);
  });
});

describe("participation is presentation only", () => {
  it("computes bps with integer math", () => {
    expect(participationBps(counts("1", "1", "1"), "4")).toBe(7_500);
    expect(participationBps(counts("4"), "4")).toBe(10_000);
    expect(participationBps(counts("0"), "4")).toBe(0);
  });

  it("returns null rather than dividing by zero or guessing", () => {
    expect(participationBps(counts("1"), "0")).toBeNull();
    expect(participationBps(counts("1"), null)).toBeNull();
    expect(participationBps(counts("x"), "4")).toBeNull();
  });

  it("stays a safe integer for huge weights", () => {
    const huge = (2n ** 80n).toString();
    const bps = participationBps(counts(huge), huge);
    expect(bps).toBe(10_000);
    expect(Number.isSafeInteger(bps!)).toBe(true);
  });
});
