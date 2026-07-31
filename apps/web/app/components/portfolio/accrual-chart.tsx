import { StepChart, type StepMarker } from "~/components/charts/step-chart";
import { t, type Locale } from "~/i18n";
import type { AccrualVM } from "~/portfolio/types";

// §8.2 accrual tracker: the holder's HASH value at each event and
// monthly settlement, step-after (nothing interpolated, §13). Deposit/redeem
// markers ride the line (filled "in", hollow "out") and also appear in the
// table's Event column so the marker data is not color- or shape-only. Cold
// states follow the nav-step-chart convention; a truncated marker set is
// flagged, never silently dropped (§2.3 markers_truncated).

const IN_KINDS = new Set(["swap_in", "transfer_in", "redemption_refund"]);

function direction(kind: string): "in" | "out" {
  return IN_KINDS.has(kind) ? "in" : "out";
}

function dateOf(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : iso;
}

export function AccrualChart({ locale, accrual }: { locale: Locale; accrual: AccrualVM | null }) {
  if (accrual === null) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">{t(locale, "portfolio.accrual-title")}</h2>
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "portfolio.accrual-unavailable")}
        </p>
      </section>
    );
  }

  if (accrual.points.length < 2) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">{t(locale, "portfolio.accrual-title")}</h2>
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "portfolio.accrual-cold")}
        </p>
      </section>
    );
  }

  const eventByTime = new Map<string, string>();
  const markers: StepMarker[] = [];
  for (const marker of accrual.markers) {
    const index = accrual.points.findIndex((p) => p.time === marker.time);
    if (index === -1) continue;
    const kind = direction(marker.kind);
    const event = t(locale, kind === "in" ? "portfolio.marker-in" : "portfolio.marker-out");
    const label = t(locale, "portfolio.marker-label", { event, shares: marker.sharesDisplay });
    markers.push({ index, kind, label });
    eventByTime.set(marker.time, label);
  }

  return (
    <section aria-label={t(locale, "portfolio.accrual-title")} className="flex flex-col gap-2">
      <h2 className="text-xl font-semibold">{t(locale, "portfolio.accrual-title")}</h2>
      <StepChart
        title={t(locale, "portfolio.accrual-title")}
        caption={t(locale, "portfolio.accrual-caption")}
        showTableLabel={t(locale, "chart.show-table")}
        showChartLabel={t(locale, "chart.show-chart")}
        points={accrual.points.map((p) => p.valueHash)}
        markers={markers}
        firstXLabel={dateOf(accrual.points[0]!.time)}
        lastXLabel={dateOf(accrual.points[accrual.points.length - 1]!.time)}
        formatAxisValue={(value) => value.toFixed(4)}
        tableHeaders={[
          t(locale, "portfolio.accrual-col-time"),
          t(locale, "portfolio.accrual-col-value"),
          t(locale, "portfolio.accrual-col-event"),
        ]}
        tableRows={accrual.points.map((p) => [
          dateOf(p.time),
          p.valueHash.toFixed(4),
          eventByTime.get(p.time) ?? "",
        ])}
      />
      {accrual.historyTruncated ? (
        <p className="text-xs text-muted-foreground">
          {t(locale, "portfolio.accrual-history-truncated")}
        </p>
      ) : null}
      {accrual.truncated ? (
        <p className="text-xs text-muted-foreground">{t(locale, "portfolio.accrual-truncated")}</p>
      ) : null}
    </section>
  );
}
