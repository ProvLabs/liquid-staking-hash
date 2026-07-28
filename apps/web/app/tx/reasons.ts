// Localize preflight block reasons (plan 5.3; §10.2 step 2 "disabled
// controls always carry the reason"). The reducer's machine-readable
// `PreflightReason` codes map 1:1 to i18n keys here, shared by /stake and
// /exit so the honesty copy is identical across flows.

import { formatBaseAmount, HASH_EXPONENT, SHARE_EXPONENT } from "~/learn/amounts";
import { t, type Locale } from "~/i18n";
import type { PreflightReason } from "./lifecycle";

/** One localized sentence per reason. `denomExponent` scales amount details
 * (HASH for swap-in, shares for swap-out). */
export function reasonText(
  locale: Locale,
  reason: PreflightReason,
  denomExponent: number,
): string {
  switch (reason.code) {
    case "vault-paused":
      return reason.detail
        ? t(locale, "tx.reason-vault-paused-detail", { detail: reason.detail })
        : t(locale, "tx.reason-vault-paused");
    case "swaps-disabled":
      return t(locale, "tx.reason-swaps-disabled");
    case "below-minimum":
      return t(locale, "tx.reason-below-minimum", {
        minimum: formatBaseAmount(BigInt(reason.minimum), denomExponent, 4),
      });
    case "above-maximum":
      return t(locale, "tx.reason-above-maximum", {
        maximum: formatBaseAmount(BigInt(reason.maximum), denomExponent, 4),
      });
    case "insufficient-balance":
      return t(locale, "tx.reason-insufficient-balance", {
        balance: formatBaseAmount(BigInt(reason.balance), denomExponent, 4),
        required: formatBaseAmount(BigInt(reason.required), denomExponent, 4),
      });
    case "vesting-locked":
      return t(locale, "tx.reason-vesting-locked", {
        spendable: formatBaseAmount(BigInt(reason.spendable), HASH_EXPONENT, 4),
      });
    case "amount-invalid":
      return t(locale, "tx.reason-amount-invalid");
    case "account-missing":
      return t(locale, "tx.reason-account-missing");
    case "chain-unavailable":
      return t(locale, "tx.reason-chain-unavailable");
    // M6.4 operator predicates (§2.4).
    case "not-validator-operator":
      return t(locale, "tx.reason-not-validator-operator");
    case "validator-not-found":
      return t(locale, "tx.reason-validator-not-found");
    case "already-enrolled":
      return t(locale, "tx.reason-already-enrolled");
    case "not-enrolled":
      return t(locale, "tx.reason-not-enrolled");
    case "validator-not-jailed":
      return t(locale, "tx.reason-validator-not-jailed");
    case "no-jail-report":
      return t(locale, "tx.reason-no-jail-report");
    case "purge-cooldown":
      return t(locale, "tx.reason-purge-cooldown", { readyAt: reason.readyAtIso });
    case "program-halted":
      return t(locale, "tx.reason-program-halted");
    case "too-many-validators":
      return t(locale, "tx.reason-too-many-validators", { max: String(reason.max) });
  }
}

export { SHARE_EXPONENT, HASH_EXPONENT };
