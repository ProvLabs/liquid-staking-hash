import type { Envelope, EpochRow } from "@nvhash/api-types";
import { StepChart } from "~/components/charts/step-chart";
import { VerifyLink } from "~/components/verify-link";
import { t, type Locale } from "~/i18n";
import { bpsToPercent, formatBaseAmount, HASH_EXPONENT } from "~/learn/amounts";

// §8.5 program history views over the real /epochs series: NAV, TVV, and net
// APR per monthly settlement. This section is chain-derived (unlike the
// market plane) so it carries the overview verify link. Geometry floats are
// pixel math only; displayed values are BigInt-formatted strings. The
// NAV-vs-market pairing activates by data presence when a market opens
// (plan 4.4 open question 1: the caption names the forthcoming line).

function chartRows(epochs: Envelope<EpochRow[]> | null): EpochRow[] {
  // Newest-first from the API; charts read oldest → newest.
  return epochs === null ? [] : [...epochs.data].reverse();
}

function ColdState({ locale, epochs, title }: { locale: Locale; epochs: unknown; title: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-base font-medium">{title}</h3>
      <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        {epochs === null
          ? t(locale, "market.history-unavailable")
          : t(locale, "market.history-empty")}
      </p>
    </section>
  );
}

export function History({
  locale,
  epochs,
}: {
  locale: Locale;
  epochs: Envelope<EpochRow[]> | null;
}) {
  const rows = chartRows(epochs);
  const navRows = rows.filter((row): row is EpochRow & { nav: string } => row.nav !== null);
  const aprRows = rows.filter(
    (row): row is EpochRow & { net_apr_bps: number } => row.net_apr_bps !== null,
  );
  const toggles = {
    showTableLabel: t(locale, "chart.show-table"),
    showChartLabel: t(locale, "chart.show-chart"),
  };
  const settledCol = t(locale, "learn.chart-col-settlement");
  const dateOf = (row: EpochRow) => new Date(row.ended_at).toISOString().slice(0, 10);

  return (
    <section aria-label={t(locale, "market.history-title")} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">{t(locale, "market.history-title")}</h2>
        {/* Anchored to the LATEST settled epoch — the row this section's
            newest figures derive from. The chart tables are generated cells,
            so the section link is the anchor's carrier, one per surface. */}
        <VerifyLink
          locale={locale}
          target="overview"
          anchor={rows.length > 0 ? { epochIndex: rows[rows.length - 1]!.epoch_index } : undefined}
        />
      </div>
      {navRows.length < 2 ? (
        <ColdState locale={locale} epochs={epochs} title={t(locale, "market.history-nav-title")} />
      ) : (
        <StepChart
          title={t(locale, "market.history-nav-title")}
          caption={t(locale, "market.history-nav-caption")}
          {...toggles}
          points={navRows.map((row) => Number.parseFloat(row.nav))}
          firstXLabel={`#${navRows[0]!.epoch_index}`}
          lastXLabel={`#${navRows[navRows.length - 1]!.epoch_index}`}
          formatAxisValue={(value) => value.toFixed(4)}
          tableHeaders={[
            settledCol,
            t(locale, "learn.chart-col-ended"),
            t(locale, "learn.chart-col-nav"),
          ]}
          tableRows={navRows.map((row) => [String(row.epoch_index), dateOf(row), row.nav])}
        />
      )}
      {rows.length < 2 ? (
        <ColdState locale={locale} epochs={epochs} title={t(locale, "market.history-tvv-title")} />
      ) : (
        <StepChart
          title={t(locale, "market.history-tvv-title")}
          caption={t(locale, "market.history-tvv-caption")}
          {...toggles}
          points={rows.map((row) => Number.parseFloat(row.tvv) / 10 ** HASH_EXPONENT)}
          firstXLabel={`#${rows[0]!.epoch_index}`}
          lastXLabel={`#${rows[rows.length - 1]!.epoch_index}`}
          formatAxisValue={(value) => value.toFixed(2)}
          tableHeaders={[
            settledCol,
            t(locale, "learn.chart-col-ended"),
            t(locale, "market.history-tvv-col"),
          ]}
          tableRows={rows.map((row) => [
            String(row.epoch_index),
            dateOf(row),
            formatBaseAmount(BigInt(row.tvv), HASH_EXPONENT, 2),
          ])}
        />
      )}
      {aprRows.length < 2 ? (
        <ColdState locale={locale} epochs={epochs} title={t(locale, "market.history-apr-title")} />
      ) : (
        <StepChart
          title={t(locale, "market.history-apr-title")}
          caption={t(locale, "market.history-apr-caption")}
          {...toggles}
          points={aprRows.map((row) => row.net_apr_bps / 100)}
          firstXLabel={`#${aprRows[0]!.epoch_index}`}
          lastXLabel={`#${aprRows[aprRows.length - 1]!.epoch_index}`}
          formatAxisValue={(value) => `${value.toFixed(2)}%`}
          tableHeaders={[
            settledCol,
            t(locale, "learn.chart-col-ended"),
            t(locale, "market.history-apr-col"),
          ]}
          tableRows={aprRows.map((row) => [
            String(row.epoch_index),
            dateOf(row),
            `${bpsToPercent(row.net_apr_bps)}%`,
          ])}
        />
      )}
    </section>
  );
}
