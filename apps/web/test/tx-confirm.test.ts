// Exact-JSON disclosure gate (plan 5.2 §4.2; §10.2 step 4): the user signs
// exactly what they saw. The confirm step renders `plan.disclosureJson`;
// the wallet signs `plan.signDocBytes`. This suite DECODES the sign-doc
// bytes and proves the disclosure is a faithful rendering of them — same
// message type, owner, vault, amount, denom — plus the signer facts
// (chain id, account number) the sign doc binds.

import { describe, expect, it } from "vitest";

import {
  buildTxPlan,
  FUNDED_VARIANTS,
  MSG_SWAP_OUT,
  OPERATOR_VARIANTS,
  type OperatorIntent,
  type TxIntent,
} from "~/tx/build";
import { bytesField, bytesFields, readFields, stringField } from "~/tx/proto";

const intent: TxIntent = {
  kind: "swap_out",
  owner: "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0",
  vaultAddress: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad",
  amount: 36_222_971_000_000n,
  denom: "nvhash",
  redeemDenom: "",
};
const signer = {
  chainId: "chain-dev",
  accountNumber: 12n,
  sequence: 4n,
  pubkeyBase64: Buffer.alloc(33, 3).toString("base64"),
};
const plan = buildTxPlan(intent, { gasLimit: 260_000n, amount: 495_300_000n, denom: "nhash" }, signer);

describe("the disclosure equals the signed bytes (single serialization site)", () => {
  it("decoding signDocBytes recovers exactly what the disclosure shows", () => {
    const signDoc = readFields(plan.signDocBytes);
    const bodyBytes = bytesField(signDoc, 1)!;
    expect(stringField(signDoc, 3)).toBe(signer.chainId);

    const body = readFields(bodyBytes);
    const anys = bytesFields(body, 1);
    expect(anys).toHaveLength(1);
    const any = readFields(anys[0]!);
    const msg = readFields(bytesField(any, 2)!);
    const assets = readFields(bytesField(msg, 3)!);

    const disclosed = (JSON.parse(plan.disclosureJson) as Array<Record<string, unknown>>)[0]!;
    expect(disclosed["@type"]).toBe(stringField(any, 1));
    expect(disclosed["owner"]).toBe(stringField(msg, 1));
    expect(disclosed["vault_address"]).toBe(stringField(msg, 2));
    expect(disclosed["assets"]).toEqual({
      denom: stringField(assets, 1),
      amount: stringField(assets, 2),
    });
  });

  it("the disclosure names the right message type for the intent", () => {
    const disclosed = (JSON.parse(plan.disclosureJson) as Array<Record<string, unknown>>)[0]!;
    expect(disclosed["@type"]).toBe(MSG_SWAP_OUT);
  });

  it("sign doc binds the account number (varint field 4)", () => {
    const signDoc = readFields(plan.signDocBytes);
    const acct = signDoc.find((f) => f.field === 4 && f.value.wire === 0);
    expect(acct).toBeDefined();
    expect((acct!.value as { varint: bigint }).varint).toBe(signer.accountNumber);
  });

  it("the plan's body bytes ARE the sign doc's body bytes (no re-encode)", () => {
    const signDoc = readFields(plan.signDocBytes);
    expect(Buffer.from(bytesField(signDoc, 1)!).equals(Buffer.from(plan.bodyBytes))).toBe(true);
    expect(Buffer.from(bytesField(signDoc, 2)!).equals(Buffer.from(plan.authInfoBytes))).toBe(true);
  });
});

// ── M6.4: the same rigor over the operator execute messages ──────────────
//
// §17.1 says graduating privileged writes to the consumer surface must not
// soften the confirmation contract. The risk here is specific: an execute
// message's payload is opaque bytes on the wire, so a disclosure could show
// friendly prose while the signed bytes say something else. These cases prove
// the disclosure is a faithful rendering of the bytes the wallet will sign —
// same variant, same valoper, same funds.

