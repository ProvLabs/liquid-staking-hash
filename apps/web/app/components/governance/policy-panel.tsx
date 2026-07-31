import { shortAddress } from "~/governance/format";
import type { LiveGroupVM, LivePlaneState, PolicyVM } from "~/governance/types";
import { t, type Locale } from "~/i18n";

// The program's group policies (D1: the set, never "the" policy) and the live
// group behind them.
//
// A policy can be in the live set, in the mirror, or both, and the three are
// different facts: live-only means it exists on chain but has never carried a
// proposal; mirrored-only means it carried proposals and is not in the live set
// now (or the live read failed). The badge says which, rather than merging them
// into one list that implies they were all read the same way.

export function PolicyPanel({
  locale,
  state,
  policies,
  group,
  truncated,
}: {
  locale: Locale;
  state: LivePlaneState;
  policies: PolicyVM[];
  group: LiveGroupVM | null;
  truncated: boolean;
}) {
  return (
    <section aria-label={t(locale, "governance.policies-title")} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "governance.policies-title")}</h2>

      {/* The two live-plane failures are DIFFERENT claims and are said
          differently: "this deployment has no group behind its admin" is a fact
          about the deployment, "we could not read the chain" is a fact about
          this request (§3.4 R2). */}
      {state === "not-governed" ? (
        <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "governance.not-governed")}
        </p>
      ) : null}
      {state === "unavailable" ? (
        <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "governance.live-unavailable")}
        </p>
      ) : null}

      {group !== null ? (
        <p className="text-sm text-muted-foreground">
          {t(locale, "governance.group-summary", {
            groupId: group.groupId,
            version: group.version,
            members: group.memberCount,
            weight: group.totalWeight,
          })}
        </p>
      ) : null}

      {policies.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "governance.policies-empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {policies.map((policy) => (
            <li key={policy.address} className="rounded-lg border bg-card p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-xs" title={policy.address}>
                  {policy.metadata ?? shortAddress(policy.address)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(
                    locale,
                    policy.live ? "governance.policy-live" : "governance.policy-historical",
                  )}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {policy.rule === "threshold" && policy.ruleValue !== null
                  ? t(locale, "governance.policy-rule-threshold", { value: policy.ruleValue })
                  : policy.rule === "percentage" && policy.ruleValue !== null
                    ? t(locale, "governance.policy-rule-percentage", { value: policy.ruleValue })
                    : t(locale, "governance.policy-rule-unknown")}
                {policy.votingPeriod === null
                  ? null
                  : ` · ${t(locale, "governance.policy-voting-period", { period: policy.votingPeriod })}`}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {/* Null is "not in the mirror", which is not "zero proposals". */}
                {policy.proposalCount === null
                  ? t(locale, "governance.policy-proposals-none")
                  : t(locale, "governance.policy-proposals", { count: policy.proposalCount })}
              </p>
            </li>
          ))}
        </ul>
      )}

      {truncated ? (
        <p className="text-xs text-muted-foreground">
          {t(locale, "governance.policies-truncated")}
        </p>
      ) : null}
    </section>
  );
}
