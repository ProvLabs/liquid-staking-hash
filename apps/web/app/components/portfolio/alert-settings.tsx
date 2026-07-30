import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

import { PushSettings } from "~/components/portfolio/push-settings";
import { t, type Locale, type MessageKey } from "~/i18n";

// Alert settings (app-spec §8.2) — joins the Portfolio page,
// fulfilling the recorded 6.1 deferral. One toggle per kind in the closed
// list; default-on kinds annotated "on by default" (not a fake rule row —
// absence means default). `operator_arrears` shows only for operator sessions
// (the live role read; UI convenience — the notifier's server-side filter is
// the mechanism). The market-spread row is ABSENT (deferred with §14.4), not
// an empty shell. Toggles POST to /alerts/rules.

interface EffectiveSetting {
  kind: string;
  enabled: boolean;
  isDefault: boolean;
}

const OPERATOR_ONLY = new Set(["operator_arrears"]);

/** i18n label + description key per kind (the closed §8.2 list). */
const KIND_COPY: Record<string, { label: MessageKey; desc: MessageKey }> = {
  nav_step_posted: { label: "alerts.kind.nav-step-posted", desc: "alerts.kind.nav-step-posted-desc" },
  redemption_update: { label: "alerts.kind.redemption-update", desc: "alerts.kind.redemption-update-desc" },
  vault_status: { label: "alerts.kind.vault-status", desc: "alerts.kind.vault-status-desc" },
  validator_set_incident: { label: "alerts.kind.validator-set-incident", desc: "alerts.kind.validator-set-incident-desc" },
  operator_arrears: { label: "alerts.kind.operator-arrears", desc: "alerts.kind.operator-arrears-desc" },
};

export function AlertSettings({ locale }: { locale: Locale }) {
  const fetcher = useFetcher();
  const [settings, setSettings] = useState<EffectiveSetting[] | null>(null);
  const [isOperator, setIsOperator] = useState(false);

  // Load the effective settings + operator flag once, on mount.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data === undefined) {
      fetcher.load("/alerts/rules");
    }
  }, [fetcher]);

  // Sync local state from every response (GET carries is_operator; both carry settings).
  useEffect(() => {
    const data = fetcher.data as { settings?: EffectiveSetting[]; is_operator?: boolean } | undefined;
    if (data?.settings) setSettings(data.settings);
    if (typeof data?.is_operator === "boolean") setIsOperator(data.is_operator);
  }, [fetcher.data]);

  const toggle = (kind: string, enabled: boolean) => {
    // Optimistic: reflect the change immediately; the POST response reconciles.
    setSettings((prev) => (prev === null ? prev : prev.map((s) => (s.kind === kind ? { ...s, enabled } : s))));
    fetcher.submit(JSON.stringify({ kind, enabled }), {
      method: "post",
      action: "/alerts/rules",
      encType: "application/json",
    });
  };

  const visible = (settings ?? []).filter((s) => !OPERATOR_ONLY.has(s.kind) || isOperator);

  return (
    <section id="alert-settings" className="flex flex-col gap-3" aria-label={t(locale, "alerts.settings-title")}>
      <h2 className="text-lg font-semibold">{t(locale, "alerts.settings-title")}</h2>
      <p className="text-sm text-muted-foreground">{t(locale, "alerts.settings-lede")}</p>

      {settings === null ? (
        <p className="text-sm text-muted-foreground">{t(locale, "alerts.loading")}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border bg-card">
          {visible.map((s) => {
            const copy = KIND_COPY[s.kind];
            if (copy === undefined) return null;
            const descId = `alert-kind-${s.kind}`;
            return (
              <li key={s.kind} className="flex items-start justify-between gap-4 p-4">
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">
                    {t(locale, copy.label)}
                    {s.isDefault ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {t(locale, "alerts.settings-default")}
                      </span>
                    ) : null}
                  </span>
                  <span id={descId} className="text-sm text-muted-foreground">
                    {t(locale, copy.desc)}
                  </span>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-sm">
                  <span className="sr-only">{t(locale, copy.label)}</span>
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={s.enabled}
                    aria-describedby={descId}
                    onChange={(e) => toggle(s.kind, e.target.checked)}
                  />
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {/* Per-browser Web Push opt-in (M6.3) — additive latency, never
          load-bearing: every kind above still renders in-app (§10.4). */}
      <PushSettings locale={locale} />
    </section>
  );
}
