// Exact-JSON disclosure gate (plan 5.2 §4.2; §10.2 step 4): the user signs
// exactly what they saw. The confirm step renders `plan.disclosureJson`;
// the wallet signs `plan.signDocBytes`. This suite DECODES the sign-doc
// bytes and proves the disclosure is a faithful rendering of them — same
// message type, owner, vault, amount, denom — plus the signer facts
// (chain id, account number) the sign doc binds.

import { describe, expect, it } from "vitest";

import { buildTxPlan, MSG_SWAP_OUT, type TxIntent } from "~/tx/build";
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
