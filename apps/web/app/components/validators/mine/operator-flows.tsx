import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { t, type Locale, type MessageKey } from "~/i18n";
import { parseAmount } from "~/lib/amount";
import { HASH_EXPONENT } from "~/learn/amounts";
import { TxConfirm, type ConfirmTier } from "~/tx/confirm";
import { FlowStatus, feeDisplay } from "~/tx/flow-status";
import { useTxFlow } from "~/tx/use-tx-flow";
import { useWallet } from "~/wallet/provider";
import type { OperatorVariant } from "~/tx/build";

// §14.6 operator actions as FIRST-CLASS App transaction flows — built,
// previewed, signed and tracked through the UNMODIFIED 5.2 lifecycle
// (`useTxFlow`: preflight → simulate → confirm → sign → broadcast → track).
// Nothing here signs: the wallet does, and no key material is touched.
//
// Confirmation rigor is the §17.1 requirement these flows must not soften.
// Every tier's copy RESTATES the contract's own mechanics from the msg.rs doc
// comments rather than inventing a friendlier story — because the facts that
// matter here are the counter-intuitive ones:
//
//   * a commission payment is NON-REFUNDABLE and an overpayment prepays
//     future accrual (it carries forward — it is not "this epoch's bill");
//   * a TIP credits the CURRENT epoch ONLY and resets at epoch completion, so
//     an over-TIP is not carried, it is spent;
//   * unregistering unbonds the program's stake at the next epoch;
//   * the purge is TWO PHASE — reporting only starts a cooldown, and a
//     validator that unjails in the interim clears its own report.

interface FlowSpec {
  variant: OperatorVariant;
  labelKey: MessageKey;
  /** The consequence lines shown before signing (contract mechanics). */
  summaryKeys: MessageKey[];
  tier: ConfirmTier;
  /** Payments take an amount; the rest are fundless. */
  funded: boolean;
}

const FLOWS: FlowSpec[] = [
  {
    variant: "pay_commission",
    labelKey: "operator.flow-pay-commission",
    summaryKeys: [
      "operator.confirm-pay-commission-1",
      "operator.confirm-pay-commission-2",
      "operator.confirm-pay-commission-3",
    ],
    tier: "warning",
    funded: true,
  },
  {
    variant: "pay_tip",
    labelKey: "operator.flow-pay-tip",
    summaryKeys: ["operator.confirm-pay-tip-1", "operator.confirm-pay-tip-2"],
    tier: "warning",
    funded: true,
  },
  {
    variant: "register_participation",
    labelKey: "operator.flow-enroll",
    summaryKeys: ["operator.confirm-enroll-1", "operator.confirm-enroll-2"],
    tier: "warning",
    funded: false,
  },
  {
    variant: "unregister_participation",
    labelKey: "operator.flow-unregister",
    summaryKeys: ["operator.confirm-unregister-1", "operator.confirm-unregister-2"],
    // Destructive: the program's stake leaves this validator.
    tier: "danger",
    funded: false,
  },
  {
    variant: "report_jailed_validator",
    labelKey: "operator.flow-report-jailed",
    summaryKeys: ["operator.confirm-report-1", "operator.confirm-report-2"],
    tier: "danger",
    funded: false,
  },
  {
    variant: "purge_jailed_validator",
    labelKey: "operator.flow-purge-jailed",
    summaryKeys: ["operator.confirm-purge-1", "operator.confirm-purge-2", "operator.confirm-purge-3"],
    tier: "danger",
    funded: false,
  },
];

