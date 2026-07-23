import { useState } from "react";

import type { Envelope, IncidentKind, IncidentRow, IncidentSeverity } from "@nvhash/api-types";
import { Button } from "~/components/ui/button";
import { t, type Locale, type MessageKey } from "~/i18n";
import { formatAgeSince, formatDuration } from "~/learn/duration";

// §8.1.5 incident & slashing history from the indexed feed. Three honest
// states: unavailable (API unreachable → say so), empty (the proud
// "generated from chain history, not curated" state), and the table. Severity
// ships icon + label on the fixed status family (console §11.2); color never
// carries state alone. Client paging walks the loader's bounded page (newest
// first); it never fetches — the browser does not talk to the API.
const PAGE_SIZE = 10;

const SEVERITY: Record<
  IncidentSeverity,
  { labelKey: MessageKey; token: string; iconPath: string }
> = {
  info: {
    labelKey: "learn.incident-severity-info",
    token: "var(--muted-foreground)",
    // filled circle
    iconPath: "M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2Z",
  },
  warning: {
    labelKey: "learn.incident-severity-warning",
    token: "var(--status-warning)",
    // triangle
    iconPath: "M8 1.5 15 14H1L8 1.5Z",
  },
  critical: {
    labelKey: "learn.incident-severity-critical",
    token: "var(--status-critical)",
    // octagon
    iconPath: "M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1L5.1 1Z",
  },
};

// Wire kinds are snake_case; catalog keys stay kebab-case (the i18n
// well-formedness gate). Total by construction: a new kind is a type error
// here until it gets a label and a description.
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

const KIND_DESC: Record<IncidentKind, MessageKey> = {
  contract_halted: "learn.incident-desc-contract-halted",
  vault_paused: "learn.incident-desc-vault-paused",
  slash_write_down: "learn.incident-desc-slash-write-down",
  redemption_refund: "learn.incident-desc-redemption-refund",
  jail_report: "learn.incident-desc-jail-report",
  epoch_overdue: "learn.incident-desc-epoch-overdue",
  reconciler_divergence: "learn.incident-desc-reconciler-divergence",
  indexer_lag: "learn.incident-desc-indexer-lag",
};

function isoDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Closed: opened→closed span. Open: opened→now, running (display only). */
function durationOf(incident: IncidentRow, nowMs: number): string {
  if (incident.closed_at === null) return formatAgeSince(incident.opened_at, nowMs);
  return formatDuration((Date.parse(incident.closed_at) - Date.parse(incident.opened_at)) / 1_000);
}

export function IncidentHistory({
  locale,
  incidents,
  nowMs,
}: {
  locale: Locale;
  incidents: Envelope<IncidentRow[]> | null;
  nowMs: number;
}) {
  const [page, setPage] = useState(0);

  if (incidents === null || incidents.data.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">{t(locale, "learn.incidents-title")}</h2>
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, incidents === null ? "learn.incidents-unavailable" : "learn.incidents-empty")}
        </p>
      </section>
    );
  }

  const pages = Math.ceil(incidents.data.length / PAGE_SIZE);
  const offset = page * PAGE_SIZE;
  const rows = incidents.data.slice(offset, offset + PAGE_SIZE);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "learn.incidents-title")}</h2>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">{t(locale, "learn.incidents-col-incident")}</th>
              <th className="px-3 py-2 font-medium">{t(locale, "learn.incidents-col-severity")}</th>
              <th className="px-3 py-2 font-medium">{t(locale, "learn.incidents-col-opened")}</th>
              <th className="px-3 py-2 font-medium">{t(locale, "learn.incidents-col-resolved")}</th>
              <th className="px-3 py-2 font-medium">{t(locale, "learn.incidents-col-duration")}</th>
              <th className="px-3 py-2 font-medium">{t(locale, "learn.incidents-col-height")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((incident, index) => {
              const severity = SEVERITY[incident.severity];
              return (
                <tr
                  // The wire row has no id; the absolute index disambiguates
                  // same-kind, same-block incidents in this render-only list.
                  key={`${incident.kind}-${incident.opened_at}-${offset + index}`}
                  className="border-b align-top last:border-b-0"
                >
                  <td className="min-w-64 px-3 py-2">
                    <span className="font-medium">{t(locale, KIND_LABEL[incident.kind])}</span>
                    <p className="text-xs text-muted-foreground">
                      {t(locale, KIND_DESC[incident.kind])}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                      <svg
                        aria-hidden="true"
                        focusable="false"
                        viewBox="0 0 16 16"
                        className="h-3 w-3 shrink-0"
                        style={{ fill: severity.token }}
                      >
                        <path d={severity.iconPath} />
                      </svg>
                      {t(locale, severity.labelKey)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                    {isoDate(incident.opened_at)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                    {incident.closed_at === null ? (
                      <span className="font-medium">{t(locale, "learn.incident-open")}</span>
                    ) : (
                      isoDate(incident.closed_at)
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{durationOf(incident, nowMs)}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                    {incident.height === null ? t(locale, "learn.incident-na") : incident.height}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav
          aria-label={t(locale, "learn.incidents-pagination")}
          className="flex items-center justify-between"
        >
          <span className="text-xs text-muted-foreground">
            {t(locale, "learn.incidents-page", { page: page + 1, pages })}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
            >
              {t(locale, "learn.incidents-prev")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page === pages - 1}
              onClick={() => setPage((current) => Math.min(pages - 1, current + 1))}
            >
              {t(locale, "learn.incidents-next")}
            </Button>
          </div>
        </nav>
      )}
    </section>
  );
}
