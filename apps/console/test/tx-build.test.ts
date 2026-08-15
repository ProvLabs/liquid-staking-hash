// Byte-golden encoding gate (PR 8.4b §3.4; the apps/web
// test/tx-operator-build.test.ts discipline): re-encode a CAPTURED devnet
// transaction from its proto-JSON and require sha256(TxRaw) to equal the
// chain's own tx id. This pins the exact bytes of the inner execute payload —
// any difference in key order, spacing, or optional-field handling changes
// the hash.
//
// Fixture literals COPIED from packages/fixtures/fixtures/operator/
// pay-tip.json (captured from devnet 2026-07-27) with this provenance note —
// the console sits outside the pnpm workspace and cannot import the package.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  decodeAuthAccount,
  encodeAuthInfo,
  encodeExecuteContract,
  encodeSignDoc,
  encodeTxBody,
  encodeTxRaw,
  MSG_EXECUTE_CONTRACT,
} from "@/tx/build";
import type { ExecuteMsg } from "@/tx/messages";

// packages/fixtures/fixtures/operator/pay-tip.json — the captured tx.
const CAPTURED = {
  sender: "tp18kkn20p7dphkal2x84t30cv7z6v9rf9cvykjhk",
  contract: "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8",
  message: {
    pay_tip: { valoper: "tpvaloper1l39wu7cht0zcycc5rkcd90sdd4ksjmxwjqvnjp" },
  } as ExecuteMsg,
  funds: [{ denom: "nhash", amount: "2750000000" }],
  pubkeyBase64: "A/fUVxA32pTiVz0qolEhNPTp0A8hw+WtgSMcTcRvwyYk",
  sequence: 14n,
  fee: { denom: "nhash", amount: 2n, gasLimit: 2n },
  signatureBase64:
    "Eavpo4OqJ7hrn2R+zUOSdEcAADhJC1jqUkIsi5DGrB0rVEK60paaRXOIuq4jhCpVZwLkp039WtC48H4paIzBvQ==",
  txhash: "2D2F591E0820634497F18EF617296AE5D68CE3464D877D680D423E416EF83B69",
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

describe("byte-golden: the re-encoded captured tx hashes to its chain tx id", () => {
  it("pay_tip (funded MsgExecuteContract) round-trips to the captured txhash", () => {
    const bodyBytes = encodeTxBody([
      {
        typeUrl: MSG_EXECUTE_CONTRACT,
        value: encodeExecuteContract(
          CAPTURED.sender,
          CAPTURED.contract,
          CAPTURED.message,
          CAPTURED.funds,
        ),
      },
    ]);
    const authInfoBytes = encodeAuthInfo(
      {
        chainId: "irrelevant-for-txraw",
        accountNumber: 0n,
        sequence: CAPTURED.sequence,
        pubkeyBase64: CAPTURED.pubkeyBase64,
      },
      CAPTURED.fee,
    );
    const txRaw = encodeTxRaw(bodyBytes, authInfoBytes, [base64ToBytes(CAPTURED.signatureBase64)]);
    expect(sha256Hex(txRaw)).toBe(CAPTURED.txhash);
  });
});

describe("funds discipline at the encoding boundary", () => {
  const fundless: ExecuteMsg = { run_epoch: {} };
  const payment: ExecuteMsg = { pay_tip: { valoper: "tpvaloper1aaa" } };

  it("a fundless action with funds throws before anything reaches the wallet", () => {
    expect(() =>
      encodeExecuteContract("tp1a", "tp1c", fundless, [{ denom: "nhash", amount: "1" }]),
    ).toThrow(/must not carry funds/);
  });

  it("a payment without exactly one positive coin throws", () => {
    expect(() => encodeExecuteContract("tp1a", "tp1c", payment, [])).toThrow(/exactly one coin/);
    expect(() =>
      encodeExecuteContract("tp1a", "tp1c", payment, [{ denom: "nhash", amount: "0" }]),
    ).toThrow(/positive Uint128/);
    expect(() =>
      encodeExecuteContract("tp1a", "tp1c", payment, [
        { denom: "nhash", amount: ((1n << 128n) + 1n).toString() },
      ]),
    ).toThrow(/positive Uint128/);
  });
});

describe("SignDoc shape (what the extension signs over)", () => {
  it("encodes body, auth info, chain id and account number in field order", () => {
    const doc = encodeSignDoc(new Uint8Array([1]), new Uint8Array([2]), "chain-dev", 7n);
    // 0x0a = field 1 wire 2, 0x12 = field 2 wire 2, 0x1a = field 3 wire 2,
    // 0x20 = field 4 wire 0 — the proto3 canonical order.
    expect(Array.from(doc)).toEqual([
      0x0a,
      1,
      1,
      0x12,
      1,
      2,
      0x1a,
      9,
      ...Array.from(new TextEncoder().encode("chain-dev")),
      0x20,
      7,
    ]);
  });
});

describe("auth account decoding (defensive over wrapper shapes)", () => {
  it("reads a bare BaseAccount", () => {
    expect(decodeAuthAccount({ account: { account_number: "12", sequence: "3" } })).toEqual({
      accountNumber: 12n,
      sequence: 3n,
    });
  });

  it("reads a wrapped account (base_account inside)", () => {
    expect(
      decodeAuthAccount({
        account: { base_account: { account_number: "12", sequence: "3" } },
      }),
    ).toEqual({ accountNumber: 12n, sequence: 3n });
  });

  it("a fresh account with no sequence defaults to 0 — but a missing number throws", () => {
    expect(decodeAuthAccount({ account: { account_number: "5" } }).sequence).toBe(0n);
    expect(() => decodeAuthAccount({ account: { sequence: "3" } })).toThrow(/account_number/);
    expect(() => decodeAuthAccount(null)).toThrow(/unexpected response shape/);
  });
});
