// Stake-page data assembly (app-spec §8.3, §10.3 SwapIn). All
// live reads (§5.1 canonical plane): the vault record for swap gates, min/
// max bounds, and the NAV inputs (total value / total shares), the epoch
// status for the next-expected-epoch date, and — when a session exists —
// the connected address's spendable HASH balance (the vesting-honest figure,
// bank spendable subtracts locks). Every read degrades independently; the
// loader never throws (SECURITY.md: never lie — a failed read renders its
// own honest "unavailable", not a fabricated number).
//
// NAV preview math is done here from the live plane with the shared
// `navHashPerShare` floor math; `estimate_swap_in` is gRPC-only (§14.2
// pinned fact) so the preview is labeled an execution-time-rate estimate,
// never a promise (§10.3).

import {
  BankClient,
  LcdClient,
  NvhashContractClient,
  VaultClient,
  type FetchLike,
} from "@nvhash/chain-client";

import { CHROME_READ_TIMEOUT_MS } from "~/chrome/chrome.server";
import type { WebConfig } from "~/config/config.server";
import { HASH_EXPONENT } from "~/learn/amounts";

/** First day of the calendar month AFTER `lastRunSeconds` (E-CAL cadence,
 * §14.12): the next epoch is eligible at the next civil-month boundary. */
export function nextEpochIso(lastRunSeconds: number): string {
  const last = new Date(lastRunSeconds * 1000);
  // UTC civil-month rollover — the contract's block-time month predicate.
  return new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1)).toISOString();
}

export interface StakeContext {
  /** null = the connected session address, or null when anonymous. */
  address: string | null;
  /** Live vault swap gating; null when the vault read failed. */
  vault:
    | {
        underlyingDenom: string;
        shareDenom: string;
        paused: boolean;
        pausedReason: string;
        swapInEnabled: boolean;
        /** base-unit strings; "" = no bound (client parses accordingly). */
        minSwapIn: string;
        maxSwapIn: string;
        /** NAV inputs (base units) for the client-side preview. */
        totalValueNhash: string;
        totalShares: string;
      }
    | null;
  /** ISO next-epoch date, or null when epoch status was unreadable. */
  nextEpochIso: string | null;
  /** Spendable HASH (base units, vesting-net), null when anonymous/unread. */
  spendableHash: string | null;
}

export async function loadStakeContext(
  config: WebConfig,
  address: string | null,
  options: { fetchImpl?: FetchLike } = {},
): Promise<StakeContext> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const lcd = new LcdClient(config.lcdUrl, { fetchImpl, timeoutMs: CHROME_READ_TIMEOUT_MS });
  const vaultClient = new VaultClient(lcd);
  const contract = new NvhashContractClient(lcd, config.contractAddress);
  const bank = new BankClient(lcd);

  const [vaultState, epochStatus, spendable] = await Promise.all([
    vaultClient.getVault(config.vaultAddress).catch(() => null),
    contract.epochStatus().catch(() => null),
    address === null
      ? Promise.resolve(null)
      : bank.spendableBalances(address).catch(() => null),
  ]);

  const record = vaultState?.vault ?? null;
  return {
    address,
    vault:
      record === null || vaultState === null
        ? null
        : {
            underlyingDenom: record.underlyingAsset,
            shareDenom: record.totalShares.denom,
            paused: record.paused,
            pausedReason: record.pausedReason,
            swapInEnabled: record.swapInEnabled,
            minSwapIn: record.minSwapInValue,
            maxSwapIn: record.maxSwapInValue,
            totalValueNhash: vaultState.totalVaultValue.amount.toString(),
            totalShares: record.totalShares.amount.toString(),
          },
    nextEpochIso: epochStatus === null ? null : nextEpochIso(epochStatus.lastRunSeconds),
    spendableHash:
      spendable === null || record === null
        ? null
        : (
            spendable.balances.find((c) => c.denom === record.underlyingAsset)?.amount ?? 0n
          ).toString(),
  };
}

export { HASH_EXPONENT };
