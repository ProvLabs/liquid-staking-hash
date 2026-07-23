import { useState } from "react";

// Shared step-after chart (extracted from the Learn NAV chart in PR 4.4,
// third instance). Repo dataviz method: single series titled not legended
// (--viz-cat-1), a table view always offered, no interpolation ever.
// Presentation-only by design (plan 4.4 open question 4): callers map their
// rows to `points` + `tableRows`, own their cold states, and pass at least
// two points. Geometry floats are pixel math only; every DISPLAYED number is
// a caller-formatted string.

const WIDTH = 560;
const HEIGHT = 180;
const PAD = { top: 12, right: 12, bottom: 22, left: 46 };

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
}

function stepPath(points: number[]): string {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const stepW = innerW / points.length;
  // A constant series centers rather than sitting on the axis reading as
  // zero (PR #12 review; a steady series is the healthy common case).
  const y = (value: number) =>
    max === min
      ? PAD.top + innerH / 2
      : PAD.top + innerH - ((value - min) / (max - min)) * innerH;

  let d = "";
  points.forEach((value, i) => {
    const x = PAD.left + i * stepW;
    d += i === 0 ? `M ${x} ${y(value)}` : ` L ${x} ${y(value)}`;
    d += ` L ${x + stepW} ${y(value)}`;
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
}: StepChartProps) {
  const [showTable, setShowTable] = useState(false);
  const min = Math.min(...points);
  const max = Math.max(...points);

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
          <svg role="img" aria-label={title} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full">
            <line
              x1={PAD.left}
              y1={HEIGHT - PAD.bottom}
              x2={WIDTH - PAD.right}
              y2={HEIGHT - PAD.bottom}
              stroke="var(--viz-axis)"
            />
            <text x={PAD.left - 6} y={PAD.top + 4} textAnchor="end" fontSize="10" fill="var(--viz-ink-muted)">
              {formatAxisValue(max)}
            </text>
            <text
              x={PAD.left - 6}
              y={HEIGHT - PAD.bottom}
              textAnchor="end"
              fontSize="10"
              fill="var(--viz-ink-muted)"
            >
              {formatAxisValue(min)}
            </text>
            <text x={PAD.left} y={HEIGHT - 6} fontSize="10" fill="var(--viz-ink-muted)">
              {firstXLabel}
            </text>
            <text x={WIDTH - PAD.right} y={HEIGHT - 6} textAnchor="end" fontSize="10" fill="var(--viz-ink-muted)">
              {lastXLabel}
            </text>
            <path d={stepPath(points)} fill="none" stroke="var(--viz-cat-1)" strokeWidth="2" />
          </svg>
          <figcaption className="pt-2 text-xs text-muted-foreground">{caption}</figcaption>
        </figure>
      )}
    </section>
  );
}
