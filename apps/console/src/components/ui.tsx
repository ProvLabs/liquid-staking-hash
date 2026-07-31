// Shared components (spec §11.5). Status is never color-alone: pills carry an icon dot
// + a text label. A disabled control ALWAYS carries a reason (§10.3, R1).
import { useState, type ReactNode } from "react";
import { config } from "@/config";
import { truncAddr, humanDuration } from "@/lib/format";
import { useNow } from "@/data/store";
import type { GuardState } from "@/lib/guards";

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`pill pill--${tone}`}>
      <span className="pill__dot" aria-hidden />
      {children}
    </span>
  );
}

export function StatTile({
  label,
  value,
  caption,
  captionTone,
}: {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  captionTone?: "up";
}) {
  return (
    <div className="tile">
      <div className="tile__label">{label}</div>
      <div className="tile__value tnum">{value}</div>
      {caption !== undefined && (
        <div className={`tile__caption${captionTone === "up" ? " delta-up" : ""}`}>{caption}</div>
      )}
    </div>
  );
}

export function Panel({
  title,
  actions,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      {(title || actions) && (
        <div className="panel__header">
          {title ? <h2 className="panel__title">{title}</h2> : <span />}
          {actions && <div className="panel__actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function AddressChip({ addr }: { addr: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="chip"
      title={addr}
      aria-label={`copy address ${addr}`}
      onClick={() => {
        void navigator.clipboard?.writeText(addr);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "copied" : truncAddr(addr)}
    </button>
  );
}

/** Guard-aware button (spec §10.3): enabled | disabled-with-reason | hidden. */
export function GuardButton({
  guard,
  onClick,
  children,
  variant = "primary",
}: {
  guard: GuardState;
  onClick: () => void;
  children: ReactNode;
  variant?: "primary" | "secondary" | "warning" | "danger";
}) {
  if (guard.kind === "hidden") return null;
  const disabled = guard.kind === "disabled";
  return (
    <span className="guardbtn">
      <button
        type="button"
        className={`btn btn--${variant}`}
        disabled={disabled}
        onClick={onClick}
        title={disabled ? guard.reason : undefined}
      >
        {children}
      </button>
      {disabled && <span className="guardbtn__reason">{guard.reason}</span>}
    </span>
  );
}

/** Countdown to a unix-seconds target; "ready" past it. */
export function Countdown({
  target,
  readyLabel = "eligible now",
}: {
  target: number;
  readyLabel?: string;
}) {
  const now = useNow();
  const remaining = target - now;
  return <span className="tnum">{remaining <= 0 ? readyLabel : humanDuration(remaining)}</span>;
}

/** Horizontal proportion bar (0..1) for reserve / deployment ratios. */
export function ProportionBar({ frac, tone = "good" }: { frac: number; tone?: Tone }) {
  const pctW = Math.max(0, Math.min(1, frac)) * 100;
  const color =
    tone === "good"
      ? "var(--status-good)"
      : tone === "warning"
        ? "var(--status-warning)"
        : tone === "critical"
          ? "var(--status-critical)"
          : "var(--accent)";
  return (
    <div style={{ height: 10, borderRadius: 999, background: "var(--grid)", overflow: "hidden" }}>
      <div style={{ width: `${pctW}%`, height: "100%", background: color }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state">{children}</div>;
}
export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="state" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="skeleton"
          style={{ width: `${80 - i * 12}%`, margin: "8px auto" }}
        />
      ))}
    </div>
  );
}
export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="state state--error">
      <div>{error}</div>
      {onRetry && (
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          style={{ marginTop: 8 }}
          onClick={onRetry}
        >
          retry
        </button>
      )}
    </div>
  );
}

/** Renders one of loading/error/empty/content from a store Cell. */
export function Cell<T>({
  cell,
  onRetry,
  children,
  empty,
}: {
  cell: { data: T | null; fetchedAt: number; error: string | null };
  onRetry?: () => void;
  children: (data: T) => ReactNode;
  empty?: ReactNode;
}) {
  if (cell.error && !cell.data) return <ErrorState error={cell.error} onRetry={onRetry} />;
  if (cell.fetchedAt === 0 && !cell.data) return <Loading />;
  if (cell.data === null || cell.data === undefined) return <>{empty ?? <Empty>No data.</Empty>}</>;
  return <>{children(cell.data)}</>;
}

export function unit(): string {
  return config.displayDenom;
}
