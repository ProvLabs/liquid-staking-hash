// Market-page data assembly (app-spec §8.5, §12.1,
// §13 decision 4). The market plane is rendered VERBATIM 's
// sample — the web tier never recomputes market math (the §9.5(4) premium
// formula lives in the API); it only converts base-unit integers to display
// strings. Local supply is the one live read (§8.5: the
// API serves the bridged side; the page composes local from the live plane).
//
// Honesty rules, gated by test/market-data.test.ts:
// - /market unreachable or off-shape → `market: null` (unavailable state),
//   DISTINCT from the honest v1 shell (`sample: null` inside a real
//   envelope, the forthcoming state).
// - A null premium inside a real sample stays null ("n/a", never 0).
// - Each read degrades only its own figure; the loader never throws.

import { LcdClient, VaultClient, type FetchLike } from "@nvhash/chain-client";

import { epochsEnvelopeSchema, fetchApiJson, marketEnvelopeSchema } from "~/api/api.server";
import { CHROME_READ_TIMEOUT_MS } from "~/chrome/chrome.server";
import type { WebConfig } from "~/config/config.server";
import { bpsToPercent, formatBaseAmount, HASH_EXPONENT, SHARE_EXPONENT } from "~/learn/amounts";
import { EPOCH_HISTORY_LIMIT } from "~/learn/learn.server";
import type { MarketData } from "./types";

export type { MarketData } from "./types";

/** Assemble the market page's data for one request. Never throws. */
export async function loadMarketData(
  config: WebConfig,
  options: { fetchImpl?: FetchLike } = {},
): Promise<MarketData> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const lcd = new LcdClient(config.lcdUrl, { fetchImpl, timeoutMs: CHROME_READ_TIMEOUT_MS });
  const vault = new VaultClient(lcd);
  const apiBase = config.apiUrl.replace(/\/+$/, "");

  const [summary, epochs, vaultState] = await Promise.all([
    fetchApiJson(`${apiBase}/api/v1/market`, fetchImpl, CHROME_READ_TIMEOUT_MS)
      .then((body) => marketEnvelopeSchema.parse(body))
      .catch(() => null),
    fetchApiJson(
      `${apiBase}/api/v1/epochs?limit=${EPOCH_HISTORY_LIMIT}`,
      fetchImpl,
      CHROME_READ_TIMEOUT_MS,
    )
      .then((body) => epochsEnvelopeSchema.parse(body))
      .catch(() => null),
    vault.getVault(config.vaultAddress).catch(() => null),
  ]);

  return {
    market:
      summary === null
        ? null
        : {
            sample:
              summary.data.sample === null
                ? null
                : {
                    venue: summary.data.sample.venue,
                    priceHash: formatBaseAmount(
                      BigInt(summary.data.sample.price),
                      HASH_EXPONENT,
                      4,
                    ),
                    premiumPercent:
                      summary.data.sample.premium_discount_bps === null
                        ? null
                        : bpsToPercent(summary.data.sample.premium_discount_bps),
                    sampledAt: summary.data.sample.sampled_at,
                    depth: summary.data.sample.depth_bands.map((band) => ({
                      side: band.side,
                      slippageBps: band.slippage_bps,
                      sizeNvhash: formatBaseAmount(BigInt(band.amount), SHARE_EXPONENT, 2),
                    })),
                  },
            bridged: summary.data.bridged_supply.map((row) => ({
              chain: row.chain,
              supplyNvhash: formatBaseAmount(BigInt(row.supply), SHARE_EXPONENT, 2),
              sampledAt: row.sampled_at,
            })),
            meta: summary.meta,
          },
    localSupply:
      vaultState === null
        ? null
        : formatBaseAmount(vaultState.vault.totalShares.amount, SHARE_EXPONENT, 2),
    epochs,
  };
}
