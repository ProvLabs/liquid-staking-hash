import type { PanelState, UpkeepDistributionVM, UpkeepVM } from "~/admin/types";
import { t, type Locale } from "~/i18n";
import { PanelBody, PanelShell } from "./panel";

// §8.8 upkeep timeliness: lag distributions for the permissionless cranks.
// This is the personas' "upkeep-action lag" signal and doubles as keeper
// monitoring.
//
// THREE DISTRIBUTIONS, AND ONE OF THEM IS PERMANENTLY ABSENT. §8.8 names
// capture-signal cadence gaps, but nothing indexes a capture-signal series, so
// it renders "not collected in this build" rather than an empty histogram —
// which would look like a measured result of zero gaps.
function Distribution({
  locale,
  title,
  state,
}: {
  locale: Locale;
  title: string;
  state: PanelState<UpkeepDistributionVM>;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <PanelBody locale={locale} state={state}>
        {(data) => (
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              {t(locale, "admin.upkeep-median")}:{" "}
              <span className="tabular-nums">
                {data.medianLabel ?? t(locale, "admin.panel-na")}
              </span>
              {" · "}
              {t(locale, "admin.upkeep-p90")}:{" "}
              <span className="tabular-nums">{data.p90Label ?? t(locale, "admin.panel-na")}</span>
              {" · "}
              {t(locale, "admin.upkeep-samples", { count: String(data.sampleCount) })}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[20rem] text-left text-sm">
                <caption className="sr-only">{title}</caption>
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th scope="col" className="py-1 pr-3">
                      {t(locale, "admin.col-lag")}
                    </th>
                    <th scope="col" className="py-1">
                      {t(locale, "admin.col-count")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.buckets.map((bucket) => (
                    <tr key={bucket.label} className="border-t">
                      <td className="py-1 pr-3">{bucket.label}</td>
                      <td className="py-1 tabular-nums">{bucket.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </PanelBody>
    </div>
  );
}

export function UpkeepTimeliness({ locale, upkeep }: { locale: Locale; upkeep: UpkeepVM }) {
  return (
    <PanelShell title={t(locale, "admin.upkeep-title")} caption={t(locale, "admin.upkeep-caption")}>
      <div className="flex flex-col gap-5">
        <Distribution
          locale={locale}
          title={t(locale, "admin.upkeep-epoch-lag")}
          state={upkeep.epochLag}
        />
        <Distribution
          locale={locale}
          title={t(locale, "admin.upkeep-redemption")}
          state={upkeep.redemptionLatency}
        />
        <Distribution
          locale={locale}
          title={t(locale, "admin.upkeep-capture")}
          state={upkeep.captureCadence}
        />
      </div>
    </PanelShell>
  );
}
