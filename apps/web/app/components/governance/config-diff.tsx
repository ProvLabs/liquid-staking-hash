// The `update_config` DIFF VIEW (§8.7's named requirement).
// Presentation-only over `configDiffRows`'s view models.
//
// THE THING THIS MUST GET RIGHT: the contract changes ONLY the fields a
// proposal supplies, so a diff that showed just "here are the new values" would
// leave the reader unable to tell what is NOT changing — and on a governance
// proposal, "which settings does this leave alone" is half the question. Every
// one of the ten fields is therefore rendered on every render, with untouched
// fields VISIBLY untouched rather than omitted.
//
// The third state is the subtle one: "not supplied" and "supplied as the current
// value" are DIFFERENT messages on the wire (one omits the key, one sets it to
// the same number) even though the contract's merge makes them equivalent. The
// proposer is told which they built.

import { t, type Locale } from "~/i18n";
import type { ConfigDiffRow } from "~/governance/templates";

export function ConfigDiff({ locale, rows }: { locale: Locale; rows: ConfigDiffRow[] }) {
  return (
    <section className="flex flex-col gap-2" aria-label={t(locale, "governance.diff-title")}>
      <h3 className="text-sm font-medium">{t(locale, "governance.diff-title")}</h3>
      <p className="text-xs text-muted-foreground">{t(locale, "governance.diff-note")}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1 pr-3">
                {t(locale, "governance.diff-field")}
              </th>
              <th scope="col" className="py-1 pr-3">
                {t(locale, "governance.diff-current")}
              </th>
              <th scope="col" className="py-1">
                {t(locale, "governance.diff-proposed")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t align-top">
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  {t(locale, row.labelKey)}
                </th>
                <td className="py-1 pr-3 font-mono text-xs">
                  {/* A failed live `Config {}` read renders as "could not be
                      read", never as 0 — on a bps field a fabricated zero
                      reads as a real setting rather than as a gap. */}
                  {row.current === null
                    ? t(locale, "governance.diff-current-unknown")
                    : row.current}
                </td>
                <td className="py-1 font-mono text-xs">
                  {row.state === "untouched" ? (
                    <span className="text-muted-foreground">
                      {t(locale, "governance.diff-untouched")}
                    </span>
                  ) : row.state === "unchanged" ? (
                    <span>
                      {row.proposed}{" "}
                      <span className="text-muted-foreground">
                        ({t(locale, "governance.diff-same")})
                      </span>
                    </span>
                  ) : (
                    <span style={{ color: "var(--status-warning)" }}>{row.proposed}</span>
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
