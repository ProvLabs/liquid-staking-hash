// §10.2 step-3 simulation (app plan PR 5.2 §3): gas via the chain's own
// simulate endpoint over the UNSIGNED tx bytes; fee = gas × gas price ×
// adjustment. The gas price (1905 nhash) and ×1.3 adjustment mirror the
// console's values and inherit its `[VERIFY §14.3]` marker — one program,
// one fee basis (console-spec §7).
//
// Integer discipline: the adjustment is computed as ×13/10 in bigint — no
// floats near amounts, ever (spec §3 decision 8).

import { LcdClient, TxClient, type FetchLike } from "@nvhash/chain-client";

import type { WebConfig } from "~/config/config.server";
import { encodeTxRaw, type Fee, type SignerContext, type TxIntent, buildTxPlan } from "./build";

/** [VERIFY §14.3] — the console's fee-estimation basis, mirrored. */
export const GAS_PRICE_NHASH = 1905n;
/** ×1.3 as an integer ratio. */
const GAS_ADJUSTMENT_NUM = 13n;
const GAS_ADJUSTMENT_DEN = 10n;

export const FEE_DENOM = "nhash";

export interface SimulationResult {
  gasUsed: string;
  fee: Fee;
}

export function feeFromGas(gasUsed: bigint): Fee {
  const gasLimit = (gasUsed * GAS_ADJUSTMENT_NUM + GAS_ADJUSTMENT_DEN - 1n) / GAS_ADJUSTMENT_DEN;
  return { gasLimit, amount: gasLimit * GAS_PRICE_NHASH, denom: FEE_DENOM };
}

/**
 * Simulate an intent for the session signer and return the priced fee. The
 * tx is encoded unsigned (empty signature placeholder, the SDK convention
 * for simulate) with a provisional zero fee — gas does not depend on it.
 */
export async function simulateIntent(
  config: WebConfig,
  intent: TxIntent,
  signer: SignerContext,
  deps: { fetchImpl?: FetchLike } = {},
): Promise<SimulationResult> {
  const lcd = new LcdClient(config.lcdUrl, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  const tx = new TxClient(lcd);

  const provisional = buildTxPlan(intent, { gasLimit: 0n, amount: 0n, denom: FEE_DENOM }, signer);
  const unsigned = encodeTxRaw(provisional.bodyBytes, provisional.authInfoBytes, [
    new Uint8Array(64), // placeholder signature; simulate ignores content
  ]);
  const { gasUsed } = await tx.simulate(Buffer.from(unsigned).toString("base64"));
  return { gasUsed: gasUsed.toString(), fee: feeFromGas(gasUsed) };
}
