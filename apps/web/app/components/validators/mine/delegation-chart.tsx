import { StepChart } from "~/components/charts/step-chart";
import { t, type Locale } from "~/i18n";
import type { DelegationHistoryVM } from "~/validators/mine-types";

// §8.6 program-delegation history. Step-after, like every series in this app:
// the program's delegation changes only at epoch settlement, so interpolating
// between epochs would draw movement that never happened (§13).
//
// ONE series deliberately. Commission and TIP live in the epoch table instead:
// they are orders of magnitude smaller than the delegation, so plotting them on
// the same axis would flatten one of them into the baseline, and a second axis
// is never the answer (dataviz: never a dual-axis chart). The table toggle the
// shared chart provides is what makes the numbers readable — the chart carries
// the shape, the table carries the values.

export function DelegationChart({
  locale,
  history,
}: {
  locale: Locale;
  history: DelegationHistoryVM | null;
}) {
  if (history === null) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">{t(locale, "operator.delegation-title")}</h2>
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "operator.delegation-unavailable")}
        </p>
      </section>
    );
  }

  if (history.points.length < 2) {
    // One settled epoch is not a series. Say so rather than draw a flat line
    // that implies a trend (the nav-step-chart cold-state convention).
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">{t(locale, "operator.delegation-title")}</h2>
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "operator.delegation-cold")}
        </p>
      </section>
    );
  }

  return (
    <section aria-label={t(locale, "operator.delegation-title")} className="flex flex-col gap-2">
      <h2 className="text-xl font-semibold">{t(locale, "operator.delegation-title")}</h2>
      <StepChart
        title={t(locale, "operator.delegation-title")}
        caption={t(locale, "operator.delegation-caption")}
        showTableLabel={t(locale, "operator.show-table")}
        showChartLabel={t(locale, "operator.show-chart")}
        points={history.points}
        firstXLabel={t(locale, "operator.epoch-n", { epoch: history.epochLabels[0]! })}
        lastXLabel={t(locale, "operator.epoch-n", {
          epoch: history.epochLabels[history.epochLabels.length - 1]!,
        })}
        formatAxisValue={(value) => value.toFixed(2)}
        tableHeaders={[t(locale, "operator.epoch-header"), t(locale, "operator.delegation-header")]}
        tableRows={history.rows}
      />
      {history.truncated ? (
        <p className="text-xs text-muted-foreground">{t(locale, "operator.history-truncated")}</p>
      ) : null}
    </section>
  );
}
