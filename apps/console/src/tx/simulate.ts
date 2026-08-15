// §10.2 step-2 simulation — MIRROR-TRACKED against
// apps/web/app/tx/simulate.server.ts (the reference implementation, whose
// header carries the full flat-fee rationale; update both in the same change).
//
// THE ONE RULE (chain-facts §flatfees, gated by test/tx-fee.test.ts): the
// simulate result IS the fee, used VERBATIM. The gas price is 1nhash and is
// NOT a tunable; there is NO adjustment buffer; `gasLimit == amount`. A tx
// priced off the old `price × gas` model is REJECTED by the protocol, and a
// confirm sheet stating a fee it did not compute is a §17 honesty break.

import { lcdPostJson } from "@/data/lcd";
import { bytesToBase64, encodeTxRaw, type Fee } from "@/tx/build";

/** The flat-fee gas price. Not a tunable: any other value produces
 *  transactions the protocol rejects outright. */
export const GAS_PRICE_NHASH = 1n;

export const FEE_DENOM = "nhash";

/**
 * Price a simulate result. `simulated` is what the chain returned, which
 * under flat fees IS the required fee — verbatim, no adjustment, no
 * multiplication beyond the 1nhash price.
 */
export function feeFromGas(simulated: bigint): Fee {
  return { gasLimit: simulated, amount: simulated * GAS_PRICE_NHASH, denom: FEE_DENOM };
}

/**
 * Simulate the unsigned tx (placeholder 64-byte signature, the SDK
 * convention; a provisional zero fee — the result does not depend on it) and
 * return the priced fee. A simulation failure THROWS with the chain's error
 * verbatim, before anything is signed.
 */
export async function simulateFee(bodyBytes: Uint8Array, authInfoBytes: Uint8Array): Promise<Fee> {
  const unsigned = encodeTxRaw(bodyBytes, authInfoBytes, [new Uint8Array(64)]);
  const body = await lcdPostJson("/cosmos/tx/v1beta1/simulate", {
    tx_bytes: bytesToBase64(unsigned),
  });
  const gas = (body as { gas_info?: { gas_used?: string } }).gas_info?.gas_used;
  if (typeof gas !== "string" || !/^\d+$/.test(gas)) {
    throw new Error("simulate: no gas_info.gas_used in response");
  }
  return feeFromGas(BigInt(gas));
}
