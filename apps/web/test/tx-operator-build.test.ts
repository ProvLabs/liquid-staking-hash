// Byte-golden operator-message gate (M6.4 §3 commit D; app-spec §14.2 stage 1).
//
// The same discipline as the vault messages: re-encode the CAPTURED devnet
// transactions from their proto-JSON and require sha256(TxRaw) to equal the
// chain's own tx id. For `MsgExecuteContract` this pins more than field
// numbers — it pins the exact BYTES of the inner execute payload, because any
// difference in key order, spacing, or optional-field handling changes the
// hash. That is what lets the relay's deep guard demand canonical form: the
// canonical form is provably the one the chain accepted.
//
// Fixtures: packages/fixtures/fixtures/operator/ (captured 2026-07-27, the
// §7 Q1 drill). PR 8.0 re-vets the corpus.

import { describe, expect, it } from "vitest";

import payCommissionFixture from "@nvhash/fixtures/operator/pay-commission";
import payTipFixture from "@nvhash/fixtures/operator/pay-tip";
import registerFixture from "@nvhash/fixtures/operator/register-participation";

import {
  ALLOWED_MSG_TYPE_URLS,
  buildTxPlan,
  decodeTxRaw,
  encodeAuthInfo,
  encodeIntentMsg,
  encodeTxBody,
  encodeTxRaw,
  FUNDED_VARIANTS,
  guardOperatorExecute,
  intentToProtoJson,
  MSG_EXECUTE_CONTRACT,
  MSG_SWAP_IN,
  MSG_SWAP_OUT,
  operatorInnerJson,
  OPERATOR_VARIANTS,
  txHash,
  type OperatorIntent,
  type OperatorVariant,
} from "~/tx/build";

interface ExecuteFixture {
  tx: {
    body: {
      messages: Array<{
        "@type": string;
        sender: string;
        contract: string;
        msg: Record<string, Record<string, string>>;
        funds: Array<{ denom: string; amount: string }>;
      }>;
      memo: string;
    };
    auth_info: {
      signer_infos: Array<{ public_key: { "@type": string; key: string }; sequence: string }>;
      fee: { amount: Array<{ denom: string; amount: string }>; gas_limit: string };
    };
    signatures: string[];
  };
  tx_response: { txhash: string };
}

function intentFromFixture(fixture: ExecuteFixture): OperatorIntent {
  const msg = fixture.tx.body.messages[0]!;
  const variant = Object.keys(msg.msg)[0] as OperatorVariant;
  const body = msg.msg[variant]!;
  const coin = msg.funds[0];
  return {
    kind: "operator",
    variant,
    sender: msg.sender,
    contractAddress: msg.contract,
    valoper: body["valoper"]!,
    claimantValoper: body["claimant_valoper"] ?? null,
    amount: coin === undefined ? 0n : BigInt(coin.amount),
    denom: coin?.denom ?? "nhash",
  };
}

function reencodedHash(fixture: ExecuteFixture): string {
  const signerInfo = fixture.tx.auth_info.signer_infos[0]!;
  const fee = fixture.tx.auth_info.fee;
  const bodyBytes = encodeTxBody([encodeIntentMsg(intentFromFixture(fixture))], fixture.tx.body.memo);
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
  return txHash(
    encodeTxRaw(
      bodyBytes,
      authInfoBytes,
      fixture.tx.signatures.map((s) => Uint8Array.from(Buffer.from(s, "base64"))),
    ),
  );
}

const FIXTURES: Array<[string, ExecuteFixture]> = [
  ["PayCommission (funded)", payCommissionFixture as unknown as ExecuteFixture],
  ["PayTip (funded)", payTipFixture as unknown as ExecuteFixture],
  ["RegisterParticipation (fundless)", registerFixture as unknown as ExecuteFixture],
];

