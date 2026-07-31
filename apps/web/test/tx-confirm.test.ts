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
  GOVERNANCE_VOTE_OPTIONS,
  GOVERNANCE_VOTE_OPTION_NAMES,
  MSG_SWAP_OUT,
  OPERATOR_VARIANTS,
  type OperatorIntent,
  type TxIntent,
} from "~/tx/build";
import { bytesField, bytesFields, readFields, stringField, uintField } from "~/tx/proto";

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

// ── M7.3–7.4: the governance disclosures (§2.6, §4 invariant 12) ─────────
//
// The same property, on the three messages where it matters most: the user
// signs exactly what they saw. For a governance write that is not a nicety —
// §2.6 is explicit that `MsgExec`'s disclosure must show WHAT THE PROPOSAL WILL
// EXECUTE rather than "execute proposal 12", because that is the difference
// between an informed signature and a blind one.
//
// Two facts these cases pin that the swap/operator cases cannot:
//
//   * `exec` is DISCLOSED as `EXEC_UNSPECIFIED` even though it is ABSENT from
//     the signed bytes (proto3 omits a zero). That is deliberate: "this will not
//     also execute" is the single most consequential fact about a vote signature
//     (§2.4), and a reader cannot infer it from a missing key. The disclosure is
//     therefore a faithful rendering of the message's SEMANTICS, and this suite
//     proves the two agree rather than assuming it.
//   * every inner message of a submission appears DECODED, not as a count.

const govSigner = {
  chainId: "chain-dev",
  accountNumber: 12n,
  sequence: 4n,
  pubkeyBase64: Buffer.alloc(33, 3).toString("base64"),
};
const govFee = { gasLimit: 1n, amount: 1n, denom: "nhash" };
const VOTER = "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0";
const GOV_POLICY = "tp1qgvqctd47dqe9ryqkzc0zpu3wkqjr3sndkldpwfjfcqz0f4tqzsq7wshjm";
const GOV_CONTRACT = "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8";

/** The single `Any` inside a plan's sign doc, decoded. */
function signedAny(built: ReturnType<typeof buildTxPlan>) {
  const signDoc = readFields(built.signDocBytes);
  const body = readFields(bytesField(signDoc, 1)!);
  const anys = bytesFields(body, 1);
  expect(anys).toHaveLength(1);
  const any = readFields(anys[0]!);
  return { typeUrl: stringField(any, 1), fields: readFields(bytesField(any, 2)!) };
}

function disclosureOf(built: ReturnType<typeof buildTxPlan>): Record<string, unknown> {
  return (JSON.parse(built.disclosureJson) as Array<Record<string, unknown>>)[0]!;
}

