// Tally presentation (app-spec §8.7, §12.1).
//
// The comparison itself is `@nvhash/api-types`'s shared `meetsThreshold`, gated
// golden-pinned on BOTH sides by `packages/api-types/test/tally.test.ts`. What
// this suite holds is the web tier's half: that the verdict reaches the page
// unchanged, that `null` never collapses to `false` on the way, and that the
// arithmetic stays integral at magnitudes a JS number cannot hold.
//
// Invariant 4's disproof line is the shape of the last describe block: a
// decision-policy type whose pass condition is NEITHER of the two this build
// knows must render "n/a" rather than fall through to the threshold comparison —
// because falling through would score a proposal against a rule that is not its
// own, and report a confident verdict for it.

import { meetsThreshold, type GovDecisionPolicy, type GovTally } from "@nvhash/api-types";
import { describe, expect, it } from "vitest";

import { bpsToPercentString, buildTally, toDecisionRule } from "~/governance/tally";

const tally = (over: Partial<GovTally> = {}): GovTally => ({
  yes: "0",
  no: "0",
  abstain: "0",
  no_with_veto: "0",
  ...over,
});

const threshold = (value: string): GovDecisionPolicy => ({
  kind: "threshold",
  threshold: value,
  voting_period: "300s",
  min_execution_period: "0s",
});

const percentage = (value: string): GovDecisionPolicy => ({
  kind: "percentage",
  percentage: value,
  voting_period: "300s",
  min_execution_period: "0s",
});

describe("the shared verdict reaches the page unchanged", () => {
  it("agrees with meetsThreshold for every case, rather than re-deriving one", () => {
    const cases: { counts: GovTally; policy: GovDecisionPolicy; weight: string | null }[] = [
      { counts: tally({ yes: "2" }), policy: threshold("2"), weight: "3" },
      { counts: tally({ yes: "1" }), policy: threshold("2"), weight: "3" },
      { counts: tally({ yes: "2", no: "5" }), policy: threshold("2"), weight: "7" },
      { counts: tally({ yes: "2" }), policy: percentage("0.5"), weight: "3" },
      { counts: tally({ yes: "1" }), policy: percentage("0.5"), weight: "3" },
      { counts: tally({ yes: "2" }), policy: percentage("0.5"), weight: null },
    ];
    for (const { counts, policy, weight } of cases) {
      expect(buildTally(counts, policy, weight).meets).toBe(
        meetsThreshold(counts, toDecisionRule(policy), weight),
      );
    }
  });

  // x/group's ThresholdDecisionPolicy passes on YES weight alone: `no` and
  // `no_with_veto` do not subtract from it. Writing `yes - no` would be a
  // plausible reimplementation of a DIFFERENT module's rule.
  it("a threshold is met on yes weight alone, whatever the opposition", () => {
    const vm = buildTally(tally({ yes: "2", no: "99", no_with_veto: "99" }), threshold("2"), "200");
    expect(vm.meets).toBe(true);
  });
});

describe("null is a value, and it never becomes 0 or false", () => {
  it("an unknown decision policy renders n/a rather than being scored", () => {
    const vm = buildTally(tally({ yes: "9999" }), { kind: "unknown", type_url: "/x.Future" }, "3");
    expect(vm.rule).toBe("unknown");
    expect(vm.ruleValue).toBeNull();
    // The disproof case: a rule this build cannot evaluate must NOT come out as
    // "passes" just because the yes count looks large.
    expect(vm.meets).toBeNull();
  });

  it("a percentage rule with no live electorate weight is undecidable", () => {
    // This is the live-plane-down case, and `0` here would read as "nobody
    // supports this" instead of "we cannot say".
    const vm = buildTally(tally({ yes: "2" }), percentage("0.5"), null);
    expect(vm.meets).toBeNull();
    expect(vm.participationPercent).toBeNull();
    expect(vm.totalWeight).toBeNull();
  });

  it("no counts at all → every figure is null, none is zero", () => {
    const vm = buildTally(null, threshold("2"), "3");
    expect([vm.yes, vm.no, vm.abstain, vm.noWithVeto, vm.totalVoted]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(vm.meets).toBeNull();
  });

  it("a malformed count makes the whole tally undecidable, not partly credited", () => {
    const vm = buildTally(tally({ yes: "two" }), threshold("2"), "3");
    expect(vm.meets).toBeNull();
    expect(vm.totalVoted).toBeNull();
    // The raw string still shows: the page says what it received.
    expect(vm.yes).toBe("two");
  });

  it("a missing policy snapshot is undecidable, never a default rule", () => {
    const vm = buildTally(tally({ yes: "5" }), null, "5");
    expect(vm.rule).toBe("unknown");
    expect(vm.meets).toBeNull();
  });
});

describe("BigInt end to end — weights are unbounded sums, not token amounts", () => {
  it("decides correctly past 2^53, where a JS number would corrupt silently", () => {
    const huge = (2n ** 70n).toString();
    const justUnder = (2n ** 70n - 1n).toString();
    expect(buildTally(tally({ yes: huge }), threshold(huge), null).meets).toBe(true);
    expect(buildTally(tally({ yes: justUnder }), threshold(huge), null).meets).toBe(false);
    // And the counts are carried through as strings, never re-serialized numbers.
    expect(buildTally(tally({ yes: huge }), threshold(huge), null).yes).toBe(huge);
  });

  it("a percentage is scaled to integers, so no float decides an outcome", () => {
    // 1/3 of a weight-3 electorate against a 0.3333… rule: exact in integers.
    expect(buildTally(tally({ yes: "1" }), percentage("0.34"), "3").meets).toBe(false);
    expect(buildTally(tally({ yes: "1" }), percentage("0.33"), "3").meets).toBe(true);
  });

  it("participation is floor-rounded bps, presented as a percent string", () => {
    const vm = buildTally(tally({ yes: "1", abstain: "1" }), threshold("2"), "3");
    // 2/3 = 6666 bps → "66.66", floored: never rounded up into a fuller-looking
    // participation than actually happened.
    expect(vm.participationPercent).toBe("66.66");
    expect(bpsToPercentString(10_000)).toBe("100.00");
    expect(bpsToPercentString(5)).toBe("0.05");
  });

  it("abstain counts toward participation and never toward passage", () => {
    const vm = buildTally(tally({ abstain: "3" }), threshold("1"), "3");
    expect(vm.totalVoted).toBe("3");
    expect(vm.participationPercent).toBe("100.00");
    expect(vm.meets).toBe(false);
  });
});
