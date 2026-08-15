// Fee-verbatim gate (chain-facts §flatfees; the apps/web/test/tx-fee.test.ts
// mirror). The simulate result IS the fee: 1nhash price, no adjustment
// factor, `gasLimit == amount`. A reintroduced multiplier, buffer, or price
// knob fails these equalities — the exact regression the App's twin test
// pins, because a tx priced off the old `gas × price` model is REJECTED by
// the protocol, not merely overpriced.
import { describe, expect, it } from "vitest";
import { FEE_DENOM, feeFromGas, GAS_PRICE_NHASH } from "@/tx/simulate";

describe("the fee is the simulate result, verbatim", () => {
  it("gas price is exactly 1nhash and is not a tunable", () => {
    expect(GAS_PRICE_NHASH).toBe(1n);
  });

  it("gasLimit == amount for any simulate result (no factor, no buffer)", () => {
    for (const simulated of [1n, 2n, 2750n, 4260000n]) {
      const fee = feeFromGas(simulated);
      expect(fee.gasLimit).toBe(simulated);
      expect(fee.amount).toBe(simulated);
      expect(fee.denom).toBe(FEE_DENOM);
    }
  });

  it("the captured devnet shape holds: fee 2nhash rides gas_limit 2", () => {
    // packages/fixtures operator captures show fee.amount == gas_limit == "2"
    // while execution really consumed ~201k gas — the number is a fee, not gas.
    const fee = feeFromGas(2n);
    expect(fee).toEqual({ gasLimit: 2n, amount: 2n, denom: "nhash" });
  });
});
