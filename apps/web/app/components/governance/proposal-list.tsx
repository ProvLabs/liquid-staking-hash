import { Link } from "react-router";

import { formatInstant } from "~/governance/format";
import { STATUS_KEYS } from "~/governance/labels";
import type { ProposalSummaryVM } from "~/governance/types";
import { t, type Locale } from "~/i18n";
import { PlaneBadge } from "./plane-badge";

// The §8.7 proposal list. One list with a status filter, open proposals pinned
// above the outcome history (§7 Q1) — rendered as two sections over the same
// component so the reading order is "what needs attention, then what happened".
//
// Every row carries its PLANE. A page that showed an open proposal's mirrored
// tally without saying so would be indistinguishable from one showing the
// chain's, which is the failure §12.1.1 exists to prevent.
//
// No row offers an action: 7.2 is read-only, and the C4 state×affordance matrix
// is entirely "read only" by design.

export function ProposalList({
  locale,
  heading,
  proposals,
  emptyMessage,
}: {
  locale: Locale;
  heading: string;
  proposals: ProposalSummaryVM[];
  emptyMessage: string;
}) {
  return (
    <section aria-label={heading} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{heading}</h2>
      {proposals.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {proposals.map((proposal) => (
            <li key={proposal.proposalId} className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link
                  to={`/governance/${proposal.proposalId}`}
                  className="text-base font-semibold underline underline-offset-4"
                >
                  {proposal.title === "" ? t(locale, "governance.untitled") : proposal.title}
                </Link>
                <span className="text-sm">{t(locale, STATUS_KEYS[proposal.status])}</span>
              </div>

              <p className="mt-1 text-xs text-muted-foreground">
                {t(locale, "governance.proposal-heading", { id: proposal.proposalId })}
              </p>

              <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t(locale, "governance.tally-yes")}</dt>
                  <dd className="tabular-nums">{proposal.tally.yes ?? t(locale, "governance.na")}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">
                    {proposal.status === "submitted"
                      ? t(locale, "governance.voting-ends")
                      : t(locale, "governance.voting-ended")}
                  </dt>
                  <dd>
                    {/* The absolute instant is the FACT. The relative hint below
                        it is computed against the server clock and labeled
                        approximate — never the other way round (§7 Q2). */}
                    <time dateTime={proposal.votingPeriodEnd}>
                      {formatInstant(proposal.votingPeriodEnd) ?? t(locale, "governance.na")}
                    </time>
                  </dd>
                </div>
              </dl>

              <p className="mt-2">
                <PlaneBadge
                  locale={locale}
                  plane={proposal.plane}
                  observedHeight={proposal.observedHeight}
                />
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
