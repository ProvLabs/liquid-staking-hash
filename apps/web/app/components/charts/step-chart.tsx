import { useState } from "react";

// Shared step-after chart (extracted from the Learn NAV chart,
// third instance). Repo dataviz method: single series titled not legended
// (--viz-cat-1), a table view always offered, no interpolation ever.
// Presentation-only by design (plan 4.4 open question 4): callers map their
// rows to `points` + `tableRows`, own their cold states, and pass at least
// two points. Geometry floats are pixel math only; every DISPLAYED number is
// a caller-formatted string.
//
// Extension (back-compat, all new props optional): `markers` place event
// dots on the primary series (filled for "in", hollow ring for "out": shape,
// not color alone) with the event data carried in the caller's table rows; a
// `compare` second series draws in --viz-cat-2 with a legend naming both. No
// new tokens, so check:palette is unaffected.

const WIDTH = 560;
const HEIGHT = 180;
const PAD = { top: 12, right: 12, bottom: 22, left: 46 };

/** Event dot on the primary series at a point index (a11y data lives in the table). */
export interface StepMarker {
  index: number;
  kind: "in" | "out";
  label: string;
}

/** A second step-after series sharing the primary axis (--viz-cat-2). */
export interface StepCompare {
  points: number[];
  label: string;
  /** Names the primary series in the legend; falls back to the chart title. */
  seriesLabel?: string;
}

export interface StepChartProps {
  title: string;
  caption: string;
  showTableLabel: string;
  showChartLabel: string;
  /** Series values, oldest → newest. Callers guarantee length >= 2. */
  points: number[];
  /** X-axis edge labels (e.g. first/last settlement index). */
  firstXLabel: string;
  lastXLabel: string;
  /** Axis min/max tick formatter (display only). */
  formatAxisValue: (value: number) => string;
  tableHeaders: string[];
  tableRows: string[][];
  markers?: StepMarker[];
  compare?: StepCompare;
}

interface Geometry {
  min: number;
  max: number;
  stepW: number;
  yOf: (value: number) => number;
  xOf: (index: number) => number;
}

function geometry(points: number[], comparePoints?: number[]): Geometry {
  const all = comparePoints === undefined ? points : [...points, ...comparePoints];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const stepW = innerW / points.length;
  // A constant series centers rather than sitting on the axis reading as
  // zero (a steady series is the healthy common case).
  const yOf = (value: number) =>
    max === min ? PAD.top + innerH / 2 : PAD.top + innerH - ((value - min) / (max - min)) * innerH;
  const xOf = (index: number) => PAD.left + index * stepW;
  return { min, max, stepW, yOf, xOf };
}

function stepPath(values: number[], stepW: number, yOf: (value: number) => number): string {
  let d = "";
  values.forEach((value, i) => {
    const x = PAD.left + i * stepW;
    d += i === 0 ? `M ${x} ${yOf(value)}` : ` L ${x} ${yOf(value)}`;
    d += ` L ${x + stepW} ${yOf(value)}`;
  });
  return d;
}

export function StepChart({
  title,
  caption,
  showTableLabel,
  showChartLabel,
  points,
  firstXLabel,
  lastXLabel,
  formatAxisValue,
  tableHeaders,
  tableRows,
  markers,
  compare,
}: StepChartProps) {
  const [showTable, setShowTable] = useState(false);
  const geo = geometry(points, compare?.points);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-medium">{title}</h3>
        <button
          type="button"
          className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          aria-pressed={showTable}
          onClick={() => setShowTable((value) => !value)}
        >
          {showTable ? showChartLabel : showTableLabel}
        </button>
      </div>
      {showTable ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                {tableHeaders.map((header) => (
                  <th key={header} className="px-3 py-2 font-medium">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row, rowIndex) => (
                <tr key={row[0] ?? rowIndex} className="border-b last:border-b-0">
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="px-3 py-2 tabular-nums">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <figure className="rounded-lg border bg-card p-3">
          <svg
            role="img"
            aria-label={title}
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
            <text
              x={PAD.left - 6}
              y={PAD.top + 4}
              textAnchor="end"
              fontSize="10"
              fill="var(--viz-ink-muted)"
            >
              {formatAxisValue(geo.max)}
            </text>
            <text
              x={PAD.left - 6}
              y={HEIGHT - PAD.bottom}
              textAnchor="end"
              fontSize="10"
              fill="var(--viz-ink-muted)"
            >
              {formatAxisValue(geo.min)}
            </text>
            <text x={PAD.left} y={HEIGHT - 6} fontSize="10" fill="var(--viz-ink-muted)">
              {firstXLabel}
            </text>
            <text
              x={WIDTH - PAD.right}
              y={HEIGHT - 6}
              textAnchor="end"
              fontSize="10"
              fill="var(--viz-ink-muted)"
            >
              {lastXLabel}
            </text>
            {compare !== undefined ? (
              <path
                d={stepPath(compare.points, geo.stepW, geo.yOf)}
                fill="none"
                stroke="var(--viz-cat-2)"
                strokeWidth="2"
              />
            ) : null}
            <path
              d={stepPath(points, geo.stepW, geo.yOf)}
              fill="none"
              stroke="var(--viz-cat-1)"
              strokeWidth="2"
            />
            {(markers ?? []).map((marker, i) =>
              points[marker.index] === undefined ? null : (
                <circle
                  key={`${marker.index}-${i}`}
                  cx={geo.xOf(marker.index)}
                  cy={geo.yOf(points[marker.index]!)}
                  r={4}
                  fill={marker.kind === "in" ? "var(--viz-cat-1)" : "var(--viz-surface)"}
                  stroke="var(--viz-cat-1)"
                  strokeWidth="2"
                >
                  <title>{marker.label}</title>
                </circle>
              ),
            )}
          </svg>
          {compare !== undefined ? (
            <ul className="flex flex-wrap gap-4 pt-2 text-xs text-muted-foreground">
              <li className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-0.5 w-4"
                  style={{ backgroundColor: "var(--viz-cat-1)" }}
                />
                {compare.seriesLabel ?? title}
              </li>
              <li className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-0.5 w-4"
                  style={{ backgroundColor: "var(--viz-cat-2)" }}
                />
                {compare.label}
              </li>
            </ul>
          ) : null}
          <figcaption className="pt-2 text-xs text-muted-foreground">{caption}</figcaption>
        </figure>
      )}
    </section>
  );
}