export function OperatorFlows({
  locale,
  valoper,
  contractAddress,
  ownedValopers,
  /** Restrict the offered actions (the non-operator state offers enroll only). */
  only,
}: {
  locale: Locale;
  valoper: string;
  contractAddress: string;
  ownedValopers: string[];
  only?: OperatorVariant[];
}) {
  const wallet = useWallet();
  const flow = useTxFlow();
  const [active, setActive] = useState<OperatorVariant | null>(null);
  const [amountInput, setAmountInput] = useState("");
  // `claimant_valoper` defaults to the operator's own OTHER validator when one
  // exists (§2.4) — always editable, and always shown in the exact-JSON
  // disclosure so it can never be applied invisibly.
  const [claimantInput, setClaimantInput] = useState("");

  const walletState = wallet.state;
  const connected = walletState.phase === "connected";
  const address = walletState.phase === "connected" ? walletState.address : null;
  const spec = FLOWS.find((f) => f.variant === active) ?? null;
  const offered = only === undefined ? FLOWS : FLOWS.filter((f) => only.includes(f.variant));

  const parsed = useMemo(
    () => (spec?.funded === true ? parseAmount(amountInput, HASH_EXPONENT) : null),
    [amountInput, spec],
  );
  const amountReady = spec === null || !spec.funded || (parsed?.ok === true && parsed.base > 0n);

  const start = async () => {
    if (spec === null || address === null) return;
    await flow.begin(
      {
        kind: "operator",
        variant: spec.variant,
        valoper,
        claimantValoper:
          spec.variant === "purge_jailed_validator" && claimantInput.trim() !== ""
            ? claimantInput.trim()
            : null,
        amount: spec.funded && parsed?.ok === true ? parsed.base : 0n,
        denom: "nhash",
      },
      address,
      contractAddress,
    );
  };

  if (!connected) {
    return (
      <section aria-label={t(locale, "operator.actions-title")} className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">{t(locale, "operator.actions-title")}</h2>
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "operator.actions-connect")}
        </p>
      </section>
    );
  }

  return (
    <section aria-label={t(locale, "operator.actions-title")} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "operator.actions-title")}</h2>
      <p className="text-xs text-muted-foreground">{t(locale, "operator.actions-caption")}</p>

      <div className="flex flex-wrap gap-2">
        {offered.map((f) => (
          <Button
            key={f.variant}
            variant={active === f.variant ? "default" : "ghost"}
            onClick={() => {
              setActive(f.variant);
              setAmountInput("");
              setClaimantInput(
                f.variant === "purge_jailed_validator"
                  ? (ownedValopers.find((v) => v !== valoper) ?? "")
                  : "",
              );
              flow.reset();
            }}
          >
            {t(locale, f.labelKey)}
          </Button>
        ))}
      </div>

      {spec !== null ? (
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          {spec.funded ? (
            <label className="flex flex-col gap-1 text-sm">
              <span>{t(locale, "operator.amount-label")}</span>
              <input
                className="w-full rounded-md border bg-background px-3 py-2 font-mono"
                inputMode="decimal"
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
                placeholder="0.0000"
              />
              {amountInput !== "" && parsed?.ok !== true ? (
                <span className="text-xs" style={{ color: "var(--status-critical)" }}>
                  {t(locale, "operator.amount-invalid")}
                </span>
              ) : null}
            </label>
          ) : null}

          {spec.variant === "purge_jailed_validator" ? (
            <label className="flex flex-col gap-1 text-sm">
              <span>{t(locale, "operator.claimant-label")}</span>
              <input
                className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
                value={claimantInput}
                onChange={(event) => setClaimantInput(event.target.value)}
                placeholder={t(locale, "operator.claimant-placeholder")}
              />
              <span className="text-xs text-muted-foreground">
                {t(locale, "operator.claimant-caption")}
              </span>
            </label>
          ) : null}

          <div>
            <Button onClick={() => void start()} disabled={!amountReady}>
              {t(locale, "operator.review-action")}
            </Button>
          </div>
        </div>
      ) : null}

      {flow.state.phase === "confirm" ? (
        <TxConfirm
          locale={locale}
          plan={flow.state.plan}
          summaryLines={(spec?.summaryKeys ?? []).map((key) => t(locale, key))}
          feeDisplay={feeDisplay(flow.state.plan.fee.amount)}
          tier={spec?.tier ?? "warning"}
          onConfirm={() => void flow.confirm()}
          onCancel={flow.cancel}
        />
      ) : (
        <FlowStatus
          locale={locale}
          state={flow.state}
          amountExponent={HASH_EXPONENT}
          onReset={flow.reset}
        />
      )}
    </section>
  );
}
