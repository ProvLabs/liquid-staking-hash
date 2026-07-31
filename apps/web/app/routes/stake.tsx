// Stake (route /stake) — the guided SwapIn flow (app-spec §8.3, §10.3).
// Inline education → amount entry with live balance / vault bounds / NAV
// preview → the 5.2 lifecycle (preflight → simulate → confirm → sign →
// broadcast → track) → land on Portfolio. The amount is parsed to base
// units at the boundary (app/lib/amount.ts, reject-never-clamp); the NAV
// preview is a labeled execution-time estimate (§10.3, estimate_swap_in is
// gRPC-only). No key material touches this page — signing is the wallet's.

import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { getBootedConfig } from "~/config/config.server";
import { t } from "~/i18n";
import { parseAmount } from "~/lib/amount";
import { formatBaseAmount, HASH_EXPONENT, SHARE_EXPONENT } from "~/learn/amounts";
import { getSessionContext } from "~/lib/services/session.server";
import { loadStakeContext } from "~/stake/stake.server";
import { previewSharesOut } from "~/stake/preview";
import { TxConfirm } from "~/tx/confirm";
import { FlowStatus, feeDisplay } from "~/tx/flow-status";
import { intentAmount } from "~/tx/build";
import { useTxFlow } from "~/tx/use-tx-flow";
import { useWallet } from "~/wallet/provider";
import { useLocale } from "~/root";
import type { Route } from "./+types/stake";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Stake · nvHASH" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  const session = await getSessionContext(config, request);
  const context = await loadStakeContext(config, session?.address ?? null);
  // The vault address is client-safe config (§7 allowlist); the client needs
  // it to build the plan for the confirm disclosure. The relay guard
  // re-checks it against config server-side regardless.
  return { context, vaultAddress: config.vaultAddress };
}

export default function Stake({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const { context, vaultAddress } = loaderData;
  const wallet = useWallet();
  const flow = useTxFlow();
  const [input, setInput] = useState("");

  const connected = wallet.state.phase === "connected";
  const vault = context.vault;

  const parsed = useMemo(() => parseAmount(input, HASH_EXPONENT), [input]);
  const preview = useMemo(() => {
    if (!parsed.ok || vault === null) return null;
    return previewSharesOut(parsed.base, BigInt(vault.totalShares), BigInt(vault.totalValueNhash));
  }, [parsed, vault]);

  const nextEpoch = context.nextEpochIso
    ? new Date(context.nextEpochIso).toLocaleDateString(locale, {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;

  const canSubmit =
    connected &&
    wallet.canSign &&
    parsed.ok &&
    vault !== null &&
    !vault.paused &&
    vault.swapInEnabled &&
    (flow.state.phase === "idle" ||
      flow.state.phase === "blocked" ||
      flow.state.phase === "failed" ||
      flow.state.phase === "confirmed");

  async function onReview() {
    if (!parsed.ok || vault === null || wallet.state.phase !== "connected") return;
    await flow.begin(
      { kind: "swap_in", amount: parsed.base, denom: vault.underlyingDenom },
      wallet.state.address,
      vaultAddress,
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{t(locale, "stake.title")}</h1>

      {/* Inline education (§8.3) */}
      <div className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        <p>{t(locale, "stake.educate-what")}</p>
        <p>{t(locale, "stake.educate-fixed")}</p>
        {nextEpoch ? <p>{t(locale, "stake.next-epoch", { date: nextEpoch })}</p> : null}
      </div>

      {vault === null ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "stake.unavailable")}
        </p>
      ) : vault.paused ? (
        <p
          className="rounded-lg border border-[var(--status-serious)] bg-card p-4 text-sm"
          role="alert"
        >
          {t(locale, "stake.paused", {
            reason: vault.pausedReason || t(locale, "stake.paused-generic"),
          })}
        </p>
      ) : !connected ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "stake.connect-prompt")}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Amount entry */}
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t(locale, "stake.amount-label")}</span>
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
          {context.spendableHash !== null ? (
            <p className="text-xs text-muted-foreground">
              {t(locale, "stake.balance", {
                balance: formatBaseAmount(BigInt(context.spendableHash), HASH_EXPONENT, 4),
              })}
            </p>
          ) : null}
          {vault.minSwapIn !== "" || vault.maxSwapIn !== "" ? (
            <p className="text-xs text-muted-foreground">
              {t(locale, "stake.limits", {
                min:
                  vault.minSwapIn === ""
                    ? "—"
                    : formatBaseAmount(BigInt(vault.minSwapIn), HASH_EXPONENT, 4),
                max:
                  vault.maxSwapIn === ""
                    ? "—"
                    : formatBaseAmount(BigInt(vault.maxSwapIn), HASH_EXPONENT, 4),
              })}
            </p>
          ) : null}

          {/* NAV preview — labeled estimate (§10.3) */}
          {preview !== null ? (
            <div className="rounded-md border bg-background p-3 text-sm">
              {preview.ok ? (
                <p>
                  {t(locale, "stake.preview", {
                    shares: formatBaseAmount(preview.shares, SHARE_EXPONENT, 4),
                  })}
                </p>
              ) : (
                <p className="text-muted-foreground">{t(locale, "stake.preview-empty-vault")}</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                {t(locale, "stake.preview-estimate-note")}
              </p>
            </div>
          ) : null}

          {input !== "" && !parsed.ok && parsed.error !== "zero" ? (
            <p className="text-xs text-[var(--status-serious)]">
              {t(locale, "stake.amount-invalid")}
            </p>
          ) : null}

          {!wallet.canSign ? (
            <p className="text-xs text-muted-foreground">{t(locale, "tx.reconnect-to-sign")}</p>
          ) : null}

          {!vault.swapInEnabled ? (
            // §10.2: a disabled control always carries its reason.
            <p
              className="rounded-lg border border-[var(--status-warning)] bg-card p-3 text-sm"
              role="alert"
            >
              {t(locale, "tx.reason-swaps-disabled")}
            </p>
          ) : null}

          <Button onClick={() => void onReview()} disabled={!canSubmit}>
            {t(locale, "stake.review")}
          </Button>
        </div>
      )}

      {/* Confirm dialog (§10.2 step 4) */}
      {flow.state.phase === "confirm" ? (
        <TxConfirm
          locale={locale}
          plan={flow.state.plan}
          tier="info"
          summaryLines={[
            t(locale, "stake.confirm-deposit", {
              amount: formatBaseAmount(intentAmount(flow.state.plan.intent), HASH_EXPONENT, 4),
            }),
            t(locale, "stake.confirm-rate-note"),
          ]}
          feeDisplay={feeDisplay(flow.state.plan.fee.amount)}
          onConfirm={() => void flow.confirm()}
          onCancel={flow.cancel}
        />
      ) : null}

      <FlowStatus
        locale={locale}
        state={flow.state}
        amountExponent={HASH_EXPONENT}
        onReset={flow.reset}
      />
    </section>
  );
}
