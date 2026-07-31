import type { OperatorStandingVM } from "~/validators/mine-types";
import { t, type Locale, type MessageKey } from "~/i18n";

// §8.6 commission standing: THREE states, not two — in arrears,
// current, and PREPAID. The third exists because program commission is
// cumulative and an overpayment carries forward indefinitely
// (`contracts/src/validators.rs::epoch_rollover` never resets `commission_paid`),
// unlike TIP, which resets every epoch. Rendering a prepaid validator as merely
// "current" would understate what they have already paid.
//
// The prepaid credit is a LIVE-plane figure and can only be one: the payment
// events cannot express it (`pay_commission`'s `outstanding` attribute is
// `accrued.saturating_sub(paid)`, so an overpayment reports 0, never a
// negative). The banner never infers it from the payment history.
//
// Every state ships icon + label + a plain-language consequence; color never
// carries the state alone (§11, the chrome-banner convention).

const VARIANTS: Record<
  NonNullable<OperatorStandingVM["standing"]>,
  { token: string; labelKey: MessageKey; consequenceKey: MessageKey; iconPath: string }
> = {
  "in-arrears": {
    token: "var(--status-critical)",
    labelKey: "operator.standing-arrears-label",
    consequenceKey: "operator.standing-arrears-consequence",
    // triangle
    iconPath: "M8 1.5 15 14H1L8 1.5Zm-.75 4.5v4h1.5V6h-1.5Zm0 5.5v1.5h1.5V11.5h-1.5Z",
  },
  current: {
    token: "var(--status-good)",
    labelKey: "operator.standing-current-label",
    consequenceKey: "operator.standing-current-consequence",
    // check
    iconPath: "M6.4 11.5 2.9 8l1.1-1.1 2.4 2.4 5.6-5.6L13.1 4.8 6.4 11.5Z",
  },
  prepaid: {
    token: "var(--status-good)",
    labelKey: "operator.standing-prepaid-label",
    consequenceKey: "operator.standing-prepaid-consequence",
    // plus
    iconPath: "M7.25 2h1.5v5.25H14v1.5H8.75V14h-1.5V8.75H2v-1.5h5.25V2Z",
  },
};

export function CommissionBanner({
  locale,
  standing,
}: {
  locale: Locale;
  standing: OperatorStandingVM;
}) {
  if (standing.standing === null) {
    // The live read failed. Say so — never render "current" from silence.
    return (
      <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        {t(locale, "operator.standing-unavailable")}
      </p>
    );
  }

  const variant = VARIANTS[standing.standing];
  return (
    <div
      role="status"
      className="rounded-lg border p-4 text-sm"
      style={{
        borderLeft: `4px solid ${variant.token}`,
        backgroundColor: `color-mix(in srgb, ${variant.token} 12%, transparent)`,
      }}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 16 16"
          className="h-4 w-4 shrink-0"
          style={{ fill: variant.token }}
        >
          <path d={variant.iconPath} />
        </svg>
        <strong className="font-semibold">{t(locale, variant.labelKey)}</strong>
        <span className="text-muted-foreground">{t(locale, variant.consequenceKey)}</span>
      </p>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
        <div className="flex justify-between gap-2 sm:flex-col sm:justify-start">
          <dt className="text-muted-foreground">{t(locale, "operator.commission-due-label")}</dt>
          <dd className="tabular-nums">{standing.commissionDueHash ?? t(locale, "operator.na")}</dd>
        </div>
        <div className="flex justify-between gap-2 sm:flex-col sm:justify-start">
          <dt className="text-muted-foreground">{t(locale, "operator.commission-paid-label")}</dt>
          <dd className="tabular-nums">
            {standing.commissionPaidHash ?? t(locale, "operator.na")}
          </dd>
        </div>
        <div className="flex justify-between gap-2 sm:flex-col sm:justify-start">
          <dt className="text-muted-foreground">
            {t(locale, "operator.commission-accrued-label")}
          </dt>
          <dd className="tabular-nums">
            {standing.commissionAccruedHash ?? t(locale, "operator.na")}
          </dd>
        </div>
      </dl>

      {standing.standing === "prepaid" && standing.prepaidCreditHash !== null ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t(locale, "operator.prepaid-credit", { amount: standing.prepaidCreditHash })}
        </p>
      ) : null}
    </div>
  );
}
