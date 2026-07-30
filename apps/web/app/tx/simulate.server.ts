// §10.2 step-3 simulation: the fee comes from the chain's
// own simulate endpoint over the UNSIGNED tx bytes, and is used VERBATIM.
//
// THE ONE THING TO UNDERSTAND HERE. Under Provenance's flat-fee model the
// required fee is a deterministic per-message cost (`x/flatfees`
// `CalculateMsgCost`), unrelated to gas consumed — and `Simulate` returns THAT
// FEE AMOUNT in the gas-wanted field, which is why the chain's own guidance is
// to use a gas price of exactly 1nhash:
//
//   "Our Simulate method returns the amount of fee as the gas wanted and we
//    tell people to use gas-prices 1nhash. That causes all the clients to
//    provide that amount of fee as the gas wanted, though."
//   — provenance internal/antewrapper/utils.go (GetGasWanted), the antewrapper
//     then substitutes a real gas limit for execution.
//
// So the simulate result is ALREADY the fee. Consequences, each of which was
// violated by the pre-flat-fee code this replaces:
//
//   * The gas price is 1nhash and is NOT a tunable. A tx priced off the old
//     `price × gas estimate` model is REJECTED by the protocol — deliberately,
//     to stop clients re-importing that assumption. 1905nhash is a defect, not
//     an overpayment.
//   * There is NO adjustment buffer. A ×1.3 would inflate a deterministic cost
//     by 30% while buying nothing: the number is not gas, so there is no
//     out-of-gas headroom to purchase. The chain sizes the real gas limit.
//   * `gasLimit` and `amount` are therefore the same number — exactly what
//     captured devnet txs show (`fee: 2nhash`, `gas_limit: "2"`, while the
//     execution really consumed ~201k gas).
//
// Every `infra/devnet/**` action and `contracts/drills/**` drill transacts this
// way already (`--gas-prices 1nhash`). Pinned by `test/tx-fee.test.ts`.

import { LcdClient, TxClient, type FetchLike } from "@nvhash/chain-client";

import type { WebConfig } from "~/config/config.server";
import { encodeTxRaw, type Fee, type SignerContext, type TxIntent, buildTxPlan } from "./build";

/**
 * The flat-fee gas price. Not a tunable: any other value produces
 * transactions the protocol rejects outright.
 */
export const GAS_PRICE_NHASH = 1n;

export const FEE_DENOM = "nhash";

export interface SimulationResult {
  /** The simulate endpoint's raw result — under flat fees, the fee amount. */
  gasUsed: string;
  fee: Fee;
}

/**
 * Price a simulate result. `simulated` is what the chain returned, which under
 * flat fees IS the required fee — so it is used verbatim, with no adjustment
 * and no multiplication beyond the 1nhash price.
 */
export function feeFromGas(simulated: bigint): Fee {
  return { gasLimit: simulated, amount: simulated * GAS_PRICE_NHASH, denom: FEE_DENOM };
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
