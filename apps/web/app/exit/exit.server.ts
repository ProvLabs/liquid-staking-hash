// Redeem & Exit data assembly (app-spec §8.4, §9.5.3, §10.3
// SwapOut). Composes the exit-path comparison (the public payout statistic +
// the fixed 60-day guarantee), the native-flow context (live vault swap-out
// gating, bounds, NAV pair, the connected share balance), and the redemption
// tracker from three reads — live `pendingSwapOuts` (queue + refund-moment
// countdown), the address-scoped `/portfolio` active redemptions, and
// `/transactions` terminal payout/refund rows. Every read degrades
// independently; the loader never throws (§12.1 never-lie).
//
// The tracker reads the ON-CHAIN queue, so a redemption made with any tool
// appears (§8.4 "direct-vault redemptions appear here too"). The DEX column
// is a static "coming soon" shell (§14.4) rendered by the page.

import {
  BankClient,
  LcdClient,
  VaultClient,
  type FetchLike,
  type PendingSwapOut,
} from "@nvhash/chain-client";
import type { PayoutStats, RedemptionRow, TransactionRow } from "@nvhash/api-types";

import {
  fetchApiJson,
  payoutStatsEnvelopeSchema,
  portfolioEnvelopeSchema,
  transactionsEnvelopeSchema,
} from "~/api/api.server";
import { CHROME_READ_TIMEOUT_MS } from "~/chrome/chrome.server";
import type { WebConfig } from "~/config/config.server";
import { personalApiHeaders } from "~/lib/services/assertion.server";

/** A terminal redemption leg surfaced from indexed transactions. */
export interface TerminalLeg {
  kind: "redemption_payout" | "redemption_refund";
  shares: string;
  nhash: string;
  txhash: string;
  /** Message index within the tx — (txhash, msgIndex) is the row identity;
   * one tx can carry several redemption legs (batch payout/refund). */
  msgIndex: number;
  blockTime: string;
}

/** The user's place in the on-chain swap-out queue. */
export interface QueueEntry {
  shares: string;
  redeemDenom: string;
  /** RFC3339 refund/guarantee moment (the countdown target). */
  timeoutIso: string;
  /** 1-based position in the vault's pending queue. */
  position: number;
  /** Total pending requests in the queue (for "N of M"). */
  queueLength: number;
}

export interface ExitContext {
  address: string | null;
  /** §9.5.3 typical time-to-payout (public); null when the API is unreadable. */
  payout: PayoutStats | null;
  vault: {
    shareDenom: string;
    underlyingDenom: string;
    paused: boolean;
    pausedReason: string;
    swapOutEnabled: boolean;
    minSwapOut: string;
    maxSwapOut: string;
    totalShares: string;
    totalValueNhash: string;
  } | null;
  /** nvHASH balance (base units), null when anonymous/unread. */
  shareBalance: string | null;
  /** null when anonymous; each field degrades independently otherwise. */
  tracker: {
    active: RedemptionRow[];
    queue: QueueEntry[];
    terminal: TerminalLeg[];
  } | null;
}

function toQueue(pending: PendingSwapOut[], owner: string): QueueEntry[] {
  const queueLength = pending.length;
  const entries: QueueEntry[] = [];
  pending.forEach((p, i) => {
    if (p.owner !== owner) return;
    entries.push({
      shares: p.shares.amount.toString(),
      redeemDenom: p.redeemDenom,
      timeoutIso: p.timeout,
      position: i + 1,
      queueLength,
    });
  });
  return entries;
}

export async function loadExitContext(
  config: WebConfig,
  address: string | null,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ExitContext> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const lcd = new LcdClient(config.lcdUrl, { fetchImpl, timeoutMs: CHROME_READ_TIMEOUT_MS });
  const vaultClient = new VaultClient(lcd);
  const bank = new BankClient(lcd);
  const apiBase = config.apiUrl.replace(/\/+$/, "");

  const [payoutEnv, vaultState] = await Promise.all([
    fetchApiJson(`${apiBase}/api/v1/redemptions/stats`, fetchImpl, CHROME_READ_TIMEOUT_MS)
      .then((body) => payoutStatsEnvelopeSchema.parse(body))
      .catch(() => null),
    vaultClient.getVault(config.vaultAddress).catch(() => null),
  ]);

  const record = vaultState?.vault ?? null;
  const vault =
    record === null || vaultState === null
      ? null
      : {
          shareDenom: record.totalShares.denom,
          underlyingDenom: record.underlyingAsset,
          paused: record.paused,
          pausedReason: record.pausedReason,
          swapOutEnabled: record.swapOutEnabled,
          minSwapOut: record.minSwapOutValue,
          maxSwapOut: record.maxSwapOutValue,
          totalShares: record.totalShares.amount.toString(),
          totalValueNhash: vaultState.totalVaultValue.amount.toString(),
        };

  let shareBalance: string | null = null;
  let tracker: ExitContext["tracker"] = null;
  if (address !== null) {
    const shareDenom = record?.totalShares.denom ?? "nvhash";
    const headers = personalApiHeaders(config, address);
    const authFetch: FetchLike = (url, init) =>
      fetchImpl(url, {
        ...init,
        headers: { ...(init as { headers?: Record<string, string> }).headers, ...(headers ?? {}) },
      });

    const [balance, pending, portfolioEnv, txEnv] = await Promise.all([
      bank.balance(address, shareDenom).catch(() => null),
      vaultClient.pendingSwapOuts(config.vaultAddress).catch(() => null),
      headers === null
        ? Promise.resolve(null)
        : fetchApiJson(
            `${apiBase}/api/v1/portfolio?address=${encodeURIComponent(address)}`,
            authFetch,
            CHROME_READ_TIMEOUT_MS,
          )
            .then((body) => portfolioEnvelopeSchema.parse(body))
            .catch(() => null),
      headers === null
        ? Promise.resolve(null)
        : fetchApiJson(
            `${apiBase}/api/v1/transactions?address=${encodeURIComponent(address)}`,
            authFetch,
            CHROME_READ_TIMEOUT_MS,
          )
            .then((body) => transactionsEnvelopeSchema.parse(body))
            .catch(() => null),
    ]);

    shareBalance = balance === null ? null : balance.amount.toString();
    const terminal: TerminalLeg[] = (txEnv?.data ?? [])
      .filter(
        (t: TransactionRow) => t.kind === "redemption_payout" || t.kind === "redemption_refund",
      )
      .map((t: TransactionRow) => ({
        kind: t.kind as TerminalLeg["kind"],
        shares: t.shares,
        nhash: t.nhash,
        txhash: t.txhash,
        msgIndex: t.msg_index,
        blockTime: t.block_time,
      }));
    tracker = {
      active: portfolioEnv?.data.active_redemptions ?? [],
      queue: pending === null ? [] : toQueue(pending.pendingSwapOuts, address),
      terminal,
    };
  }

  return {
    address,
    payout: payoutEnv?.data ?? null,
    vault,
    shareBalance,
    tracker,
  };
}
