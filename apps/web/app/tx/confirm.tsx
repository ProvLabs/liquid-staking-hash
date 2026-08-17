// The §10.2 step-4 confirm dialog: consumer-worded
// consequence summary, fee, tier (warning for redemptions, danger for
// program-ops when M7 arrives), and the EXACT message JSON behind a
// disclosure. The disclosure renders `plan.disclosureJson` — produced by
// the same `buildTxPlan` call whose sign-doc bytes go to the wallet
// (test/tx-confirm.test.ts pins that equality). The confirm button is the
// only path that fires `CONFIRM_ACCEPTED`, which is the lifecycle's only
// doorway into signing.

import { useId } from "react";

import { Button } from "~/components/ui/button";
import { t, type Locale } from "~/i18n";
import type { TxPlan } from "./build";

export type ConfirmTier = "info" | "warning" | "danger";

export interface TxConfirmProps {
  locale: Locale;
  plan: TxPlan;
  /** Consumer-worded consequence lines, already localized by the flow. */
  summaryLines: string[];
  /** Display fee, formatted by the flow (HASH, not base units). */
  feeDisplay: string;
  tier: ConfirmTier;
  onConfirm: () => void;
  onCancel: () => void;
}

const TIER_CLASSES: Record<ConfirmTier, string> = {
  info: "border",
  warning: "border border-[var(--status-warning)]",
  danger: "border-2 border-[var(--status-critical)]",
};

export function TxConfirm({
  locale,
  plan,
  summaryLines,
  feeDisplay,
  tier,
  onConfirm,
  onCancel,
}: TxConfirmProps) {
  const headingId = useId();
  return (
    <div
      role="alertdialog"
      aria-labelledby={headingId}
      aria-modal="true"
      className={`flex w-full max-w-lg flex-col gap-4 rounded-lg bg-card p-5 ${TIER_CLASSES[tier]}`}
    >
      <h2 id={headingId} className="text-lg font-semibold">
        {t(locale, "tx.confirm-title")}
      </h2>
      {tier !== "info" ? (
        // Tier in text, not color alone (WCAG 1.4.1).
        <p className="text-sm font-medium">
          {t(locale, tier === "danger" ? "tx.confirm-tier-danger" : "tx.confirm-tier-warning")}
        </p>
      ) : null}
      <ul className="flex flex-col gap-1 text-sm">
        {summaryLines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        {t(locale, "tx.confirm-fee", { fee: feeDisplay })}
      </p>
      <details className="rounded-md border bg-background p-2">
        <summary className="cursor-pointer text-sm text-muted-foreground">
          {t(locale, "tx.confirm-disclosure")}
        </summary>
        {/* The exact bytes-equivalent JSON the wallet will be asked to sign. */}
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
          {plan.disclosureJson}
        </pre>
      </details>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t(locale, "tx.confirm-cancel")}
        </Button>
        <Button onClick={onConfirm}>{t(locale, "tx.confirm-sign")}</Button>
      </div>
    </div>
  );
}
