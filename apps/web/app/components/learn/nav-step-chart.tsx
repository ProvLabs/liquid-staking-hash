import type { Envelope, EpochRow } from "@nvhash/api-types";
import { StepChart } from "~/components/charts/step-chart";
import { t, type Locale } from "~/i18n";

// §8.1.1 step chart: NAV per settled epoch, rendered by the shared
// step-after chart (extraction). This adapter owns the Learn cold
// states and the null-NAV filter (an epoch settled with zero shares has no
// NAV); below two plottable rows the cold-start explainer renders
// instead of an empty chart (§8.1 cold-start rule).
type PlottableEpoch = EpochRow & { nav: string };

export function NavStepChart({
  locale,
  epochs,
}: {
  locale: Locale;
  epochs: Envelope<EpochRow[]> | null;
}) {
  // Newest-first from the API; the chart reads oldest → newest.
  const series =
    epochs === null
      ? []
      : epochs.data.filter((row): row is PlottableEpoch => row.nav !== null).reverse();

  if (series.length < 2) {
    // Two honest cold states, kept distinct (§12.1): the API being
    // unreachable is not the same claim as "no epochs settled yet".
    return (
      <section className="flex flex-col gap-2">
        <h3 className="text-base font-medium">{t(locale, "learn.chart-title")}</h3>
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {epochs === null
            ? t(locale, "learn.chart-unavailable")
            : t(locale, "learn.chart-empty")}
        </p>
      </section>
    );
  }

  return (
    <StepChart
      title={t(locale, "learn.chart-title")}
      caption={t(locale, "learn.chart-caption")}
      showTableLabel={t(locale, "chart.show-table")}
      showChartLabel={t(locale, "chart.show-chart")}
      points={series.map((row) => Number.parseFloat(row.nav))}
      firstXLabel={`#${series[0]!.epoch_index}`}
      lastXLabel={`#${series[series.length - 1]!.epoch_index}`}
      formatAxisValue={(value) => value.toFixed(4)}
      tableHeaders={[
        t(locale, "learn.chart-col-settlement"),
        t(locale, "learn.chart-col-ended"),
        t(locale, "learn.chart-col-nav"),
      ]}
      tableRows={series.map((row) => [
        String(row.epoch_index),
        new Date(row.ended_at).toISOString().slice(0, 10),
        row.nav,
      ])}
    />
  );
}