describe("operator execute: the disclosure equals the signed bytes", () => {
  const operatorIntent: OperatorIntent = {
    kind: "operator",
    variant: "pay_commission",
    sender: "tp18kkn20p7dphkal2x84t30cv7z6v9rf9cvykjhk",
    contractAddress: "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8",
    valoper: "tpvaloper1l39wu7cht0zcycc5rkcd90sdd4ksjmxwjqvnjp",
    claimantValoper: null,
    amount: 1_500_000_000n,
    denom: "nhash",
  };
  const operatorPlan = buildTxPlan(
    operatorIntent,
    { gasLimit: 300_000n, amount: 400_000n, denom: "nhash" },
    signer,
  );

  /** The message the sign doc actually carries, decoded from its bytes. */
  function signedMessage(plan: { signDocBytes: Uint8Array }) {
    const signDoc = readFields(plan.signDocBytes);
    const body = readFields(bytesField(signDoc, 1)!);
    const anys = bytesFields(body, 1);
    expect(anys).toHaveLength(1);
    const any = readFields(anys[0]!);
    const msg = readFields(bytesField(any, 2)!);
    const funds = bytesFields(msg, 5).map((coinBytes) => {
      const coin = readFields(coinBytes);
      return { denom: stringField(coin, 1), amount: stringField(coin, 2) };
    });
    return {
      typeUrl: stringField(any, 1),
      sender: stringField(msg, 1),
      contract: stringField(msg, 2),
      payload: new TextDecoder().decode(bytesField(msg, 3)!),
      funds,
    };
  }

  it("every disclosed field is the decoded signed field", () => {
    const signed = signedMessage(operatorPlan);
    const disclosed = (JSON.parse(operatorPlan.disclosureJson) as Array<Record<string, unknown>>)[0]!;

    expect(disclosed["@type"]).toBe(signed.typeUrl);
    expect(disclosed["sender"]).toBe(signed.sender);
    expect(disclosed["contract"]).toBe(signed.contract);
    // The decoded payload the operator SEES is the payload that gets signed.
    expect(JSON.stringify(disclosed["msg"])).toBe(signed.payload);
    expect(disclosed["funds"]).toEqual(signed.funds);
  });

  it("the disclosed variant and valoper are the signed ones, for every variant", () => {
    for (const variant of OPERATOR_VARIANTS) {
      const funded = FUNDED_VARIANTS.has(variant);
      const plan = buildTxPlan(
        { ...operatorIntent, variant, amount: funded ? 7n : 0n },
        { gasLimit: 300_000n, amount: 400_000n, denom: "nhash" },
        signer,
      );
      const signed = signedMessage(plan);
      const disclosed = (JSON.parse(plan.disclosureJson) as Array<Record<string, unknown>>)[0]!;
      expect(Object.keys(disclosed["msg"] as object), variant).toEqual([variant]);
      expect(JSON.stringify(disclosed["msg"]), variant).toBe(signed.payload);
      // A fundless action discloses no coin AND signs none.
      expect(disclosed["funds"], variant).toEqual(funded ? [{ denom: "nhash", amount: "7" }] : []);
      expect(signed.funds, variant).toEqual(funded ? [{ denom: "nhash", amount: "7" }] : []);
    }
  });

  it("a purge's optional claimant appears in the disclosure exactly when signed", () => {
    const withClaimant = buildTxPlan(
      {
        ...operatorIntent,
        variant: "purge_jailed_validator",
        amount: 0n,
        claimantValoper: "tpvaloper1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
      },
      { gasLimit: 300_000n, amount: 400_000n, denom: "nhash" },
      signer,
    );
    const disclosed = (JSON.parse(withClaimant.disclosureJson) as Array<Record<string, unknown>>)[0]!;
    const body = (disclosed["msg"] as Record<string, Record<string, string>>)[
      "purge_jailed_validator"
    ]!;
    expect(body["claimant_valoper"]).toBe("tpvaloper1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq");
    expect(JSON.stringify(disclosed["msg"])).toBe(signedMessage(withClaimant).payload);

    const without = buildTxPlan(
      { ...operatorIntent, variant: "purge_jailed_validator", amount: 0n, claimantValoper: null },
      { gasLimit: 300_000n, amount: 400_000n, denom: "nhash" },
      signer,
    );
    const withoutBody = (
      (JSON.parse(without.disclosureJson) as Array<Record<string, unknown>>)[0]![
        "msg"
      ] as Record<string, Record<string, string>>
    )["purge_jailed_validator"]!;
    expect("claimant_valoper" in withoutBody).toBe(false);
  });
});
