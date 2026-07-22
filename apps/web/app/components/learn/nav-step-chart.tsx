import { useState } from "react";

import type { Envelope, EpochRow } from "@nvhash/api-types";
import { t, type Locale } from "~/i18n";

// §8.1.1 step chart: NAV per settled epoch, step-after (contract §5 stepwise
// NAV: no interpolation anywhere; between-epoch flatness IS the data). Repo
// dataviz method: single series titled not legended (--viz-cat-1), and a
// table view is always offered. Below two rows the cold-start explainer
// renders instead of an empty chart (§8.1 cold-start rule).
//
// Geometry (not amounts): parsing the NAV decimal string to a float here is
// pixel math for the SVG only; every displayed number stays the string the
// server formatted with BigInt math.

const WIDTH = 560;
const HEIGHT = 180;
const PAD = { top: 12, right: 12, bottom: 22, left: 46 };

function stepPath(rows: EpochRow[]): string {
  const navs = rows.map((row) => Number.parseFloat(row.nav));
  const min = Math.min(...navs);
  const max = Math.max(...navs);
  const x0 = PAD.left;
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const stepW = innerW / rows.length;
  // A constant series must center, not sit on the axis reading as zero
  // (same fix as the validators trend, PR #12 review).
  const y = (nav: number) =>
    max === min
      ? PAD.top + innerH / 2
      : PAD.top + innerH - ((nav - min) / (max - min)) * innerH;

  let d = "";
  navs.forEach((nav, i) => {
    const x = x0 + i * stepW;
    d += i === 0 ? `M ${x} ${y(nav)}` : ` L ${x} ${y(nav)}`;
    d += ` L ${x + stepW} ${y(nav)}`;
  });
  return d;
}

export function NavStepChart({
  locale,
  epochs,
}: {
  locale: Locale;
  epochs: Envelope<EpochRow[]> | null;
}) {
  const [showTable, setShowTable] = useState(false);
  // Newest-first from the API; the chart reads oldest → newest.
  const series = epochs === null ? [] : [...epochs.data].reverse();

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

  const navs = series.map((row) => Number.parseFloat(row.nav));
  const min = Math.min(...navs);
  const max = Math.max(...navs);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-medium">{t(locale, "learn.chart-title")}</h3>
        <button
          type="button"
          className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          aria-pressed={showTable}
          onClick={() => setShowTable((value) => !value)}
        >
          {showTable ? t(locale, "learn.chart-show-chart") : t(locale, "learn.chart-show-table")}
        </button>
      </div>
      {showTable ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t(locale, "learn.chart-col-settlement")}</th>
                <th className="px-3 py-2 font-medium">{t(locale, "learn.chart-col-ended")}</th>
                <th className="px-3 py-2 font-medium">{t(locale, "learn.chart-col-nav")}</th>
              </tr>
            </thead>
            <tbody>
              {series.map((row) => (
                <tr key={row.epoch_index} className="border-b last:border-b-0">
                  <td className="px-3 py-2 tabular-nums">{row.epoch_index}</td>
                  <td className="px-3 py-2">{new Date(row.ended_at).toISOString().slice(0, 10)}</td>
                  <td className="px-3 py-2 tabular-nums">{row.nav}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <figure className="rounded-lg border bg-card p-3">
          <svg
            role="img"
            aria-label={t(locale, "learn.chart-title")}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="h-auto w-full"
          >
            <line
              x1={PAD.left}
              y1={HEIGHT - PAD.bottom}
              x2={WIDTH - PAD.right}
              y2={HEIGHT - PAD.bottom}
              stroke="var(--viz-axis)"
            />
            <text x={PAD.left - 6} y={PAD.top + 4} textAnchor="end" fontSize="10" fill="var(--viz-ink-muted)">
              {max.toFixed(4)}
            </text>
            <text
              x={PAD.left - 6}
              y={HEIGHT - PAD.bottom}
              textAnchor="end"
              fontSize="10"
              fill="var(--viz-ink-muted)"
            >
              {min.toFixed(4)}
            </text>
            <text
              x={PAD.left}
              y={HEIGHT - 6}
              fontSize="10"
              fill="var(--viz-ink-muted)"
            >
              {series[0] ? `#${series[0].epoch_index}` : ""}
            </text>
            <text
              x={WIDTH - PAD.right}
              y={HEIGHT - 6}
              textAnchor="end"
              fontSize="10"
              fill="var(--viz-ink-muted)"
            >
              {series[series.length - 1] ? `#${series[series.length - 1]!.epoch_index}` : ""}
            </text>
            <path d={stepPath(series)} fill="none" stroke="var(--viz-cat-1)" strokeWidth="2" />
          </svg>
          <figcaption className="pt-2 text-xs text-muted-foreground">
            {t(locale, "learn.chart-caption")}
          </figcaption>
        </figure>
      )}
    </section>
  );
}
