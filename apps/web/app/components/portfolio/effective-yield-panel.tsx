import { StepChart } from "~/components/charts/step-chart";
import { t, type Locale } from "~/i18n";
import { bpsToPercent } from "~/learn/amounts";
import type { YieldPointVM } from "~/portfolio/types";

// §8.2 effective-yield panel: the single highest-trust view,
// "am I getting what the headline says?". Headline effective APR is §14.12
// cold-gated (null renders "first epoch not yet settled", never a zero). The
// chart pairs the holder's per-settlement APR against the program's net APR
// via the extended StepChart `compare` prop; below two aligned settlements the
// cold explainer renders instead of an empty chart (the nav-step-chart rule).

type AlignedPoint = YieldPointVM & { personalAprBps: number; netAprBps: number };

export function EffectiveYieldPanel({
  locale,
  effectiveAprBps,
  yieldByEpoch,
  yieldTruncated = false,
}: {
  locale: Locale;
  effectiveAprBps: number | null;
  yieldByEpoch: YieldPointVM[];
  yieldTruncated?: boolean;
}) {
  // Both lines must exist for the same settlement, or the comparison lies.
  const aligned = yieldByEpoch.filter(
    (p): p is AlignedPoint => p.personalAprBps !== null && p.netAprBps !== null,
  );

  return (
    <section aria-label={t(locale, "portfolio.yield-title")} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "portfolio.yield-title")}</h2>

      <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
        <span className="text-xs text-muted-foreground">{t(locale, "portfolio.yield-apr-label")}</span>
        {effectiveAprBps === null ? (
          <span className="text-sm text-muted-foreground">{t(locale, "portfolio.yield-cold")}</span>
        ) : (
          <>
            <span className="text-2xl font-semibold tabular-nums">{`${bpsToPercent(effectiveAprBps)}%`}</span>
            <span className="text-xs text-muted-foreground">{t(locale, "portfolio.yield-apr-caption")}</span>
          </>
        )}
      </div>

      {aligned.length < 2 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "portfolio.yield-below-two")}
        </p>
      ) : (
        <StepChart
          title={t(locale, "portfolio.yield-chart-title")}
          caption={t(locale, "portfolio.yield-chart-caption")}
          showTableLabel={t(locale, "chart.show-table")}
          showChartLabel={t(locale, "chart.show-chart")}
          points={aligned.map((p) => p.personalAprBps / 100)}
          compare={{
            points: aligned.map((p) => p.netAprBps / 100),
            label: t(locale, "portfolio.yield-series-program"),
            seriesLabel: t(locale, "portfolio.yield-series-personal"),
          }}
          firstXLabel={`#${aligned[0]!.epochIndex}`}
          lastXLabel={`#${aligned[aligned.length - 1]!.epochIndex}`}
          formatAxisValue={(value) => `${value.toFixed(2)}%`}
          tableHeaders={[
            t(locale, "learn.chart-col-settlement"),
            t(locale, "portfolio.yield-col-personal"),
            t(locale, "portfolio.yield-col-program"),
          ]}
          tableRows={aligned.map((p) => [
            String(p.epochIndex),
            `${bpsToPercent(p.personalAprBps)}%`,
            `${bpsToPercent(p.netAprBps)}%`,
          ])}
        />
      )}

      {yieldTruncated ? (
        <p className="text-xs text-muted-foreground">{t(locale, "portfolio.yield-truncated")}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t(locale, "portfolio.yield-gap-note")}</p>
    </section>
  );
}
