// Learn-page data assembly (plan 4.2 §2 tranche 2; app-spec §8.1, §12.1).
// Runs in the home-route loader: live reads (vault get, apr, epoch_snapshot)
// drive the proof strip and yield decomposition; the indexed plane
// (/metrics, /epochs, /incidents) drives participant count, program age, the
// NAV step chart, and the incident feed.
//
// Honesty rules, gated by test/learn-data.test.ts:
// - Every figure is independently nullable; a failed or off-shape read
//   degrades that figure (and only it) to null, which the UI renders as
//   "n/a" or the cold-start state. Never a crash, a guess, or a stale
//   substitute presented as current.
// - Indexed figures keep their envelope meta so the UI labels staleness
//   structurally (§12.1); loader data is serializable (BigInt is converted
//   to display strings here, server-side).

import {
  LcdClient,
  NvhashContractClient,
  VaultClient,
  type FetchLike,
} from "@nvhash/chain-client";

import {
  epochsEnvelopeSchema,
  fetchApiJson,
  incidentsEnvelopeSchema,
  metricsEnvelopeSchema,
} from "~/api/api.server";
import { CHROME_READ_TIMEOUT_MS } from "~/chrome/chrome.server";
import type { WebConfig } from "~/config/config.server";
import { bpsToPercent, formatHashCompact, navHashPerShare } from "./amounts";
import type { LearnData } from "./types";

/**
 * Minimum settled epochs before an APR renders as a number (§8.1
 * minimum-window rule): below this the figure is "n/a (insufficient
 * history)", never an annualized extrapolation of one epoch. Named per plan
 * 4.2 open question 3; the reviewer confirms the value.
 */
export const MIN_APR_EPOCHS = 2;

/** How much epoch history the step chart requests (one page, bounded). */
export const EPOCH_HISTORY_LIMIT = 48;

export type { LearnData, LearnLive } from "./types";

export interface LearnReadOptions {
  fetchImpl?: FetchLike;
}

/** Assemble the Learn page's data for one request. Never throws. */
export async function loadLearnData(
  config: WebConfig,
  options: LearnReadOptions = {},
): Promise<LearnData> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const lcd = new LcdClient(config.lcdUrl, { fetchImpl, timeoutMs: CHROME_READ_TIMEOUT_MS });
  const contract = new NvhashContractClient(lcd, config.contractAddress);
  const vault = new VaultClient(lcd);
  const apiBase = config.apiUrl.replace(/\/+$/, "");

  const [vaultState, apr, snapshot, metrics, epochs, incidents] = await Promise.all([
    vault.getVault(config.vaultAddress).catch(() => null),
    contract.apr().catch(() => null),
    contract.epochSnapshot().catch(() => null),
    fetchApiJson(`${apiBase}/api/v1/metrics`, fetchImpl, CHROME_READ_TIMEOUT_MS)
      .then((body) => metricsEnvelopeSchema.parse(body))
      .catch(() => null),
    fetchApiJson(
      `${apiBase}/api/v1/epochs?limit=${EPOCH_HISTORY_LIMIT}`,
      fetchImpl,
      CHROME_READ_TIMEOUT_MS,
    )
      .then((body) => epochsEnvelopeSchema.parse(body))
      .catch(() => null),
    fetchApiJson(`${apiBase}/api/v1/incidents`, fetchImpl, CHROME_READ_TIMEOUT_MS)
      .then((body) => incidentsEnvelopeSchema.parse(body))
      .catch(() => null),
  ]);

  const aprMature = apr !== null && apr.epochIndex >= MIN_APR_EPOCHS;

  // Defense in depth for the never-crash invariant (PR #11 review): today the
  // chain client's parseU64Number guarantees safe-integer bps, but this
  // formatting runs outside every .catch guard, so a malformed value must
  // degrade to null here rather than 500 the page.
  const safeBpsPercent = (bps: number): string | null =>
    Number.isSafeInteger(bps) ? bpsToPercent(bps) : null;

  return {
    live: {
      nav:
        vaultState === null
          ? null
          : navHashPerShare(vaultState.totalVaultValue.amount, vaultState.vault.totalShares.amount),
      tvl: vaultState === null ? null : formatHashCompact(vaultState.totalVaultValue.amount),
      netAprPercent: aprMature ? safeBpsPercent(apr.netAprBps) : null,
      grossAprPercent: aprMature ? safeBpsPercent(apr.grossAprBps) : null,
      aprWindowSeconds: aprMature ? apr.windowSeconds : null,
      aprInsufficientHistory: apr !== null && !aprMature,
      yieldSources:
        apr === null
          ? null
          : {
              rewards: formatHashCompact(apr.rewardsClaimed),
              commission: formatHashCompact(apr.commissionReceived),
              tips: formatHashCompact(apr.tipsReceived),
              aumFee: formatHashCompact(apr.aumFeeEstimate),
            },
      eligibleValidators: snapshot?.eligibleCount ?? null,
    },
    metrics,
    epochs,
    incidents,
  };
}
