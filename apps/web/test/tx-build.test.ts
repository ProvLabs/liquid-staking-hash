// Byte-golden message-builder gate (plan 5.2 §4; app-spec §14.2 stage 1).
// The encoder must reproduce the EXACT bytes the chain accepted for the
// captured corpus transactions: TxRaw re-encoded from the fixture's
// proto-JSON must hash to the fixture's txhash (sha256, the chain's tx id).
// This pins every assumed field number and canonical-encoding rule — a
// wrong assumption cannot produce the right hash. PR 8.0 re-vets the corpus
// against the formal vault release.

import { describe, expect, it } from "vitest";

import swapInFixture from "@nvhash/fixtures/msgs/swap-in";
import swapOutFixture from "@nvhash/fixtures/msgs/swap-out";

import {
  ALLOWED_MSG_TYPE_URLS,
  buildTxPlan,
  decodeTxRaw,
  encodeAuthInfo,
  encodeIntentMsg,
  encodeTxBody,
  encodeTxRaw,
  intentToProtoJson,
  MSG_SWAP_IN,
  MSG_SWAP_OUT,
  txHash,
  type TxIntent,
} from "~/tx/build";

interface FixtureTx {
  tx: {
    body: {
      messages: Array<Record<string, unknown>>;
      memo: string;
    };
    auth_info: {
      signer_infos: Array<{
        public_key: { "@type": string; key: string };
        sequence: string;
      }>;
      fee: {
        amount: Array<{ denom: string; amount: string }>;
        gas_limit: string;
      };
    };
    signatures: string[];
  };
  tx_response: { txhash: string };
}

function intentFromFixtureMsg(msg: Record<string, unknown>): TxIntent {
  const assets = msg["assets"] as { denom: string; amount: string };
  const common = {
    owner: msg["owner"] as string,
    vaultAddress: msg["vault_address"] as string,
    amount: BigInt(assets.amount),
    denom: assets.denom,
  };
  return msg["@type"] === MSG_SWAP_IN
    ? { kind: "swap_in", ...common }
    : { kind: "swap_out", ...common, redeemDenom: (msg["redeem_denom"] as string) ?? "" };
}

function reencodedHash(fixture: FixtureTx): string {
  const intent = intentFromFixtureMsg(fixture.tx.body.messages[0]!);
  const signerInfo = fixture.tx.auth_info.signer_infos[0]!;
  const fee = fixture.tx.auth_info.fee;
  const bodyBytes = encodeTxBody([encodeIntentMsg(intent)], fixture.tx.body.memo);
  const authInfoBytes = encodeAuthInfo(
    {
      chainId: "irrelevant-for-txraw",
      accountNumber: 0n,
      sequence: BigInt(signerInfo.sequence),
      pubkeyBase64: signerInfo.public_key.key,
    },
    {
      gasLimit: BigInt(fee.gas_limit),
      amount: BigInt(fee.amount[0]!.amount),
      denom: fee.amount[0]!.denom,
    },
  );
  const txRaw = encodeTxRaw(
    bodyBytes,
    authInfoBytes,
    fixture.tx.signatures.map((s) => Uint8Array.from(Buffer.from(s, "base64"))),
  );
  return txHash(txRaw);
}

describe("byte-golden: re-encoded corpus txs hash to their chain tx ids", () => {
  it("MsgSwapInRequest", () => {
    expect(reencodedHash(swapInFixture as unknown as FixtureTx)).toBe(
      (swapInFixture as unknown as FixtureTx).tx_response.txhash,
    );
  });

  it("MsgSwapOutRequest", () => {
    expect(reencodedHash(swapOutFixture as unknown as FixtureTx)).toBe(
      (swapOutFixture as unknown as FixtureTx).tx_response.txhash,
    );
  });
});

describe("builder ↔ decoder round trip (the relay guard reads what we write)", () => {
  const intent: TxIntent = {
    kind: "swap_out",
    owner: "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0",
    vaultAddress: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad",
    amount: 123_456_789n,
    denom: "nvhash",
    redeemDenom: "",
  };
  const signer = {
    chainId: "chain-dev",
    accountNumber: 7n,
    sequence: 3n,
    pubkeyBase64: Buffer.alloc(33, 5).toString("base64"),
  };
  const fee = { gasLimit: 200_000n, amount: 390_000_000n, denom: "nhash" };

  it("decodeTxRaw recovers type url, owner, vault, signer pubkey", () => {
    const plan = buildTxPlan(intent, fee, signer);
    const txRaw = encodeTxRaw(plan.bodyBytes, plan.authInfoBytes, [new Uint8Array(64)]);
    const decoded = decodeTxRaw(txRaw);
    expect(decoded.messages).toEqual([
      { typeUrl: MSG_SWAP_OUT, owner: intent.owner, vaultAddress: intent.vaultAddress },
    ]);
    expect(decoded.signatureCount).toBe(1);
    expect(decoded.signerPubkeys).toHaveLength(1);
    expect(Buffer.from(decoded.signerPubkeys[0]!).toString("base64")).toBe(signer.pubkeyBase64);
  });

  it("rejects malformed bytes rather than guessing", () => {
    expect(() => decodeTxRaw(new Uint8Array([0xff, 0xff]))).toThrow();
    expect(() => decodeTxRaw(new Uint8Array([]))).toThrow(); // no body/auth
  });

  it("the allowlist is exactly the two vault messages", () => {
    expect([...ALLOWED_MSG_TYPE_URLS].sort()).toEqual([MSG_SWAP_IN, MSG_SWAP_OUT].sort());
  });
});

describe("disclosure JSON mirrors the encoded message (single site)", () => {
  it("swap-in disclosure fields equal the fixture message JSON", () => {
    const fixtureMsg = (swapInFixture as unknown as FixtureTx).tx.body.messages[0]!;
    const intent = intentFromFixtureMsg(fixtureMsg);
    const json = intentToProtoJson(intent);
    expect(json["@type"]).toBe(fixtureMsg["@type"]);
    expect(json["owner"]).toBe(fixtureMsg["owner"]);
    expect(json["vault_address"]).toBe(fixtureMsg["vault_address"]);
    expect(json["assets"]).toEqual(fixtureMsg["assets"]);
  });
});
