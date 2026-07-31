import { formatDuration, formatInstant, shortAddress } from "~/governance/format";
import { EXECUTOR_KEYS, STATUS_KEYS } from "~/governance/labels";
import type { ProposalDetailVM } from "~/governance/types";
import { t, type Locale } from "~/i18n";
import { PlaneBadge } from "./plane-badge";

// The detail page's identity block: what this proposal is, who proposed it,
// when it closes, and — separately from its status — how its execution went.
//
// `status` and `executorResult` are shown as two facts because they ARE two:
// "accepted + failure" is a real pair that status alone cannot express, and it
// is the pair an administrator most needs to see. No verify link is rendered
// (D8): the console has no governance panel, and a pruned proposal has nothing
// on chain to link to at all.

export function ProposalHeader({
  locale,
  proposal,
}: {
  locale: Locale;
  proposal: ProposalDetailVM;
}) {
  const ended = proposal.status !== "submitted";
  return (
    <header className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t(locale, "governance.proposal-heading", { id: proposal.proposalId })}
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">
        {proposal.title === "" ? t(locale, "governance.untitled") : proposal.title}
      </h1>

      <p className="text-sm">
        {t(locale, STATUS_KEYS[proposal.status])} ·{" "}
        {t(locale, EXECUTOR_KEYS[proposal.executorResult])}
      </p>
      <p>
        <PlaneBadge
          locale={locale}
          plane={proposal.plane}
          observedHeight={proposal.observedHeight}
        />
      </p>

      {proposal.pruned ? (
        <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "governance.plane-pruned")}
        </p>
      ) : null}

      <p className="text-sm text-muted-foreground">
        {proposal.summary === "" ? t(locale, "governance.no-summary") : proposal.summary}
      </p>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t(locale, "governance.policy-label")}</dt>
          <dd className="font-mono text-xs" title={proposal.policyAddress}>
            {shortAddress(proposal.policyAddress)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t(locale, "governance.proposers")}</dt>
          <dd className="font-mono text-xs">
            {proposal.proposers.length === 0
              ? t(locale, "governance.na")
              : proposal.proposers.map((p) => (
                  <span key={p} className="mr-2 inline-block" title={p}>
                    {shortAddress(p)}
                  </span>
                ))}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t(locale, "governance.submitted-at")}</dt>
          <dd>
            <time dateTime={proposal.submitTime}>
              {formatInstant(proposal.submitTime) ?? t(locale, "governance.na")}
            </time>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {ended ? t(locale, "governance.voting-ended") : t(locale, "governance.voting-ends")}
          </dt>
          <dd>
            <time dateTime={proposal.votingPeriodEnd}>
              {formatInstant(proposal.votingPeriodEnd) ?? t(locale, "governance.na")}
            </time>
            {/* Secondary, and labeled approximate: it is derived from the
                server clock, so it is a hint about the absolute time above it
                rather than a countdown anyone should act on (§7 Q2). */}
            {proposal.votingEndsInSeconds === null ? null : (
              <span className="ml-2 text-xs text-muted-foreground">
                {t(locale, "governance.voting-ends-approx", {
                  duration: formatDuration(locale, proposal.votingEndsInSeconds),
                })}
              </span>
            )}
          </dd>
        </div>
      </dl>

      {proposal.proposersTruncated ? (
        <p className="text-xs text-muted-foreground">
          {t(locale, "governance.proposers-truncated")}
        </p>
      ) : null}

      {/* Submit provenance is nullable BY DESIGN: a proposal first seen by a
          height-pinned state read has no submit transaction, and null is honest
          where a fabricated height would not be. */}
      <p className="text-xs text-muted-foreground">
        {proposal.txhash === null
          ? t(locale, "governance.submit-tx-unknown")
          : `${t(locale, "governance.submit-tx")}: ${proposal.txhash}`}
      </p>
    </header>
  );
}