describe("byte-golden: re-encoded operator txs hash to their chain tx ids", () => {
  for (const [label, fixture] of FIXTURES) {
    it(label, () => {
      expect(reencodedHash(fixture)).toBe(fixture.tx_response.txhash);
    });
  }

  it("the canonical inner payload equals the bytes the chain accepted", () => {
    // The hash goldens above already prove this transitively; asserting it
    // directly names WHY the relay may demand canonical form.
    for (const [label, fixture] of FIXTURES) {
      const intent = intentFromFixture(fixture);
      const onChain = JSON.stringify(fixture.tx.body.messages[0]!.msg);
      expect(operatorInnerJson(intent.variant, intent.valoper, intent.claimantValoper), label).toBe(
        onChain,
      );
    }
  });
});

describe("the allowlist and the variant set are closed", () => {
  it("the allowlist is exactly the two vault messages plus the guarded execute", () => {
    expect([...ALLOWED_MSG_TYPE_URLS].sort()).toEqual(
      [MSG_SWAP_IN, MSG_SWAP_OUT, MSG_EXECUTE_CONTRACT].sort(),
    );
  });

  it("the variant set is exactly the six operator actions — no admin or keeper", () => {
    expect([...OPERATOR_VARIANTS].sort()).toEqual(
      [
        "pay_commission",
        "pay_tip",
        "register_participation",
        "unregister_participation",
        "report_jailed_validator",
        "purge_jailed_validator",
      ].sort(),
    );
    // The set must not drift into anything that halts, reconfigures, or cranks.
    for (const forbidden of [
      "set_halted",
      "update_config",
      "pause_vault",
      "unpause_vault",
      "clear_pending_delegations",
      "run_epoch",
      "claim_rewards",
      "service_redemptions",
      "capture_uptime_signal",
    ]) {
      expect(OPERATOR_VARIANTS as readonly string[], forbidden).not.toContain(forbidden);
    }
  });

  it("only the two payment variants may carry funds", () => {
    expect([...FUNDED_VARIANTS].sort()).toEqual(["pay_commission", "pay_tip"]);
  });
});

describe("canonical payload shape", () => {
  it("omits claimant_valoper entirely when there is none (the proven devnet form)", () => {
    expect(operatorInnerJson("purge_jailed_validator", "tpvaloper1aaa", null)).toBe(
      '{"purge_jailed_validator":{"valoper":"tpvaloper1aaa"}}',
    );
  });

  it("includes claimant_valoper after valoper when supplied", () => {
    expect(operatorInnerJson("purge_jailed_validator", "tpvaloper1aaa", "tpvaloper1bbb")).toBe(
      '{"purge_jailed_validator":{"valoper":"tpvaloper1aaa","claimant_valoper":"tpvaloper1bbb"}}',
    );
  });

  it("ignores a claimant on a variant that has none (it cannot leak into the payload)", () => {
    expect(operatorInnerJson("pay_tip", "tpvaloper1aaa", "tpvaloper1bbb")).toBe(
      '{"pay_tip":{"valoper":"tpvaloper1aaa"}}',
    );
  });
});

