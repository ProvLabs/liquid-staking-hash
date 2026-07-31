// Byte-golden message-builder gate (app-spec §14.2 stage 1).
// The encoder must reproduce the EXACT bytes the chain accepted for the
// captured corpus transactions: TxRaw re-encoded from the fixture's
// proto-JSON must hash to the fixture's txhash (sha256, the chain's tx id).
// This pins every assumed field number and canonical-encoding rule — a
// wrong assumption cannot produce the right hash. The corpus is re-vetted
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
  MSG_EXECUTE_CONTRACT,
  MSG_SWAP_IN,
  MSG_SWAP_OUT,
  txHash,
  type TxIntent,
} from "~/tx/build";
import { bytesField, bytesFields, readFields, stringField } from "~/tx/proto";

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
    expect(decoded.messages).toMatchObject([
      { typeUrl: MSG_SWAP_OUT, owner: intent.owner, vaultAddress: intent.vaultAddress },
    ]);
    // A vault msg carries no execute payload; the guard's execute branch never
    // runs for it, and its field-5 funds list is empty.
    expect(decoded.messages[0]!.execFunds).toEqual([]);
    expect(decoded.signatureCount).toBe(1);
    expect(decoded.signerPubkeys).toHaveLength(1);
    expect(Buffer.from(decoded.signerPubkeys[0]!).toString("base64")).toBe(signer.pubkeyBase64);
  });

  it("rejects malformed bytes rather than guessing", () => {
    expect(() => decodeTxRaw(new Uint8Array([0xff, 0xff]))).toThrow();
    expect(() => decodeTxRaw(new Uint8Array([]))).toThrow(); // no body/auth
  });

  it("the allowlist holds the two vault messages, plus guarded entries", () => {
    // `MsgExecuteContract` and the three `cosmos.group.v1` types are each safe
    // only because the relay runs a second-level guard for them. The closed-set
    // assertions live in
    // test/tx-operator-build.test.ts and the rejection matrices in
    // test/broadcast-guard.test.ts. Here we only pin that the VAULT pair is
    // unchanged and that the total has not grown beyond the amended set.
    expect(ALLOWED_MSG_TYPE_URLS).toContain(MSG_SWAP_IN);
    expect(ALLOWED_MSG_TYPE_URLS).toContain(MSG_SWAP_OUT);
    expect(ALLOWED_MSG_TYPE_URLS).toHaveLength(6);
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

// ── Canonical-encoding goldens for the three governance messages ──────────
//
// WHY HEX RATHER THAN A ROUND TRIP. The operator messages have byte-goldens
// against CAPTURED DEVNET TRANSACTIONS (`tx-operator-build.test.ts`) — the
// strongest form, because it proves the canonical form is the form the chain
// accepted. No governance transaction the App itself built exists in the corpus
// yet (7.1's drill used the CLI), so that proof belongs to `e2e-live` until one
// is captured, and this suite pins the next-best thing: the exact bytes, so any
// change to field order, to the `exec` pin, or to the omitted-default rules is
// a visible diff rather than a silent re-encode.
//
// A round-trip assertion could not do this job. Encode-then-decode passes for
// ANY self-consistent encoding, including a wrong one — and the relay guard
// compares against these exact bytes, so "self-consistent" is precisely not the
// property that matters.

const GOV_VOTER = "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0";
const GOV_POLICY_ADDR = "tp1qgvqctd47dqe9ryqkzc0zpu3wkqjr3sndkldpwfjfcqz0f4tqzsq7wshjm";
const GOV_CONTRACT_ADDR = "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("governance messages encode to exactly one canonical byte string", () => {
  it("MsgVote: proposal_id, voter, option — and NOTHING else", () => {
    const { typeUrl, value } = encodeIntentMsg({
      kind: "gov_vote",
      voter: GOV_VOTER,
      proposalId: 12n,
      option: "yes",
    });
    expect(typeUrl).toBe("/cosmos.group.v1.MsgVote");
    // 08 0c            field 1 varint = 12
    // 12 29 <41 bytes> field 2 string = the voter
    // 18 01            field 3 varint = VOTE_OPTION_YES
    // …and no field 4 (metadata) or field 5 (exec): the pins are ABSENCE.
    expect(hex(value)).toBe(
      `080c1229${Buffer.from(GOV_VOTER, "utf8").toString("hex")}1801`,
    );
  });

  it("MsgVote's option byte is the module's enum value, per option", () => {
    for (const [option, wire] of [
      ["yes", "01"],
      ["abstain", "02"],
      ["no", "03"],
      ["no_with_veto", "04"],
    ] as const) {
      const { value } = encodeIntentMsg({
        kind: "gov_vote",
        voter: GOV_VOTER,
        proposalId: 1n,
        option,
      });
      expect(hex(value).endsWith(`18${wire}`), option).toBe(true);
    }
  });

  it("MsgExec: proposal_id and signer, and the message has no other field", () => {
    const { typeUrl, value } = encodeIntentMsg({
      kind: "gov_exec",
      signer: GOV_VOTER,
      proposalId: 12n,
    });
    expect(typeUrl).toBe("/cosmos.group.v1.MsgExec");
    expect(hex(value)).toBe(`080c1229${Buffer.from(GOV_VOTER, "utf8").toString("hex")}`);
  });

  it("MsgSubmitProposal: fields in field-number order, exec omitted, one proposer", () => {
    const { typeUrl, value } = encodeIntentMsg({
      kind: "gov_submit",
      proposer: GOV_VOTER,
      policyAddress: GOV_POLICY_ADDR,
      contractAddress: GOV_CONTRACT_ADDR,
      templates: [{ id: "unpause_vault", values: {} }],
      title: "Unpause",
      summary: "Restore deposits.",
      metadata: "",
    });
    expect(typeUrl).toBe("/cosmos.group.v1.MsgSubmitProposal");
    const decoded = readFields(value);
    // Field ORDER is part of the canonical form the guard re-encodes against.
    expect(decoded.map((f) => f.field)).toEqual([1, 2, 4, 6, 7]);
    // Field 3 (metadata) is omitted when empty; field 5 (exec) is NEVER written.
    expect(decoded.some((f) => f.field === 3)).toBe(false);
    expect(decoded.some((f) => f.field === 5)).toBe(false);
    expect(stringField(decoded, 1)).toBe(GOV_POLICY_ADDR);
    expect(stringField(decoded, 2)).toBe(GOV_VOTER);
    expect(stringField(decoded, 6)).toBe("Unpause");
    expect(stringField(decoded, 7)).toBe("Restore deposits.");
  });

  it("a supplied metadata takes field 3, still in order", () => {
    const { value } = encodeIntentMsg({
      kind: "gov_submit",
      proposer: GOV_VOTER,
      policyAddress: GOV_POLICY_ADDR,
      contractAddress: GOV_CONTRACT_ADDR,
      templates: [{ id: "unpause_vault", values: {} }],
      title: "Unpause",
      summary: "Restore deposits.",
      metadata: "discussed 2026-07-29",
    });
    const decoded = readFields(value);
    expect(decoded.map((f) => f.field)).toEqual([1, 2, 3, 4, 6, 7]);
    expect(stringField(decoded, 3)).toBe("discussed 2026-07-29");
  });

  it("the inner Any is a MsgExecuteContract from the POLICY, with no funds", () => {
    const { value } = encodeIntentMsg({
      kind: "gov_submit",
      proposer: GOV_VOTER,
      policyAddress: GOV_POLICY_ADDR,
      contractAddress: GOV_CONTRACT_ADDR,
      templates: [{ id: "set_halted", values: { halted: true } }],
      title: "Halt",
      summary: "Stop the cranks.",
      metadata: "",
    });
    const anys = bytesFields(readFields(value), 4);
    expect(anys).toHaveLength(1);
    const any = readFields(anys[0]!);
    expect(stringField(any, 1)).toBe(MSG_EXECUTE_CONTRACT);
    const exec = readFields(bytesField(any, 2)!);
    // The sender is the POLICY (x/group executes as the policy account, which
    // is the contract's admin) — not the proposer.
    expect(stringField(exec, 1)).toBe(GOV_POLICY_ADDR);
    expect(stringField(exec, 2)).toBe(GOV_CONTRACT_ADDR);
    expect(new TextDecoder().decode(bytesField(exec, 3)!)).toBe(`{"set_halted":{"halted":true}}`);
    // No admin variant is payable.
    expect(bytesFields(exec, 5)).toHaveLength(0);
  });

  it("building the same intent twice yields identical bytes (the guard depends on it)", () => {
    const intent = {
      kind: "gov_submit" as const,
      proposer: GOV_VOTER,
      policyAddress: GOV_POLICY_ADDR,
      contractAddress: GOV_CONTRACT_ADDR,
      templates: [
        { id: "update_config", values: { commission_bps: 1_000n, aum_fee_bps: 25n } },
      ],
      title: "Retune",
      summary: "Adjust two parameters.",
      metadata: "",
    };
    // Input key order differs; the canonical output must not.
    const other = {
      ...intent,
      templates: [
        { id: "update_config", values: { aum_fee_bps: 25n, commission_bps: 1_000n } },
      ],
    };
    expect(hex(encodeIntentMsg(intent).value)).toBe(hex(encodeIntentMsg(other).value));
  });
});
