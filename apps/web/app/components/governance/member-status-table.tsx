import { formatInstant, shortAddress } from "~/governance/format";
import { VOTE_OPTION_KEYS } from "~/governance/labels";
import type { MemberStatus } from "~/governance/types";
import { t, type Locale } from "~/i18n";

// Per-member vote status — §8.7's "who, how, when", and D5's resolution.
//
// The two non-table states are the point of this component. Rendering today's
// member set against a proposal decided by a DIFFERENT electorate would imply
// those members were its voters, and rendering an empty table when the member
// read failed would imply nobody has voted. Both are refused here:
//
//   membership-changed → recorded votes only, with the two group versions named
//   not-checked        → recorded votes only, and an explicit "we did not check"
//
// Highlighting the session's own row is decoration. §8.7 is a PUBLIC read, so
// the address never gates anything — an anonymous visitor sees the same table.

export function MemberStatusTable({
  locale,
  status,
}: {
  locale: Locale;
  status: MemberStatus;
}) {
  const title = t(locale, "governance.members-title");

  if (status.kind === "membership-changed") {
    return (
      <section aria-label={title} className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">{title}</h2>
        <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "governance.members-changed", {
            proposalVersion: status.proposalGroupVersion,
            currentVersion: status.currentGroupVersion,
          })}
        </p>
      </section>
    );
  }

  if (status.kind === "not-checked") {
    return (
      <section aria-label={title} className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">{title}</h2>
        <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "governance.members-not-checked")}
        </p>
      </section>
    );
  }

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-4 font-medium">
                {t(locale, "governance.member-address")}
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                {t(locale, "governance.member-weight")}
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                {t(locale, "governance.member-vote")}
              </th>
              <th scope="col" className="py-2 font-medium">
                {t(locale, "governance.member-voted-at")}
              </th>
            </tr>
          </thead>
          <tbody>
            {status.rows.map((row) => (
              <tr key={row.address} className="border-b last:border-0">
                <td className="py-2 pr-4 font-mono text-xs" title={row.address}>
                  {shortAddress(row.address)}
                  {row.isSession ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({t(locale, "governance.member-you")})
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-4 tabular-nums">{row.weight}</td>
                <td className="py-2 pr-4">
                  {row.vote === null
                    ? t(locale, "governance.member-not-voted")
                    : t(locale, VOTE_OPTION_KEYS[row.vote.option])}
                  {row.vote?.liveOnly ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({t(locale, "governance.vote-live-only")})
                    </span>
                  ) : null}
                </td>
                <td className="py-2 text-xs text-muted-foreground">
                  {row.vote === null ? (
                    "—"
                  ) : (
                    <time dateTime={row.vote.submitTime}>
                      {formatInstant(row.vote.submitTime) ?? t(locale, "governance.na")}
                    </time>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
