// Hand-rolled SVG charts (spec §11.6). Self-contained, theme-aware via tokens. Forms are
// fixed per metric. Every chart offers a table-view toggle (§11.6.5) - the CVD/print/SR
// fallback - and handles 0/1/N points. Numbers cross in as display floats (layout only).
import { useState, type ReactNode } from "react";
import { Panel, Empty } from "@/components/ui";

const H = 180;
const PADL = 44;
const PADR = 12;
const PADT = 12;
const PADB = 24;

function ChartPanel({
  title,
  table,
  actions,
  children,
}: {
  title: string;
  table: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <Panel
      title={title}
      actions={
        <>
          {actions}
          <button className="btn btn--ghost btn--sm" aria-pressed={showTable} onClick={() => setShowTable((v) => !v)}>
            {showTable ? "chart" : "table"}
          </button>
        </>
      }
    >
      {showTable ? <div className="table-wrap">{table}</div> : children}
    </Panel>
  );
}

// ---- 11.6.1 NAV over time: step-after line --------------------------------
export function StepLine({
  title,
  points,
  fmt,
}: {
  title: string;
  points: { label: string; y: number }[];
  fmt: (y: number) => string;
}) {
  const table = (
    <table className="data">
      <thead>
        <tr>
          <th>epoch</th>
          <th className="num">value</th>
        </tr>
      </thead>
      <tbody>
        {points.map((p, i) => (
          <tr key={i}>
            <td>{p.label}</td>
            <td className="num tnum">{fmt(p.y)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  if (points.length === 0)
    return (
      <ChartPanel title={title} table={table}>
        <Empty>No epochs recorded yet in this browser. History accrues as epochs run.</Empty>
      </ChartPanel>
    );
  const W = 640;
  const ys = points.map((p) => p.y);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const lo = min - span * 0.15;
  const hi = max + span * 0.15;
  const x = (i: number) => PADL + (i / Math.max(1, points.length - 1)) * (W - PADL - PADR);
  const y = (v: number) => PADT + (1 - (v - lo) / (hi - lo)) * (H - PADT - PADB);
  let dPath = "";
  points.forEach((p, i) => {
    const px = x(i);
    const py = y(p.y);
    if (i === 0) dPath += `M ${px} ${py}`;
    else dPath += ` H ${px} V ${py}`; // step-after
  });
  const ticks = [lo, (lo + hi) / 2, hi];
  return (
    <ChartPanel title={title} table={table}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={title}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PADL} x2={W - PADR} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={PADL - 6} y={y(t) + 3} textAnchor="end" fontSize={11} fill="var(--ink-3)">
              {fmt(t)}
            </text>
          </g>
        ))}
        <path d={dPath} fill="none" stroke="var(--cat-1)" strokeWidth={2} />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.y)} r={3} fill="var(--cat-1)">
            <title>
              {p.label}: {fmt(p.y)}
            </title>
          </circle>
        ))}
      </svg>
    </ChartPanel>
  );
}

