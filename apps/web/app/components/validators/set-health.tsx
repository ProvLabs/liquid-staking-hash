import { useState } from "react";

import type { Envelope, ValidatorSetEpochRow } from "@nvhash/api-types";
import { VerifyLink } from "~/components/verify-link";
import { t, type Locale } from "~/i18n";

// §8.6 set-health aggregates: the live eligible count plus the indexed trend
// and churn. Three honest indexed states, kept distinct (§12.1): unavailable
// (API unreachable), empty (no settlements indexed yet), and rows. The trend
// is a small step chart (repo dataviz method: --viz-cat-1, single series
// titled not legended, table view always offered).
const WIDTH = 420;
const HEIGHT = 96;
const PAD = { top: 8, right: 8, bottom: 16, left: 26 };

function trendPath(counts: number[]): string {
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const span = max - min || 1;
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const stepW = innerW / counts.length;
  const y = (count: number) => PAD.top + innerH - ((count - min) / span) * innerH;
  let d = "";
  counts.forEach((count, i) => {
    const x = PAD.left + i * stepW;
    d += i === 0 ? `M ${x} ${y(count)}` : ` L ${x} ${y(count)}`;
    d += ` L ${x + stepW} ${y(count)}`;
  });
  return d;
}

function Tile({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {caption ? <span className="text-xs text-muted-foreground">{caption}</span> : null}
    </div>
  );
}

export function SetHealth({
  locale,
  eligibleCount,
  setHistory,
}: {
  locale: Locale;
  eligibleCount: number | null;
  setHistory: Envelope<ValidatorSetEpochRow[]> | null;
}) {
  const [showTable, setShowTable] = useState(false);
  const na = t(locale, "validators.na");
  // Newest-first from the API; the chart reads oldest → newest.
  const series = setHistory === null ? [] : [...setHistory.data].reverse();
  const latest = series.length > 0 ? series[series.length - 1] : undefined;

  return (
    <section aria-label={t(locale, "validators.health-title")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">{t(locale, "validators.health-title")}</h2>
        <VerifyLink locale={locale} target="validators" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Tile
          label={t(locale, "validators.health-eligible-now")}
          value={eligibleCount !== null ? String(eligibleCount) : na}
        />
        <Tile
          label={t(locale, "validators.health-joined")}
          value={latest ? String(latest.joined) : na}
          caption={t(locale, "validators.health-indexed-caption")}
        />
        <Tile
          label={t(locale, "validators.health-departed")}
          value={latest ? String(latest.departed) : na}
          caption={t(locale, "validators.health-indexed-caption")}
        />
      </div>
      {series.length < 2 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {setHistory === null
            ? t(locale, "validators.health-trend-unavailable")
            : t(locale, "validators.health-trend-empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-medium">{t(locale, "validators.health-trend-title")}</h3>
            <button
              type="button"
              className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
              aria-pressed={showTable}
              onClick={() => setShowTable((value) => !value)}
            >
              {showTable
                ? t(locale, "validators.trend-show-chart")
                : t(locale, "validators.trend-show-table")}
            </button>
          </div>
          {showTable ? (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">
                      {t(locale, "validators.trend-col-settlement")}
                    </th>
                    <th className="px-3 py-2 font-medium">
                      {t(locale, "validators.trend-col-eligible")}
                    </th>
                    <th className="px-3 py-2 font-medium">
                      {t(locale, "validators.trend-col-joined")}
                    </th>
                    <th className="px-3 py-2 font-medium">
                      {t(locale, "validators.trend-col-departed")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {series.map((row) => (
                    <tr key={row.epoch_index} className="border-b last:border-b-0">
                      <td className="px-3 py-2 tabular-nums">{row.epoch_index}</td>
                      <td className="px-3 py-2 tabular-nums">{row.eligible_count}</td>
                      <td className="px-3 py-2 tabular-nums">{row.joined}</td>
                      <td className="px-3 py-2 tabular-nums">{row.departed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <figure className="rounded-lg border bg-card p-3">
              <svg
                role="img"
                aria-label={t(locale, "validators.health-trend-title")}
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                className="h-auto w-full max-w-md"
              >
                <line
                  x1={PAD.left}
                  y1={HEIGHT - PAD.bottom}
                  x2={WIDTH - PAD.right}
                  y2={HEIGHT - PAD.bottom}
                  stroke="var(--viz-axis)"
                />
                <text
                  x={PAD.left - 4}
                  y={PAD.top + 4}
                  textAnchor="end"
                  fontSize="9"
                  fill="var(--viz-ink-muted)"
                >
                  {Math.max(...series.map((row) => row.eligible_count))}
                </text>
                <text
                  x={PAD.left - 4}
                  y={HEIGHT - PAD.bottom}
                  textAnchor="end"
                  fontSize="9"
                  fill="var(--viz-ink-muted)"
                >
                  {Math.min(...series.map((row) => row.eligible_count))}
                </text>
                <path
                  d={trendPath(series.map((row) => row.eligible_count))}
                  fill="none"
                  stroke="var(--viz-cat-1)"
                  strokeWidth="2"
                />
              </svg>
            </figure>
          )}
        </div>
      )}
    </section>
  );
}
