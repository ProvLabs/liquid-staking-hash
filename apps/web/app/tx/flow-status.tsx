// Shared lifecycle status surface (plan 5.3): renders the non-confirm
// phases of a TxFlow — blocked reasons, in-flight pending (always labeled
// pending, never as settled history — SECURITY.md never-lie), the honest
// terminal states — with localized copy. Both /stake and /exit render this;
// the confirm dialog itself (TxConfirm) is rendered by each page because its
// summary lines are flow-specific.

import { Link } from "react-router";

import { formatBaseAmount, HASH_EXPONENT } from "~/learn/amounts";
import { t, type Locale } from "~/i18n";
import { reasonText } from "./reasons";
import type { TxState } from "./lifecycle";

/** Fee in HASH for display (base-unit nhash → HASH string). */
export function feeDisplay(feeAmountNhash: bigint): string {
  return `${formatBaseAmount(feeAmountNhash, HASH_EXPONENT, 6)} HASH`;
}

export interface FlowStatusProps {
  locale: Locale;
  state: TxState;
  /** Exponent for reason amount details (HASH for stake, shares for redeem). */
  amountExponent: number;
  /** Explorer base for the txhash link (per-environment console/explorer). */
  explorerTxBase?: string;
  onReset: () => void;
}

export function FlowStatus({ locale, state, amountExponent, explorerTxBase, onReset }: FlowStatusProps) {
  if (state.phase === "blocked") {
    return (
      <ul className="flex flex-col gap-1 rounded-lg border border-[var(--status-warning)] bg-card p-4 text-sm" role="alert">
        {state.reasons.map((reason) => (
          <li key={reason.code + JSON.stringify(reason)}>{reasonText(locale, reason, amountExponent)}</li>
        ))}
      </ul>
    );
  }

  if (state.phase === "signing" || state.phase === "broadcasting") {
    return (
      <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground" role="status">
        {t(locale, "tx.status-signing")}
      </p>
    );
  }

  if (state.phase === "pending" || state.phase === "reconciling") {
    const explorer = explorerTxBase ? `${explorerTxBase}/${state.row.txhash}` : null;
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-[var(--status-warning)] bg-card p-4 text-sm" role="status">
        <span className="font-medium">{t(locale, "tx.pending-label")}</span>
        <span className="break-all font-mono text-xs text-muted-foreground">{state.row.txhash}</span>
        {explorer ? (
          <a className="text-xs underline" href={explorer} target="_blank" rel="noreferrer">
            {t(locale, "tx.view-explorer")}
          </a>
        ) : null}
      </div>
    );
  }

  if (state.phase === "confirmed") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-[var(--status-good)] bg-card p-4 text-sm" role="status">
        <span className="font-medium">{t(locale, "tx.status-confirmed")}</span>
        <Link className="text-xs underline" to="/portfolio">
          {t(locale, "tx.go-portfolio")}
        </Link>
      </div>
    );
  }

  if (state.phase === "failed") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-[var(--status-serious)] bg-card p-4 text-sm" role="alert">
        <span className="font-medium">{t(locale, `tx.failed-${state.stage}`)}</span>
        {state.detail ? (
          <span className="break-all text-xs text-muted-foreground">{state.detail}</span>
        ) : null}
        <button type="button" className="self-start text-xs underline" onClick={onReset}>
          {t(locale, "tx.try-again")}
        </button>
      </div>
    );
  }

  return null;
}