describe("builder ↔ decoder round trip for operator messages", () => {
  const base: OperatorIntent = {
    kind: "operator",
    variant: "pay_commission",
    sender: "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0",
    contractAddress: "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8",
    valoper: "tpvaloper1l39wu7cht0zcycc5rkcd90sdd4ksjmxwjqvnjp",
    claimantValoper: null,
    amount: 1_500_000_000n,
    denom: "nhash",
  };
  const signer = {
    chainId: "chain-dev",
    accountNumber: 7n,
    sequence: 3n,
    pubkeyBase64: Buffer.alloc(33, 5).toString("base64"),
  };
  const fee = { gasLimit: 300_000n, amount: 400_000n, denom: "nhash" };

  it("decodeTxRaw recovers the sender, contract, payload and funds", () => {
    const plan = buildTxPlan(base, fee, signer);
    const decoded = decodeTxRaw(encodeTxRaw(plan.bodyBytes, plan.authInfoBytes, [new Uint8Array(64)]));
    expect(decoded.messages).toHaveLength(1);
    const msg = decoded.messages[0]!;
    expect(msg.typeUrl).toBe(MSG_EXECUTE_CONTRACT);
    expect(msg.owner).toBe(base.sender); // field 1 — the relay's session binding
    expect(msg.vaultAddress).toBe(base.contractAddress); // field 2 — the contract
    expect(new TextDecoder().decode(msg.execMsgBytes!)).toBe(
      '{"pay_commission":{"valoper":"tpvaloper1l39wu7cht0zcycc5rkcd90sdd4ksjmxwjqvnjp"}}',
    );
    expect(msg.execFunds).toEqual([{ denom: "nhash", amount: "1500000000" }]);
  });

  it("a fundless variant encodes NO funds field at all", () => {
    const plan = buildTxPlan({ ...base, variant: "unregister_participation", amount: 0n }, fee, signer);
    const decoded = decodeTxRaw(encodeTxRaw(plan.bodyBytes, plan.authInfoBytes, [new Uint8Array(64)]));
    expect(decoded.messages[0]!.execFunds).toEqual([]);
  });

  // THE ENCODER/GUARD AGREEMENT (2026-07-28 review). The builder must never
  // produce a message the relay guard refuses: a disagreement is only
  // discovered after the user has signed. This previously failed in the
  // zero-amount direction — a `pay_commission` at 0 encoded with no funds and
  // was then rejected at the relay as "a payment must attach exactly one coin".
  it("refuses to build a payment with a zero amount", () => {
    expect(() => buildTxPlan({ ...base, amount: 0n }, fee, signer)).toThrow(
      /requires a positive Uint128 amount/,
    );
  });

  it("refuses to build a payment above the Uint128 ceiling", () => {
    expect(() => buildTxPlan({ ...base, amount: 1n << 128n }, fee, signer)).toThrow(
      /requires a positive Uint128 amount/,
    );
  });

  it("refuses to attach funds to a fundless variant", () => {
    expect(() =>
      buildTxPlan({ ...base, variant: "report_jailed_validator", amount: 1n }, fee, signer),
    ).toThrow(/must not carry funds/);
  });

  it("everything the encoder DOES build passes the relay guard", () => {
    // The invariant stated as a property over the whole closed variant set,
    // so a new variant cannot land on one side of the pair only.
    for (const variant of OPERATOR_VARIANTS) {
      const amount = FUNDED_VARIANTS.has(variant) ? 1_500_000_000n : 0n;
      const plan = buildTxPlan({ ...base, variant, amount }, fee, signer);
      const decoded = decodeTxRaw(
        encodeTxRaw(plan.bodyBytes, plan.authInfoBytes, [new Uint8Array(64)]),
      );
      const verdict = guardOperatorExecute(decoded.messages[0]!, {
        contractAddress: base.contractAddress,
      });
      expect(verdict, `${variant} must round-trip through the guard`).toEqual({
        ok: true,
        variant,
      });
    }
  });
});

describe("disclosure JSON mirrors the encoded operator message", () => {
  it("shows the DECODED variant and its arguments, not an opaque blob", () => {
    const fixture = payCommissionFixture as unknown as ExecuteFixture;
    const msg = fixture.tx.body.messages[0]!;
    const json = intentToProtoJson(intentFromFixture(fixture));
    expect(json["@type"]).toBe(MSG_EXECUTE_CONTRACT);
    expect(json["sender"]).toBe(msg.sender);
    expect(json["contract"]).toBe(msg.contract);
    // The operator must see WHICH action and on WHICH validator before signing.
    expect(json["msg"]).toEqual(msg.msg);
    expect(json["funds"]).toEqual(msg.funds);
  });

  it("a fundless action discloses an empty funds list, not a fabricated coin", () => {
    const fixture = registerFixture as unknown as ExecuteFixture;
    expect(intentToProtoJson(intentFromFixture(fixture))["funds"]).toEqual([]);
  });
});