describe("governance disclosures equal the signed bytes", () => {
  it("a vote discloses the proposal, voter and option that are actually signed", () => {
    for (const option of GOVERNANCE_VOTE_OPTION_NAMES) {
      const built = buildTxPlan(
        { kind: "gov_vote", voter: VOTER, proposalId: 12n, option },
        govFee,
        govSigner,
      );
      const signed = signedAny(built);
      const disclosed = disclosureOf(built);
      expect(disclosed["@type"], option).toBe(signed.typeUrl);
      expect(disclosed["proposal_id"], option).toBe(
        uintField(signed.fields, 1)!.toString(),
      );
      expect(disclosed["voter"], option).toBe(stringField(signed.fields, 2));
      expect(disclosed["option"], option).toBe(`VOTE_OPTION_${option.toUpperCase()}`);
      expect(uintField(signed.fields, 3), option).toBe(GOVERNANCE_VOTE_OPTIONS[option]);
    }
  });

  it("a vote discloses the exec PIN, and the signed bytes carry no exec field", () => {
    const built = buildTxPlan(
      { kind: "gov_vote", voter: VOTER, proposalId: 12n, option: "yes" },
      govFee,
      govSigner,
    );
    expect(disclosureOf(built)["exec"]).toBe("EXEC_UNSPECIFIED");
    expect(disclosureOf(built)["metadata"]).toBe("");
    // Absent on the wire IS the pin — and the guard enforces it as absence.
    expect(signedAny(built).fields.some((f) => f.field === 5)).toBe(false);
    expect(signedAny(built).fields.some((f) => f.field === 4)).toBe(false);
  });

  it("an exec discloses the proposal and signer that are actually signed", () => {
    const built = buildTxPlan(
      { kind: "gov_exec", signer: VOTER, proposalId: 12n },
      govFee,
      govSigner,
    );
    const signed = signedAny(built);
    const disclosed = disclosureOf(built);
    expect(disclosed["@type"]).toBe(signed.typeUrl);
    expect(disclosed["proposal_id"]).toBe(uintField(signed.fields, 1)!.toString());
    expect(disclosed["signer"]).toBe(stringField(signed.fields, 2));
  });

  it("a submission discloses EVERY inner message, decoded, not a count", () => {
    const built = buildTxPlan(
      {
        kind: "gov_submit",
        proposer: VOTER,
        policyAddress: GOV_POLICY,
        contractAddress: GOV_CONTRACT,
        templates: [{ id: "update_config", values: { aum_fee_bps: 25n } }],
        title: "Lower the AUM fee",
        summary: "Reduce aum_fee_bps from 50 to 25.",
        metadata: "",
      },
      govFee,
      govSigner,
    );
    const signed = signedAny(built);
    const disclosed = disclosureOf(built);
    expect(disclosed["@type"]).toBe(signed.typeUrl);
    expect(disclosed["group_policy_address"]).toBe(stringField(signed.fields, 1));
    expect(disclosed["proposers"]).toEqual([stringField(signed.fields, 2)]);
    expect(disclosed["title"]).toBe(stringField(signed.fields, 6));
    expect(disclosed["summary"]).toBe(stringField(signed.fields, 7));
    expect(disclosed["exec"]).toBe("EXEC_UNSPECIFIED");
    expect(signed.fields.some((f) => f.field === 5)).toBe(false);

    // The inner message, decoded on BOTH sides and compared byte-for-byte.
    const innerAnys = bytesFields(signed.fields, 4);
    expect(innerAnys).toHaveLength(1);
    const innerAny = readFields(innerAnys[0]!);
    const exec = readFields(bytesField(innerAny, 2)!);
    const disclosedMessages = disclosed["messages"] as Array<Record<string, unknown>>;
    expect(disclosedMessages).toHaveLength(1);
    expect(disclosedMessages[0]!["@type"]).toBe(stringField(innerAny, 1));
    expect(disclosedMessages[0]!["sender"]).toBe(stringField(exec, 1));
    expect(disclosedMessages[0]!["contract"]).toBe(stringField(exec, 2));
    expect(JSON.stringify(disclosedMessages[0]!["msg"])).toBe(
      new TextDecoder().decode(bytesField(exec, 3)!),
    );
    // No admin variant is payable, and the disclosure says so rather than
    // omitting the field.
    expect(disclosedMessages[0]!["funds"]).toEqual([]);
    expect(bytesFields(exec, 5)).toHaveLength(0);
  });

  it("the inner sender is the POLICY, not the proposer — as disclosed and as signed", () => {
    // x/group executes a proposal's messages AS the policy account, which is the
    // contract's admin. A disclosure showing the proposer here would describe a
    // message that could never execute.
    const built = buildTxPlan(
      {
        kind: "gov_submit",
        proposer: VOTER,
        policyAddress: GOV_POLICY,
        contractAddress: GOV_CONTRACT,
        templates: [{ id: "unpause_vault", values: {} }],
        title: "Unpause",
        summary: "Restore deposits and redemptions.",
        metadata: "",
      },
      govFee,
      govSigner,
    );
    const disclosed = disclosureOf(built);
    const message = (disclosed["messages"] as Array<Record<string, unknown>>)[0]!;
    expect(message["sender"]).toBe(GOV_POLICY);
    expect(message["sender"]).not.toBe(VOTER);
  });
});
