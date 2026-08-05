import type { PanelState, PanelUnavailableReason } from "~/admin/types";
import { t, type Locale, type MessageKey } from "~/i18n";

// The §8.8 panel shell. Every admin panel renders through it so the
// degrade-individually rule (plan invariant 14) is implemented ONCE: a panel
// with no figures shows a stated REASON, never a blank and never a 0.
//
// The four reasons are deliberately distinct messages rather than one "n/a":
//   read-failed   — we could not read it (say so; it may be fine next reload)
//   cold-start    — we read it and there is no history yet
//   below-minimum — we read it, we could compute it, and we are WITHHOLDING it
//                   because publishing it would identify someone
//   not-collected — this build does not index the input at all
// Collapsing the last two into "no data" would be the small lie the never-lie-
// about-state rule exists to prevent: one is a privacy decision and the other
// is a missing feature, and an administrator acts differently on each.

const REASON_LABEL: Record<PanelUnavailableReason, MessageKey> = {
  "read-failed": "admin.panel-read-failed",
  "cold-start": "admin.panel-cold-start",
  "below-minimum": "admin.panel-below-minimum",
  "not-collected": "admin.panel-not-collected",
};

/** Heading + optional caption around a panel's body. `title` and `caption`
 * arrive already translated — the shell renders no copy of its own, so it
 * takes no locale. */
export function PanelShell({
  title,
  caption,
  children,
}: {
  title: string;
  caption?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h2 className="text-xl font-semibold">{title}</h2>
      {caption === undefined ? null : <p className="text-sm text-muted-foreground">{caption}</p>}
      {children}
    </section>
  );
}

/** The captioned "n/a" state. `role="status"` so a screen reader is told the
 * panel has no figures rather than finding an empty region. */
export function PanelUnavailable({
  locale,
  reason,
}: {
  locale: Locale;
  reason: PanelUnavailableReason;
}) {
  return (
    <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
      <span className="font-medium">{t(locale, "admin.panel-na")}</span>{" "}
      {t(locale, REASON_LABEL[reason])}
    </p>
  );
}

/** Render `children` for a data panel, or the captioned reason otherwise. */
export function PanelBody<T>({
  locale,
  state,
  children,
}: {
  locale: Locale;
  state: PanelState<T>;
  children: (data: T) => React.ReactNode;
}) {
  if (state.kind === "unavailable")
    return <PanelUnavailable locale={locale} reason={state.reason} />;
  return <>{children(state.data)}</>;
}
