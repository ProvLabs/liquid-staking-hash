import type { Envelope, IncidentKind, IncidentRow, IncidentSeverity } from "@nvhash/api-types";
import { t, type Locale, type MessageKey } from "~/i18n";

// §8.1.5 incident & slashing history from the indexed feed. Three honest
// states: unavailable (API unreachable → say so), empty (the proud
// "generated from chain history, not curated" state), and rows. Severity
// ships icon + label on the fixed status family (console §11.2); color never
// carries state alone.
const SEVERITY_TOKEN: Record<IncidentSeverity, string> = {
  info: "var(--muted-foreground)",
  warning: "var(--status-warning)",
  critical: "var(--status-critical)",
};

// Wire kinds are snake_case; catalog keys stay kebab-case (the i18n
// well-formedness gate). Total by construction: a new kind is a type error
// here until it gets a label.
const KIND_LABEL: Record<IncidentKind, MessageKey> = {
  contract_halted: "learn.incident-contract-halted",
  vault_paused: "learn.incident-vault-paused",
  slash_write_down: "learn.incident-slash-write-down",
  redemption_refund: "learn.incident-redemption-refund",
  jail_report: "learn.incident-jail-report",
  epoch_overdue: "learn.incident-epoch-overdue",
  reconciler_divergence: "learn.incident-reconciler-divergence",
  indexer_lag: "learn.incident-indexer-lag",
};

export function IncidentHistory({
  locale,
  incidents,
}: {
  locale: Locale;
  incidents: Envelope<IncidentRow[]> | null;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "learn.incidents-title")}</h2>
      {incidents === null ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "learn.incidents-unavailable")}
        </p>
      ) : incidents.data.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "learn.incidents-empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {incidents.data.map((incident) => (
            <li
              key={`${incident.kind}-${incident.opened_at}`}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-card p-3 text-sm"
            >
              <svg
                aria-hidden="true"
                focusable="false"
                viewBox="0 0 16 16"
                className="h-3 w-3 shrink-0"
                style={{ fill: SEVERITY_TOKEN[incident.severity] }}
              >
                <circle cx="8" cy="8" r="6" />
              </svg>
              <span className="font-medium">{t(locale, KIND_LABEL[incident.kind])}</span>
              <span className="text-xs text-muted-foreground">{incident.severity}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(incident.opened_at).toISOString().slice(0, 10)}
              </span>
              <span className="text-xs text-muted-foreground">
                {incident.closed_at === null
                  ? t(locale, "learn.incident-open")
                  : t(locale, "learn.incident-closed")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
