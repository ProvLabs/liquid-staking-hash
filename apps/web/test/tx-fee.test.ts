// The §10.2 step-3 FEE BASIS, held as a standing gate.
//
// This suite exists because the fee basis is the one number in the tx path
// whose error mode is not degradation. Under Provenance's flat-fee model the
// required fee is a deterministic per-message cost, and `Simulate` returns that
// FEE AMOUNT in the gas-wanted field — which is why the chain's guidance is a
// gas price of exactly 1nhash (provenance `internal/antewrapper/utils.go`,
// `GetGasWanted`). Two failure modes follow, and both make every transaction
// the App builds unbroadcastable or wrong rather than merely mispriced:
//
//   * a gas price other than 1nhash — the protocol REJECTS a tx priced off the
//     old `price × gas estimate` model, on purpose;
//   * any adjustment buffer — it inflates a deterministic cost while buying no
//     out-of-gas headroom, because the simulated number is not gas.
//
// Both shipped wrong once (1905nhash × 1.3, inherited from the pre-flat-fee
// console) and nothing failed, because no test pinned it. That is this file.

import { describe, expect, it } from "vitest";

import { FEE_PROVISION_NHASH } from "~/tx/preflight.server";
import { FEE_DENOM, GAS_PRICE_NHASH, feeFromGas } from "~/tx/simulate.server";

describe("fee basis (Provenance flat fees: simulate returns the fee)", () => {
  it("prices at exactly 1 nhash — not the pre-flat-fee 1905", () => {
    expect(GAS_PRICE_NHASH).toBe(1n);
    expect(FEE_DENOM).toBe("nhash");
  });

  it("uses the simulate result VERBATIM — no adjustment buffer", () => {
    // Any ×1.3-style padding shows up here immediately.
    for (const simulated of [2n, 1_000n, 201_463n, 4_000_000n]) {
      const fee = feeFromGas(simulated);
      expect(fee.gasLimit).toBe(simulated);
      expect(fee.amount).toBe(simulated);
      expect(fee.denom).toBe("nhash");
    }
  });

  it("matches the shape of captured devnet txs (fee == gas_limit)", () => {
    // The three captured operator txs all carry `fee: 2nhash` with
    // `gas_limit: "2"` while really consuming ~200k gas — proof that the fee is
    // decoupled from gas consumed and that the two fields are one number.
    const fee = feeFromGas(2n);
    expect(fee.gasLimit).toBe(2n);
    expect(fee.amount).toBe(2n);
  });

  it("never inflates a deterministic cost into whole HASH", () => {
    // A real operator action costs single-digit nhash. If this ever lands in
    // whole-HASH territory, a price or a buffer has crept back in.
    expect(feeFromGas(2n).amount).toBeLessThan(1_000n);
  });

  it("provisions a pre-simulation reserve that covers the fee without blocking", () => {
    // The provision only bridges preflight (before the fee is known) to
    // simulate. It must clear the real cost by a wide margin…
    expect(FEE_PROVISION_NHASH).toBeGreaterThan(feeFromGas(4_000_000n).amount / 1_000n);
    expect(FEE_PROVISION_NHASH).toBeGreaterThan(1_000_000n);
    // …and must NOT be inflated: a provision is subtracted from what the user
    // may swap, so an over-large one reports `insufficient-balance` for
    // transactions they can easily afford. The old 2 HASH was that failure.
    expect(FEE_PROVISION_NHASH).toBeLessThan(100_000_000n); // < 0.1 HASH
  });
});
