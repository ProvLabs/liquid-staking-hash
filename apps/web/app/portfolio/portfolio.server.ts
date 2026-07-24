// Minimal portfolio position (plan 5.3, Q5 landing; app-spec §8.2 subset).
// The full Portfolio page — effective-yield panel, accrual chart, CSV
// export, transaction history — is M6.1. 5.3 lands the stake flow here with
// just the live position: nvHASH balance (canonical live read, §5.1) and its
// HASH value at the current NAV. Both degrade to null honestly on a read
// failure (never a fabricated zero — SECURITY.md never-lie).

import { BankClient, LcdClient, VaultClient, type FetchLike } from "@nvhash/chain-client";

import { CHROME_READ_TIMEOUT_MS } from "~/chrome/chrome.server";
import type { WebConfig } from "~/config/config.server";

export interface PortfolioPosition {
  /** nvHASH balance, base units — null when unread. */
  shares: string | null;
  /** HASH value at current NAV, base-unit nhash — null when unpriceable. */
  valueNhash: string | null;
  shareDenom: string;
}

export async function loadPortfolioPosition(
  config: WebConfig,
  address: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<PortfolioPosition> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const lcd = new LcdClient(config.lcdUrl, { fetchImpl, timeoutMs: CHROME_READ_TIMEOUT_MS });
  const vaultClient = new VaultClient(lcd);
  const bank = new BankClient(lcd);

  const vaultState = await vaultClient.getVault(config.vaultAddress).catch(() => null);
  const shareDenom = vaultState?.vault.totalShares.denom ?? "nvhash";
  const balance = await bank.balance(address, shareDenom).catch(() => null);

  let valueNhash: string | null = null;
  if (balance !== null && vaultState !== null) {
    const totalShares = vaultState.vault.totalShares.amount;
    const totalValue = vaultState.totalVaultValue.amount;
    // HASH value = shares × TVV ÷ totalShares (floor; the vault's own math).
    valueNhash = totalShares > 0n ? ((balance.amount * totalValue) / totalShares).toString() : null;
  }

  return {
    shares: balance === null ? null : balance.amount.toString(),
    valueNhash,
    shareDenom,
  };
}
