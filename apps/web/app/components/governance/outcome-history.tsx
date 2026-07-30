import { formatInstant, shortAddress } from "~/governance/format";
import { VOTE_OPTION_KEYS } from "~/governance/labels";
import type { VoteVM } from "~/governance/types";
import { t, type Locale } from "~/i18n";

// The recorded vote trail — §8.7's "outcome history" at proposal scope.
//
// The empty state is the honest one and it is worth reading: x/group DELETES a
// proposal's votes at the voting-period-end tally, even when it passes. So for
// anything closed, "no votes recorded" can mean either that nobody voted or
// that the votes were pruned before the indexer mirrored them, and the copy says
// both rather than implying the first.
//
// A vote's weight is nullable because the module's `Vote` payload has NO weight
// field: it has to be resolved from the member set at the vote height, and null
// means "not recoverable" — never 0, which would misstate how a proposal passed.

export function OutcomeHistory({
  locale,
  votes,
  truncated,
}: {
  locale: Locale;
  votes: VoteVM[];
  truncated: boolean;
}) {
  const title = t(locale, "governance.votes-title");
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{title}</h2>

      {votes.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "governance.votes-empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {votes.map((vote) => (
            <li key={`${vote.voter}:${vote.submitTime}`} className="rounded-lg border bg-card p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-xs" title={vote.voter}>
                  {shortAddress(vote.voter)}
                </span>
                <span>{t(locale, VOTE_OPTION_KEYS[vote.option])}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                <time dateTime={vote.submitTime}>
                  {formatInstant(vote.submitTime) ?? t(locale, "governance.na")}
                </time>
                {" · "}
                {vote.weight === null
                  ? t(locale, "governance.vote-weight-unknown")
                  : `${t(locale, "governance.member-weight")} ${vote.weight}`}
                {vote.liveOnly ? ` · ${t(locale, "governance.vote-live-only")}` : null}
              </p>
            </li>
          ))}
        </ul>
      )}

      {truncated ? (
        <p className="text-xs text-muted-foreground">{t(locale, "governance.votes-truncated")}</p>
      ) : null}
    </section>
  );
}