// ---- 11.6.2 Epoch value decomposition: signed horizontal bars --------------
export function SignedBars({
  title,
  rows,
  fmt,
}: {
  title: string;
  rows: { label: string; value: number }[]; // + inflow, - drag
  fmt: (v: number) => string;
}) {
  const table = (
    <table className="data">
      <thead>
        <tr>
          <th>leg</th>
          <th className="num">value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td className="num tnum">{fmt(r.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const W = 640;
  const mid = PADL + (W - PADL - PADR) * 0.42;
  const LABEL_ROOM = 72; // keep the outside value label on-canvas for the widest bar
  const scale = (W - mid - PADR - LABEL_ROOM) / maxAbs;
  const rowH = 26;
  const height = rows.length * rowH + 12;
  return (
    <ChartPanel title={title} table={table}>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} role="img" aria-label={title}>
        <line x1={mid} x2={mid} y1={6} y2={height - 6} stroke="var(--baseline)" strokeWidth={1} />
        {rows.map((r, i) => {
          const cy = 6 + i * rowH + rowH / 2;
          const w = Math.abs(r.value) * scale;
          const isDrag = r.value < 0;
          const bx = isDrag ? mid - w : mid;
          const color = isDrag ? "var(--drag)" : "var(--cat-1)";
          return (
            <g key={r.label}>
              <text x={8} y={cy + 3} fontSize={12} fill="var(--ink-2)">
                {r.label}
              </text>
              {Math.abs(r.value) < 1e-9 ? (
                <line x1={mid - 3} x2={mid + 3} y1={cy} y2={cy} stroke="var(--baseline)" strokeWidth={2} />
              ) : (
                <rect x={bx} y={cy - 7} width={Math.max(1, w)} height={14} rx={3} fill={color}>
                  <title>
                    {r.label}: {fmt(r.value)}
                  </title>
                </rect>
              )}
              <text x={isDrag ? bx - 4 : bx + w + 4} y={cy + 3} textAnchor={isDrag ? "end" : "start"} fontSize={11} fill="var(--ink-2)">
                {fmt(r.value)}
              </text>
            </g>
          );
        })}
      </svg>
    </ChartPanel>
  );
}

// ---- 11.6.3 Deployment split: single stacked horizontal bar ----------------
const SPLIT_COLORS = ["var(--cat-1)", "var(--cat-3)", "var(--cat-2)", "var(--cat-5)"];
export function StackedBar({
  title,
  segments,
  fmt,
  caption,
}: {
  title: string;
  segments: { label: string; value: number }[];
  fmt: (v: number) => string;
  caption?: ReactNode;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const table = (
    <table className="data">
      <thead>
        <tr>
          <th>segment</th>
          <th className="num">value</th>
          <th className="num">share</th>
        </tr>
      </thead>
      <tbody>
        {segments.map((s) => (
          <tr key={s.label}>
            <td>{s.label}</td>
            <td className="num tnum">{fmt(s.value)}</td>
            <td className="num tnum">{((s.value / total) * 100).toFixed(1)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <ChartPanel title={title} table={table}>
      <div style={{ display: "flex", height: 28, borderRadius: 6, overflow: "hidden", gap: 2 }}>
        {segments.map((s, i) => (
          <div
            key={s.label}
            title={`${s.label}: ${fmt(s.value)}`}
            style={{ width: `${(s.value / total) * 100}%`, background: SPLIT_COLORS[i % SPLIT_COLORS.length] }}
          />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 12 }}>
        {segments.map((s, i) => (
          <span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: SPLIT_COLORS[i % SPLIT_COLORS.length] }} />
            <span className="muted">{s.label}</span>
            <span className="tnum">{fmt(s.value)}</span>
          </span>
        ))}
      </div>
      {caption && (
        <div className="muted-3" style={{ fontSize: 12, marginTop: 8 }}>
          {caption}
        </div>
      )}
    </ChartPanel>
  );
}

// ---- 11.6.4 History bars (sequential or diverging) -------------------------
export function HistoryBars({
  title,
  bars,
  fmt,
  diverging = false,
  actions,
}: {
  title: string;
  bars: { label: string; value: number }[];
  fmt: (v: number) => string;
  diverging?: boolean;
  actions?: ReactNode;
}) {
  const table = (
    <table className="data">
      <thead>
        <tr>
          <th>epoch</th>
          <th className="num">value</th>
        </tr>
      </thead>
      <tbody>
        {bars.map((b) => (
          <tr key={b.label}>
            <td>{b.label}</td>
            <td className="num tnum">{fmt(b.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  if (bars.length === 0)
    return (
      <ChartPanel title={title} table={table} actions={actions}>
        <Empty>No epochs recorded yet in this browser.</Empty>
      </ChartPanel>
    );
  const W = 640;
  const maxAbs = Math.max(1, ...bars.map((b) => Math.abs(b.value)));
  const zeroY = diverging ? PADT + (H - PADT - PADB) / 2 : H - PADB;
  const bw = (W - PADL - PADR) / bars.length;
  const scale = (diverging ? (H - PADT - PADB) / 2 : H - PADT - PADB) / maxAbs;
  return (
    <ChartPanel title={title} table={table} actions={actions}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={title}>
        <line x1={PADL} x2={W - PADR} y1={zeroY} y2={zeroY} stroke="var(--baseline)" strokeWidth={1} />
        {bars.map((b, i) => {
          const h = Math.abs(b.value) * scale;
          const up = b.value >= 0;
          const bx = PADL + i * bw + 2;
          const by = up ? zeroY - h : zeroY;
          const color = diverging ? (up ? "var(--cat-1)" : "var(--drag)") : "var(--cat-1)";
          return (
            <rect key={i} x={bx} y={by} width={Math.max(2, bw - 4)} height={Math.max(1, h)} rx={3} fill={color}>
              <title>
                {b.label}: {fmt(b.value)}
              </title>
            </rect>
          );
        })}
      </svg>
    </ChartPanel>
  );
}

// ---- Uptime dot strip (Validators page, §11.6) -----------------------------
export function DotStrip({
  rows,
  thresholdBps,
}: {
  rows: { label: string; uptimeBps: number | null; eligible: boolean }[];
  thresholdBps: number;
}) {
  const W = 640;
  const lo = 9000; // 90%
  const hi = 10000; // 100%
  const x = (bps: number) => PADL + ((Math.max(lo, Math.min(hi, bps)) - lo) / (hi - lo)) * (W - PADL - PADR);
  const rowH = 22;
  const height = rows.length * rowH + 20;
  const tx = x(thresholdBps);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} role="img" aria-label="uptime by validator">
      <line x1={tx} x2={tx} y1={4} y2={height - 16} stroke="var(--ink-3)" strokeWidth={2} strokeDasharray="3 3" />
      <text x={tx} y={height - 4} textAnchor="middle" fontSize={10} fill="var(--ink-3)">
        {(thresholdBps / 100).toFixed(0)}%
      </text>
      {[lo, hi].map((b) => (
        <text key={b} x={x(b)} y={12} textAnchor="middle" fontSize={10} fill="var(--ink-3)">
          {(b / 100).toFixed(0)}%
        </text>
      ))}
      {rows.map((r, i) => {
        const cy = 20 + i * rowH;
        if (r.uptimeBps === null)
          return (
            <text key={r.label} x={PADL} y={cy + 3} fontSize={11} fill="var(--ink-3)">
              {r.label}: no data
            </text>
          );
        const below = r.uptimeBps < thresholdBps;
        return (
          <g key={r.label}>
            <circle
              cx={x(r.uptimeBps)}
              cy={cy}
              r={5}
              fill={r.eligible ? "var(--cat-1)" : "var(--surface)"}
              stroke={below ? "var(--status-serious)" : "var(--cat-1)"}
              strokeWidth={2}
            >
              <title>
                {r.label}: {(r.uptimeBps / 100).toFixed(2)}%
              </title>
            </circle>
          </g>
        );
      })}
    </svg>
  );
}
