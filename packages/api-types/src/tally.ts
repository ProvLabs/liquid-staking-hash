// The tally-vs-threshold comparison, shared by services/api and apps/web
// (M7.1 decision D17).
//
// WHY IT IS SHARED RATHER THAN WRITTEN TWICE. This is the `navHashPerShare`
// precedent, and that helper exists because a duplicated amount formula drifted
// once already (app-spec §9.4 revision (d)). "Has this proposal passed?" is the
// same shape of hazard: the API decides it for a mirrored historical proposal
// whose threshold was snapshotted at submit, while the web tier decides it for a
// live one against the current policy. Two implementations would eventually
// disagree about whether the same proposal passed — a disagreement a user would
// see as the program contradicting itself about governance.
//
// BIGINT ONLY. x/group weights are unbounded integers with no protocol ceiling:
// they are sums of member weights, not token amounts, so `Uint128` would be an
// invented bound and a JS number would corrupt them silently past 2^53. Counts
// arrive as canonical decimal STRINGS and are compared as BigInt.
//
// Zero runtime dependencies, like everything else in this package.

/** The four tally counts, as canonical decimal strings. */
export interface GovTallyCounts {
  readonly yes: string;
  readonly no: string;
  readonly abstain: string;
  readonly no_with_veto: string;
}

/**
 * A decision rule, in the two forms x/group ships plus the honest third case.
 * `unknown` is not a defensive afterthought: a policy type this build does not
 * recognize must render as "not understood" rather than be scored against a
 * guessed rule, and `meetsThreshold` returns null for it.
 */
export type GovDecisionRule =
  | { readonly kind: "threshold"; readonly threshold: string }
  | { readonly kind: "percentage"; readonly percentage: string }
  | { readonly kind: "unknown" };

/** Canonical unsigned decimal string → bigint, or null if it is not one. Null
 * rather than a throw: a malformed count from the wire must degrade to "cannot
 * decide", never crash a page or score as zero. */
function toCount(value: string): bigint | null {
  return /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
}

/**
 * Total weight cast, across every option. `abstain` counts toward participation
 * but never toward passage, which is why it is summed here and excluded below.
 */
export function totalVoted(counts: GovTallyCounts): bigint | null {
  let sum = 0n;
  for (const raw of [counts.yes, counts.no, counts.abstain, counts.no_with_veto]) {
    const part = toCount(raw);
    // Partial credit would be worse than none: summing the readable counts and
    // ignoring an unreadable one yields a confident, wrong participation figure.
    if (part === null) return null;
    sum += part;
  }
  return sum;
}

/**
 * Has this tally met its rule?
 *
 * `null` means UNDECIDABLE — an unrecognized policy type, a malformed count, or a
 * percentage rule with no electorate weight to measure against. Null is a
 * first-class answer here: the alternative is a boolean that looks authoritative
 * while resting on a guess, and app-spec §12.1 forbids exactly that.
 *
 * `totalWeight` is the electorate's total weight, needed only by percentage
 * rules. A threshold rule ignores it, which is why it is optional.
 *
 * THRESHOLD is compared against YES weight alone — x/group's
 * `ThresholdDecisionPolicy` passes when yes-weight reaches the threshold, and
 * `no`/`no_with_veto` do not subtract from it. Writing it as `yes - no` would be a
 * plausible-looking reimplementation of a different module's rule.
 */
export function meetsThreshold(
  counts: GovTallyCounts,
  rule: GovDecisionRule,
  totalWeight?: string | null,
): boolean | null {
  const yes = toCount(counts.yes);
  if (yes === null) return null;

  if (rule.kind === "threshold") {
    const threshold = toCount(rule.threshold);
    if (threshold === null) return null;
    return yes >= threshold;
  }

  if (rule.kind === "percentage") {
    // The percentage is a DECIMAL FRACTION ("0.5"), not an integer and not bps.
    // Scaled to an integer ratio so the comparison stays exact: floats would
    // decide a governance outcome by rounding.
    const total = totalWeight === null || totalWeight === undefined ? null : toCount(totalWeight);
    if (total === null || total === 0n) return null;
    const scaled = percentageToScaled(rule.percentage);
    if (scaled === null) return null;
    // yes/total >= p  ⇔  yes * SCALE >= p_scaled * total
    return yes * PERCENTAGE_SCALE >= scaled * total;
  }

  return null;
}

/** Fixed-point scale for a percentage rule: 18 places is well past anything
 * x/group emits, and the arithmetic is exact at any scale because it is integer. */
const PERCENTAGE_SCALE = 10n ** 18n;

/** `"0.5"` → `5 * 10^17`. Null on anything that is not a plain decimal fraction in
 * [0, 1] — no exponents, no signs, no separators, and nothing above 1. A
 * percentage over 1 is not a stricter rule, it is an unsatisfiable one, and
 * scoring against it would report every proposal failed. */
export function percentageToScaled(percentage: string): bigint | null {
  if (!/^(0(\.[0-9]+)?|1(\.0+)?)$/.test(percentage)) return null;
  const [whole, fraction = ""] = percentage.split(".");
  const digits = fraction.slice(0, 18).padEnd(18, "0");
  return BigInt(whole!) * PERCENTAGE_SCALE + BigInt(digits === "" ? "0" : digits);
}

/**
 * Fraction of the electorate that has voted, in basis points, or null when it
 * cannot be computed. Presentation only — never an input to passage.
 */
export function participationBps(
  counts: GovTallyCounts,
  totalWeight: string | null | undefined,
): number | null {
  const voted = totalVoted(counts);
  const total = totalWeight === null || totalWeight === undefined ? null : toCount(totalWeight);
  if (voted === null || total === null || total === 0n) return null;
  // Integer math throughout, then a safe-integer result: 0..10 000 always is.
  return Number((voted * 10_000n) / total);
}
