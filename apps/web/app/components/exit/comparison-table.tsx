// The exit-path comparison (app-spec §8.4) — the surface opens with THIS,
// not a form. Two columns: DEX trade (a labeled "coming soon" shell, §14.4)
// and Native redemption. NORMATIVE framing (§8.4): the 60-day guarantee is
// always the number in the promise position; the typical statistic is shown
// only when present and always labeled "typical, not guaranteed" — never
// promoted into the promise. `test/exit-data.test.ts` + the axe/e2e specs
// enforce that the typical figure never occupies the guarantee slot.

import { t, type Locale } from "~/i18n";
import type { TypicalDisplay } from "~/exit/typical";

export function ComparisonTable({ locale, typical }: { locale: Locale; typical: TypicalDisplay }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{t(locale, "exit.comparison-caption")}</caption>
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="p-3" />
            <th scope="col" className="p-3">
              {t(locale, "exit.col-dex")}
              <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {t(locale, "exit.coming-soon")}
              </span>
            </th>
            <th scope="col" className="p-3">{t(locale, "exit.col-native")}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b align-top">
            <th scope="row" className="p-3 font-medium">{t(locale, "exit.row-you-get")}</th>
            <td className="p-3 text-muted-foreground">{t(locale, "exit.dex-you-get")}</td>
            <td className="p-3">{t(locale, "exit.native-you-get")}</td>
          </tr>
          <tr className="border-b align-top">
            <th scope="row" className="p-3 font-medium">{t(locale, "exit.row-timing")}</th>
            <td className="p-3 text-muted-foreground">{t(locale, "exit.dex-timing")}</td>
            <td className="p-3">
              {/* PROMISE POSITION: the guaranteed ceiling, always first and
                  unqualified — the number the copy leans on. */}
              <p className="font-medium">
                {t(locale, "exit.native-guarantee", { days: typical.guaranteeDays })}
              </p>
              {/* The typical statistic, only when sample-sufficient, always
                  labeled "typical, not guaranteed" (§8.4 normative). */}
              {typical.hasTypical ? (
                <p className="mt-1 text-muted-foreground">
                  {t(locale, "exit.native-typical", {
                    median: typical.medianDays ?? 0,
                    p90: typical.p90Days ?? 0,
                  })}
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(locale, "exit.native-typical-withheld")}
                </p>
              )}
            </td>
          </tr>
          <tr className="border-b align-top">
            <th scope="row" className="p-3 font-medium">{t(locale, "exit.row-risks")}</th>
            <td className="p-3 text-muted-foreground">{t(locale, "exit.dex-risks")}</td>
            <td className="p-3">{t(locale, "exit.native-risks")}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
