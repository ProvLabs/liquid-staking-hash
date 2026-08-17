import { lcdPostJson } from "@/data/lcd";
import { bytesToBase64, encodeTxRaw, type Fee } from "@/tx/build";

/** The flat-fee gas price. Not a tunable: any other value produces
 *  transactions the protocol rejects outright. */
export const GAS_PRICE_NHASH = 1n;

export const FEE_DENOM = "nhash";

export function feeFromGas(simulated: bigint): Fee {
  return { gasLimit: simulated, amount: simulated * GAS_PRICE_NHASH, denom: FEE_DENOM };
}

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
