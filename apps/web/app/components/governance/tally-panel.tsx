import type { TallyVM } from "~/governance/types";
import { t, type Locale } from "~/i18n";

// Tally vs threshold (§8.7). Three properties this markup is responsible for:
//
//   1. Every count renders "n/a" when null. A `0` in place of an unknown count
//      reads as "nobody supports this", which is a different and consequential
//      claim on the page where votes are cast.
//   2. The verdict has THREE states, not two. `meets === null` is
//      "cannot be decided from what is known" — an unrecognized policy type, a
//      malformed count, or a percentage rule with no electorate weight — and it
//      is rendered as its own sentence rather than as "does not pass".
//   3. The rule shown is the proposal's OWN snapshot, and the caption says so.
//      Scoring a historical tally against today's policy would misstate what
//      passed.

export function TallyPanel({ locale, tally }: { locale: Locale; tally: TallyVM }) {
  const na = t(locale, "governance.na");
  const rows: { label: string; value: string }[] = [
    { label: t(locale, "governance.tally-yes"), value: tally.yes ?? na },
    { label: t(locale, "governance.tally-no"), value: tally.no ?? na },
    { label: t(locale, "governance.tally-abstain"), value: tally.abstain ?? na },
    { label: t(locale, "governance.tally-no-with-veto"), value: tally.noWithVeto ?? na },
    { label: t(locale, "governance.tally-total"), value: tally.totalVoted ?? na },
  ];

  return (
    <section aria-label={t(locale, "governance.tally-title")} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "governance.tally-title")}</h2>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>

      <p className="text-sm">
        {tally.rule === "threshold" && tally.ruleValue !== null
          ? t(locale, "governance.tally-threshold", { value: tally.ruleValue })
          : tally.rule === "percentage" && tally.ruleValue !== null
            ? t(locale, "governance.tally-percentage", { value: tally.ruleValue })
            : t(locale, "governance.tally-rule-unknown")}
      </p>

      <p className="text-sm font-semibold">
        {tally.meets === null
          ? t(locale, "governance.tally-meets-unknown")
          : tally.meets
            ? t(locale, "governance.tally-meets-yes")
            : t(locale, "governance.tally-meets-no")}
      </p>

      {tally.participationPercent === null ? null : (
        <p className="text-xs text-muted-foreground">
          {t(locale, "governance.tally-participation", { percent: tally.participationPercent })}
        </p>
      )}

      <p className="text-xs text-muted-foreground">{t(locale, "governance.tally-snapshot-note")}</p>
    </section>
  );
}
