// Redeem & Exit (route /exit) — the most communication-critical surface
// (app-spec §8.4). It OPENS WITH THE COMPARISON, not a form: the exit-path
// table with the normative guaranteed-vs-typical framing, the DEX
// coming-soon shell (§14.4), then the native SwapOut flow on the 5.2
// lifecycle and the redemption tracker. The SwapOut confirm restates the
// three timing facts in fixed order (§10.3). No key material — the wallet
// signs; the guarded relay broadcasts.

import { useMemo, useState } from "react";

import { ComparisonTable } from "~/components/exit/comparison-table";
import { RedemptionTracker } from "~/components/exit/redemption-tracker";
import { Button } from "~/components/ui/button";
import { getBootedConfig } from "~/config/config.server";
import { loadExitContext } from "~/exit/exit.server";
import { typicalDisplay } from "~/exit/typical";
import { t } from "~/i18n";
import { parseAmount } from "~/lib/amount";
import { formatBaseAmount, HASH_EXPONENT, SHARE_EXPONENT } from "~/learn/amounts";
import { getSessionContext } from "~/lib/services/session.server";
import { previewSharesOut } from "~/stake/preview";
import { TxConfirm } from "~/tx/confirm";
import { FlowStatus, feeDisplay } from "~/tx/flow-status";
import { useTxFlow } from "~/tx/use-tx-flow";
import { useWallet } from "~/wallet/provider";
import { useLocale } from "~/root";
import type { Route } from "./+types/exit";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Redeem & Exit · nvHASH" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  const session = await getSessionContext(config, request);
  const context = await loadExitContext(config, session?.address ?? null);
  return { context, vaultAddress: config.vaultAddress, nowMs: Date.now() };
}

/** Redemption value at current NAV: shares × TVV ÷ totalShares (floor). */
function redeemValueNhash(shares: bigint, totalShares: bigint, totalValueNhash: bigint): bigint | null {
  if (totalShares <= 0n) return null;
  return (shares * totalValueNhash) / totalShares;
}

export default function Exit({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const { context, vaultAddress, nowMs } = loaderData;
  const wallet = useWallet();
  const flow = useTxFlow();
  const [input, setInput] = useState("");

  const typical = useMemo(() => typicalDisplay(context.payout), [context.payout]);
  const connected = wallet.state.phase === "connected";
  const vault = context.vault;

  const parsed = useMemo(() => parseAmount(input, SHARE_EXPONENT), [input]);
  const preview = useMemo(() => {
    if (!parsed.ok || vault === null) return null;
    // Value at current NAV (re-prices at maturity — the §8.4 estimate copy).
    return redeemValueNhash(parsed.base, BigInt(vault.totalShares), BigInt(vault.totalValueNhash));
  }, [parsed, vault]);

  const canSubmit =
    connected &&
    wallet.canSign &&
    parsed.ok &&
    vault !== null &&
    !vault.paused &&
    vault.swapOutEnabled &&
    (flow.state.phase === "idle" ||
      flow.state.phase === "blocked" ||
      flow.state.phase === "failed" ||
      flow.state.phase === "confirmed");

  async function onReview() {
    if (!parsed.ok || vault === null || wallet.state.phase !== "connected") return;
    await flow.begin(
      { kind: "swap_out", amount: parsed.base, denom: vault.shareDenom, redeemDenom: "" },
      wallet.state.address,
      vaultAddress,
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-16">
      <div className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{t(locale, "exit.title")}</h1>
        <p className="text-sm text-muted-foreground">{t(locale, "exit.lede")}</p>
        <ComparisonTable locale={locale} typical={typical} />
      </div>

      {/* Native redemption flow */}
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">{t(locale, "exit.native-title")}</h2>
        {vault === null ? (
          <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">{t(locale, "exit.unavailable")}</p>
        ) : vault.paused ? (
          <p className="rounded-lg border border-[var(--status-serious)] bg-card p-4 text-sm" role="alert">
            {t(locale, "exit.paused", { reason: vault.pausedReason || t(locale, "exit.paused-generic") })}
          </p>
        ) : !connected ? (
          <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">{t(locale, "exit.connect-prompt")}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t(locale, "exit.amount-label")}</span>
              <input
                inputMode="decimal"
                autoComplete="off"
                className="rounded-md border bg-background px-3 py-2 font-mono"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="0.0"
                aria-invalid={input !== "" && !parsed.ok}
              />
            </label>
            {context.shareBalance !== null ? (
              <p className="text-xs text-muted-foreground">
                {t(locale, "exit.balance", { balance: formatBaseAmount(BigInt(context.shareBalance), SHARE_EXPONENT, 4) })}
              </p>
            ) : null}
            {preview !== null ? (
              <div className="rounded-md border bg-background p-3 text-sm">
                <p>{t(locale, "exit.preview", { value: formatBaseAmount(preview, HASH_EXPONENT, 4) })}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t(locale, "exit.preview-reprice-note")}</p>
              </div>
            ) : null}
            {input !== "" && !parsed.ok && parsed.error !== "zero" ? (
              <p className="text-xs text-[var(--status-serious)]">{t(locale, "exit.amount-invalid")}</p>
            ) : null}
            {!wallet.canSign ? (
              <p className="text-xs text-muted-foreground">{t(locale, "tx.reconnect-to-sign")}</p>
            ) : null}
            <Button onClick={() => void onReview()} disabled={!canSubmit}>
              {t(locale, "exit.review")}
            </Button>
          </div>
        )}

        {flow.state.phase === "confirm" ? (
          <TxConfirm
            locale={locale}
            plan={flow.state.plan}
            tier="warning"
            summaryLines={[
              // The three timing facts in fixed order (§10.3 SwapOut).
              t(locale, "exit.confirm-escrow", {
                shares: formatBaseAmount(flow.state.plan.intent.amount, SHARE_EXPONENT, 4),
              }),
              t(locale, "exit.confirm-guarantee", { days: typical.guaranteeDays }),
              typical.hasTypical
                ? t(locale, "exit.confirm-typical", { median: typical.medianDays ?? 0 })
                : t(locale, "exit.confirm-typical-withheld"),
              t(locale, "exit.confirm-refund"),
            ]}
            feeDisplay={feeDisplay(flow.state.plan.fee.amount)}
            onConfirm={() => void flow.confirm()}
            onCancel={flow.cancel}
          />
        ) : null}

        <FlowStatus locale={locale} state={flow.state} amountExponent={SHARE_EXPONENT} onReset={flow.reset} />
      </div>

      {context.tracker !== null ? (
        <RedemptionTracker locale={locale} tracker={context.tracker} nowMs={nowMs} />
      ) : null}
    </section>
  );
}
