import type { PanelState, ProgramHealthVM } from "~/admin/types";
import { t, type Locale } from "~/i18n";
import { PanelBody, PanelShell } from "./panel";

// §8.8 program-health header: depositor count plus the TVL / net-APR / net-flow
// trend. Presentation only — every "n/a" decision was made in admin.server.ts.
//
// A net-outflow epoch is marked with a WORD and a sign, not a colour: the
// accrued-gain precedent, so the direction survives for a reader who does not
// perceive the colour.
export function ProgramHealth({
  locale,
  state,
}: {
  locale: Locale;
  state: PanelState<ProgramHealthVM>;
}) {
  return (
    <PanelShell title={t(locale, "admin.health-title")}>
      <PanelBody locale={locale} state={state}>
        {(data) => (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {t(locale, "admin.health-depositors")}:{" "}
              <span className="font-medium">
                {/* Null is "we cannot count", not zero depositors. */}
                {data.depositorCount === null
                  ? t(locale, "admin.panel-na")
                  : data.depositorCount.toLocaleString("en-US")}
              </span>
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <caption className="sr-only">{t(locale, "admin.health-table-caption")}</caption>
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th scope="col" className="py-1 pr-3">
                      {t(locale, "admin.col-epoch")}
                    </th>
                    <th scope="col" className="py-1 pr-3">
                      {t(locale, "admin.col-settled")}
                    </th>
                    <th scope="col" className="py-1 pr-3">
                      {t(locale, "admin.col-tvl")}
                    </th>
                    <th scope="col" className="py-1 pr-3">
                      {t(locale, "admin.col-net-apr")}
                    </th>
                    <th scope="col" className="py-1">
                      {t(locale, "admin.col-net-flow")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.points.map((point) => (
                    <tr key={point.epochIndex} className="border-t">
                      <td className="py-1 pr-3">{point.epochIndex}</td>
                      <td className="py-1 pr-3">{point.endedAt.slice(0, 10)}</td>
                      <td className="py-1 pr-3 tabular-nums">{point.tvvHash}</td>
                      <td className="py-1 pr-3 tabular-nums">
                        {point.netAprPercent === null
                          ? t(locale, "admin.panel-na")
                          : `${point.netAprPercent}%`}
                      </td>
                      <td className="py-1 tabular-nums">
                        {point.netDepositsHash}
                        {point.netOutflow ? (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({t(locale, "admin.net-outflow")})
                          </span>
                        ) : null}
                      </td>
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
