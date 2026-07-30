// Tally presentation (app-spec §8.7 "tally vs threshold"). PURE.
//
// This file does NOT decide whether a proposal passed. `meetsThreshold` in
// `@nvhash/api-types/tally` does, and it is shared with `services/api` for the
// reason D17 records: a duplicated formula drifted once already
// (`navHashPerShare`, app-spec §9.4 revision (d)), and two implementations of
// "has this passed?" would eventually disagree about the same proposal — which a
// member would read as the program contradicting itself about governance.
//
// What this file owns is the presentation around that verdict: mapping the wire
// `GovDecisionPolicy` onto the shared `GovDecisionRule`, and formatting the
// counts. Three rules hold throughout:
//
//   * BigInt or verbatim strings only. Weights are unbounded sums of member
//     weights with no protocol ceiling, so a JS number would corrupt them past
//     2^53 and a float would decide a governance outcome by rounding.
//   * `null` is a first-class answer and renders "n/a". A percentage rule with
//     no live electorate weight is undecidable, and a `0` there would read as
//     "nobody supports this".
//   * The rule comes from the PROPOSAL's own snapshot for anything not open —
//     scoring a historical tally against today's policy would be a lie about
//     what passed.

import {
  meetsThreshold,
  participationBps,
  totalVoted,
  type GovDecisionPolicy,
  type GovDecisionRule,
  type GovTally,
} from "@nvhash/api-types";

import type { TallyVM } from "./types";

/** The wire policy → the shared rule. The `unknown` arm carries no figure, so
 * it can never fall through to the threshold comparison (invariant 4's own
 * disproof: a future policy type whose pass condition is neither of these). */
export function toDecisionRule(policy: GovDecisionPolicy | null): GovDecisionRule {
  if (policy === null) return { kind: "unknown" };
  if (policy.kind === "threshold") return { kind: "threshold", threshold: policy.threshold };
  if (policy.kind === "percentage") return { kind: "percentage", percentage: policy.percentage };
  return { kind: "unknown" };
}

/** bps → a percent display string, floor-rounded to two places. Integer math. */
export function bpsToPercentString(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = Math.abs(bps % 100);
  return `${whole}.${String(fraction).padStart(2, "0")}`;
}

/**
 * Compose the tally view model.
 *
 * `totalWeight` is the LIVE electorate weight and is optional on purpose: it is
 * unavailable whenever the live plane is down, and a percentage rule must then
 * render "n/a" rather than be scored against a guessed denominator.
 */
export function buildTally(
  counts: GovTally | null,
  policy: GovDecisionPolicy | null,
  totalWeight: string | null,
): TallyVM {
  const rule = toDecisionRule(policy);
  const voted = counts === null ? null : totalVoted(counts);
  const bps = counts === null ? null : participationBps(counts, totalWeight);
  return {
    yes: counts?.yes ?? null,
    no: counts?.no ?? null,
    abstain: counts?.abstain ?? null,
    noWithVeto: counts?.no_with_veto ?? null,
    totalVoted: voted === null ? null : voted.toString(),
    rule: rule.kind,
    ruleValue:
      rule.kind === "threshold"
        ? rule.threshold
        : rule.kind === "percentage"
          ? rule.percentage
          : null,
    totalWeight,
    // Undecidable stays undecidable: no counts, an unrecognized rule, or a
    // percentage rule with no electorate weight all land on null, and null never
    // collapses to `false` on the way to the page.
    meets: counts === null ? null : meetsThreshold(counts, rule, totalWeight),
    participationPercent: bps === null ? null : bpsToPercentString(bps),
  };
}
