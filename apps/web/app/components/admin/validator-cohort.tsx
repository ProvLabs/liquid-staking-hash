import type { PanelState, ValidatorCohortsVM } from "~/admin/types";
import { t, type Locale } from "~/i18n";
import { PanelBody, PanelShell } from "./panel";

// §8.8 validator cohort: enrollment and churn totals, plus the per-epoch
// eligibility / arrears / TIP-participation / purge timeline.
export function ValidatorCohort({
  locale,
  state,
}: {
  locale: Locale;
  state: PanelState<ValidatorCohortsVM>;
}) {
  return (
    <PanelShell title={t(locale, "admin.validators-title")}>
      <PanelBody locale={locale} state={state}>
        {(data) => (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-wrap gap-4 text-sm">
              <li>
                {t(locale, "admin.validators-enrolled")}:{" "}
                <span className="tabular-nums">{data.enrolledNow}</span>
              </li>
              <li>
                {t(locale, "admin.validators-churned")}:{" "}
                <span className="tabular-nums">{data.churnedTotal}</span>
              </li>
            </ul>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <caption className="sr-only">{t(locale, "admin.validators-table-caption")}</caption>
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th scope="col" className="py-1 pr-3">
                      {t(locale, "admin.col-epoch")}
                    </th>
                    <th scope="col" className="py-1 pr-3">
                      {t(locale, "admin.col-sampled")}
                    </th>
                    <th scope="col" className="py-1 pr-3">
                      {t(locale, "admin.col-eligible")}
                    </th>
                    <th scope="col" className="py-1 pr-3">
                      {t(locale, "admin.col-arrears")}
                    </th>
                    <th scope="col" className="py-1 pr-3">
                      {t(locale, "admin.col-tip")}
                    </th>
                    <th scope="col" className="py-1">
                      {t(locale, "admin.col-purged")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.timeline.map((row) => (
                    <tr key={row.epochIndex} className="border-t">
                      <td className="py-1 pr-3">{row.epochIndex}</td>
                      <td className="py-1 pr-3 tabular-nums">{row.sampled}</td>
                      <td className="py-1 pr-3 tabular-nums">{row.eligible}</td>
                      <td className="py-1 pr-3 tabular-nums">{row.inArrears}</td>
                      <td className="py-1 pr-3 tabular-nums">{row.tipPaying}</td>
                      <td className="py-1 tabular-nums">{row.purged}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.truncated ? (
              <p className="text-xs text-muted-foreground">{t(locale, "admin.series-truncated")}</p>
            ) : null}
          </div>
        )}
      </PanelBody>
    </PanelShell>
  );
}
