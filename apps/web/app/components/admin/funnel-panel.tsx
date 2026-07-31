import type { FunnelVM, PanelState } from "~/admin/types";
import { t, type Locale, type MessageKey } from "~/i18n";
import { PanelBody, PanelShell } from "./panel";

// §8.8 evaluator funnel, over the §14.10 aggregate counters.
//
// THIS PANEL'S JOB IS TO NOT OVERSTATE ITSELF (plan invariant 15). The counters
// carry no identifier, so they CANNOT deduplicate: a returning reader
// increments `visit` again. These are EVENT TOTALS, NOT UNIQUE PEOPLE, and the
// copy says so rather than leaving a reader to assume the friendlier reading.
//
// The terminal stage is rendered as its OWN block, deliberately not as the last
// bar of the same series: first deposits are chain-derived and exact, while the
// stages above them are unduplicated event totals. One series would imply
// uniform precision across a boundary where the precision genuinely changes,
// and a funnel that quietly implied unique visitors would be a small lie the
// program tells about itself.

const STAGE_LABEL: Record<string, MessageKey> = {
  visit_learn_index: "admin.funnel-visit-learn",
  visit_validators: "admin.funnel-visit-validators",
  visit_market: "admin.funnel-visit-market",
  due_diligence_depth: "admin.funnel-due-diligence",
  connect: "admin.funnel-connect",
};

export function FunnelPanel({ locale, state }: { locale: Locale; state: PanelState<FunnelVM> }) {
  return (
    <PanelShell title={t(locale, "admin.funnel-title")}>
      <PanelBody locale={locale} state={state}>
        {(data) => (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {t(locale, "admin.funnel-window", { days: String(data.windowDays) })}
            </p>
            {/* The honesty label, above the numbers rather than footnoted
                below them: a reader who stops at the figures still sees it. */}
            <p role="note" className="rounded-lg border bg-card p-3 text-sm">
              {t(locale, "admin.funnel-event-totals")}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[24rem] text-left text-sm">
                <caption className="sr-only">{t(locale, "admin.funnel-table-caption")}</caption>
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th scope="col" className="py-1 pr-3">
                      {t(locale, "admin.col-stage")}
                    </th>
                    <th scope="col" className="py-1">
                      {t(locale, "admin.col-events")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.stages.map((stage) => {
                    const label = STAGE_LABEL[stage.stage];
                    return (
                      <tr key={stage.stage} className="border-t">
                        <td className="py-1 pr-3">
                          {label === undefined ? stage.stage : t(locale, label)}
                        </td>
                        <td className="py-1 tabular-nums">{stage.total.toLocaleString("en-US")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="rounded-lg border bg-card p-3 text-sm">
              <p className="font-medium">{t(locale, "admin.funnel-first-deposits")}</p>
              <p className="tabular-nums">
                {data.firstDeposits === null
                  ? t(locale, "admin.panel-na")
                  : data.firstDeposits.toLocaleString("en-US")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(locale, "admin.funnel-first-deposits-note")}
              </p>
            </div>
          </div>
        )}
      </PanelBody>
    </PanelShell>
  );
}
