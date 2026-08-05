import type { HolderCohortsVM, PanelState } from "~/admin/types";
import { t, type Locale } from "~/i18n";
import { PanelBody, PanelShell, PanelUnavailable } from "./panel";

// §8.8 holder cohort: adoption, retention curves, redemption mix, and the
// banded TVL concentration.
//
// TWO WITHHOLDING STATES ARE RENDERED DIFFERENTLY ON PURPOSE. A cohort below
// the minimum says "withheld — cohort too small to report without identifying
// its members"; a horizon that has not elapsed says "not yet". Both are blank
// cells in a naive table, and an administrator would draw opposite conclusions
// from them.
export function HolderCohort({
  locale,
  state,
}: {
  locale: Locale;
  state: PanelState<HolderCohortsVM>;
}) {
  return (
    <PanelShell title={t(locale, "admin.holders-title")}>
      <PanelBody locale={locale} state={state}>
        {(data) => (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t(locale, "admin.holders-mix")}</h3>
              <ul className="flex flex-wrap gap-4 text-sm">
                <li>
                  {t(locale, "admin.mix-matured")}:{" "}
                  <span className="tabular-nums">{data.redemptionMix.matured}</span>
                </li>
                <li>
                  {t(locale, "admin.mix-expedited")}:{" "}
                  <span className="tabular-nums">{data.redemptionMix.expedited}</span>
                </li>
                <li>
                  {t(locale, "admin.mix-refunded")}:{" "}
                  <span className="tabular-nums">{data.redemptionMix.refunded}</span>
                </li>
                <li>
                  {t(locale, "admin.mix-enqueued")}:{" "}
                  <span className="tabular-nums">{data.redemptionMix.enqueued}</span>
                </li>
              </ul>
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t(locale, "admin.holders-concentration")}</h3>
              {data.concentration.kind === "unavailable" ? (
                <PanelUnavailable locale={locale} reason={data.concentration.reason} />
              ) : (
                <>
                  <ul className="flex flex-wrap gap-4 text-sm">
                    <li>
                      {t(locale, "admin.conc-top1")}:{" "}
                      <span className="tabular-nums">{data.concentration.data.top1Percent}%</span>
                    </li>
                    <li>
                      {t(locale, "admin.conc-top5")}:{" "}
                      <span className="tabular-nums">{data.concentration.data.top5Percent}%</span>
                    </li>
                    <li>
                      {t(locale, "admin.conc-top10")}:{" "}
                      <span className="tabular-nums">{data.concentration.data.top10Percent}%</span>
                    </li>
                    <li>
                      {t(locale, "admin.conc-holders")}:{" "}
                      <span className="tabular-nums">{data.concentration.data.holderCount}</span>
                    </li>
                  </ul>
                  {/* Says what the panel deliberately does NOT show, so nobody
                      goes looking for it or reads its absence as an oversight. */}
                  <p className="text-xs text-muted-foreground">
                    {t(locale, "admin.conc-shares-only")}
                  </p>
                </>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t(locale, "admin.holders-adoption")}</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[24rem] text-left text-sm">
                  <caption className="sr-only">{t(locale, "admin.holders-adoption")}</caption>
                  <thead>
                    <tr className="text-xs text-muted-foreground">
                      <th scope="col" className="py-1 pr-3">
                        {t(locale, "admin.col-epoch")}
                      </th>
                      <th scope="col" className="py-1 pr-3">
                        {t(locale, "admin.col-settled")}
                      </th>
                      <th scope="col" className="py-1">
                        {t(locale, "admin.col-new-depositors")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.adoption.map((row) => (
                      <tr key={row.epochIndex} className="border-t">
                        <td className="py-1 pr-3">{row.epochIndex}</td>
                        <td className="py-1 pr-3">{row.endedAt.slice(0, 10)}</td>
                        <td className="py-1 tabular-nums">{row.newDepositors}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.adoptionTruncated ? (
                <p className="text-xs text-muted-foreground">
                  {t(locale, "admin.series-truncated")}
                </p>
              ) : null}
              {/* A DIFFERENT caution from the one above: the depositor set was
                  capped, so the newest cohorts are absent entirely and recent
                  adoption reads low rather than the chart being short. */}
              {data.holdersTruncated ? (
                <p role="note" className="text-xs text-muted-foreground">
                  {t(locale, "admin.holders-truncated")}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t(locale, "admin.holders-retention")}</h3>
              <p className="text-xs text-muted-foreground">
                {t(locale, "admin.retention-minimum", { min: String(data.minCohortSize) })}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-left text-sm">
                  <caption className="sr-only">{t(locale, "admin.holders-retention")}</caption>
                  <thead>
                    <tr className="text-xs text-muted-foreground">
                      <th scope="col" className="py-1 pr-3">
                        {t(locale, "admin.col-cohort")}
                      </th>
                      <th scope="col" className="py-1 pr-3">
                        {t(locale, "admin.col-cohort-size")}
                      </th>
                      {[1, 3, 6, 12].map((horizon) => (
                        <th key={horizon} scope="col" className="py-1 pr-3">
                          +{horizon}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.curves.map((curve) => (
                      <tr key={curve.cohortEpoch} className="border-t">
                        <td className="py-1 pr-3">{curve.cohortEpoch}</td>
                        <td className="py-1 pr-3 tabular-nums">{curve.cohortSize}</td>
                        {curve.points.map((point) => (
                          <td key={point.horizon} className="py-1 pr-3 tabular-nums">
                            {point.retainedPercent !== null ? (
                              `${point.retainedPercent}%`
                            ) : curve.belowMinimum ? (
                              // WITHHELD. Not the same as "not yet".
                              <span title={t(locale, "admin.panel-below-minimum")}>
                                {t(locale, "admin.retention-withheld")}
                              </span>
                            ) : (
                              <span title={t(locale, "admin.retention-not-yet-long")}>
                                {t(locale, "admin.retention-not-yet")}
                              </span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.retentionTruncated ? (
                <p className="text-xs text-muted-foreground">
                  {t(locale, "admin.series-truncated")}
                </p>
              ) : null}
            </div>
          </div>
        )}
      </PanelBody>
    </PanelShell>
  );
}
