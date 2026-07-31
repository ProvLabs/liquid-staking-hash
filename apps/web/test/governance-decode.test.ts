// Proposal-message decoding (app-spec §8.7, §12.1).
//
// WHAT THIS SUITE IS REALLY GUARDING. A member reads a summary and votes. A
// summary that is confidently WRONG is therefore the worst failure this page
// has, and invariant 2's own disproof line says an unknown-type test cannot find
// it: only a golden summary pinned against the producing system's field
// semantics can. So every known variant below is asserted against the exact
// English it produces, with the source of its meaning named in a comment —
// `contracts/src/msg.rs` for the program actions, the captured corpus for
// `MsgSend`.
//
// The second half of the suite is the closure property: every variant in the
// vocabulary `app/tx/build.ts` exports has a summary, and NO variant falls
// through to "unrecognized". A variant added there without a summary here fails
// the totality assertion rather than silently rendering as unknown.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  decodeMessage,
  summarizeMessage,
  MAX_MESSAGE_JSON_CHARS,
  MSG_EXECUTE_CONTRACT_TYPE_URL,
  MSG_SEND_TYPE_URL,
} from "~/governance/decode";
import { ADMIN_VARIANTS, KEEPER_VARIANTS, OPERATOR_VARIANTS } from "~/tx/build";

const CONTRACT = "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8";
const OTHER_CONTRACT = "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad";
const VALOPER = "tpvaloper1l39wu7cht0zcycc5rkcd90sdd4ksjmxwjqvnjp";
const en = "en" as const;

/** The corpus's own proposal messages — captured, not authored. */
function corpusMessages(): unknown[] {
  const path = new URL(
    "../../../packages/fixtures/fixtures/queries/group/proposals-by-group-policy.json",
    import.meta.url,
  );
  const sweep = JSON.parse(readFileSync(path, "utf8")) as {
    proposals: { messages: unknown[] }[];
  };
  return sweep.proposals.flatMap((p) => p.messages);
}

function execute(msg: unknown, contract = CONTRACT, funds: unknown[] = []) {
  return { "@type": MSG_EXECUTE_CONTRACT_TYPE_URL, sender: contract, contract, msg, funds };
}

describe("the exact payload rides on every message, always (§8.7 ordering)", () => {
  it("known, unknown and malformed messages all carry their JSON", () => {
    const cases: unknown[] = [
      corpusMessages()[0],
      execute({ pay_tip: { valoper: VALOPER } }),
      { "@type": "/cosmos.group.v1.MsgUpdateGroupMembers", updates: [] },
      { nonsense: true },
      "not an object at all",
    ];
    for (const message of cases) {
      const decoded = decodeMessage(message, CONTRACT);
      expect(decoded.json.length, JSON.stringify(message)).toBeGreaterThan(0);
      expect(decoded.jsonTruncated).toBe(false);
    }
  });

  it("an over-long payload is trimmed and SAYS SO", () => {
    // A proposal's messages are user-authored on a permissionless chain, so the
    // render is bounded — but a quietly shortened payload would break the very
    // promise the block exists to keep.
    const decoded = decodeMessage(
      { "@type": "/x.Unknown", blob: "a".repeat(MAX_MESSAGE_JSON_CHARS * 2) },
      CONTRACT,
    );
    expect(decoded.jsonTruncated).toBe(true);
    expect(decoded.json.length).toBe(MAX_MESSAGE_JSON_CHARS);
  });
});

describe("MsgSend — the one type the corpus pins", () => {
  it("decodes every captured proposal message and summarizes it in HASH", () => {
    const messages = corpusMessages();
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      const decoded = decodeMessage(message, CONTRACT);
      expect(decoded.kind, decoded.json).toBe("send");
      if (decoded.kind !== "send") throw new Error("unreachable");
      expect(decoded.typeUrl).toBe(MSG_SEND_TYPE_URL);
      expect(decoded.coins.length).toBeGreaterThan(0);
      // nhash is the program denom, so it displays as HASH; nothing else does.
      for (const coin of decoded.coins) {
        expect(coin.denom).toBe("nhash");
        expect(coin.hash).not.toBeNull();
      }
      expect(summarizeMessage(en, decoded)).toMatch(/^Send [\d.]+ HASH to tp1/);
    }
  });

  it("a non-program denom is shown VERBATIM, never converted", () => {
    // A fabricated exponent for an unknown denom would misstate the amount.
    const decoded = decodeMessage(
      {
        "@type": MSG_SEND_TYPE_URL,
        from_address: "tp1from",
        to_address: "tp1to",
        amount: [{ denom: "uusdc", amount: "1500000" }],
      },
      CONTRACT,
    );
    if (decoded.kind !== "send") throw new Error("unreachable");
    expect(decoded.coins[0]!.hash).toBeNull();
    expect(summarizeMessage(en, decoded)).toBe("Send 1500000 uusdc to tp1to");
  });

  it("a malformed coin makes the whole message unknown, not a partial summary", () => {
    for (const amount of [
      [{ denom: "nhash", amount: "1.5" }],
      [{ denom: "", amount: "1" }],
      "x",
      [{}],
    ]) {
      const decoded = decodeMessage(
        { "@type": MSG_SEND_TYPE_URL, from_address: "tp1a", to_address: "tp1b", amount },
        CONTRACT,
      );
      expect(decoded.kind, JSON.stringify(amount)).toBe("unknown");
      if (decoded.kind !== "unknown") throw new Error("unreachable");
      expect(decoded.reason).toBe("malformed");
    }
  });
});

// Golden summaries. Each expectation is pinned to the variant's own doc comment
// in `contracts/src/msg.rs` — the contract is what decides what the action does,
// and a summary derived from the decoder's own reading of itself would prove
// nothing (invariant 2's disproof).
describe("program actions — golden summaries against contracts/src/msg.rs", () => {
  const GOLDEN: Record<string, { msg: Record<string, unknown>; summary: string }> = {
    // "Anyone (nhash attached): pay program commission on behalf of an enrolled validator"
    pay_commission: {
      msg: { pay_commission: { valoper: VALOPER } },
      summary: `Pay program commission for ${VALOPER}`,
    },
    // "Anyone (nhash attached): pay a TIP for an enrolled validator"
    pay_tip: { msg: { pay_tip: { valoper: VALOPER } }, summary: `Pay a TIP for ${VALOPER}` },
    // "Validator-operator: enroll a validator in the program"
    register_participation: {
      msg: { register_participation: { valoper: VALOPER } },
      summary: `Enrol ${VALOPER} in the program`,
    },
    // "Operator or admin: withdraw a validator from the program"
    unregister_participation: {
      msg: { unregister_participation: { valoper: VALOPER } },
      summary: `Withdraw ${VALOPER} from the program`,
    },
    // "flag that a validator the program has stake on is jailed … Moves no funds"
    report_jailed_validator: {
      msg: { report_jailed_validator: { valoper: VALOPER } },
      summary: `Report ${VALOPER} as jailed`,
    },
    // "after the cooldown, move the program's stake off a STILL-jailed validator"
    purge_jailed_validator: {
      msg: { purge_jailed_validator: { valoper: VALOPER } },
      summary: `Move the program's stake off jailed ${VALOPER}`,
    },
    // "emergency stop / resume for the fund-moving permissionless cranks"
    set_halted: {
      msg: { set_halted: { halted: true } },
      summary: "Halt the program's fund-moving cranks",
    },
    // "update program configuration. Only supplied fields change" — so naming
    // the supplied fields is a fact about the message, and the VALUES' meaning
    // (a diff view) is deliberately not claimed here.
    update_config: {
      msg: { update_config: { aum_fee_bps: 25, commission_bps: 1000 } },
      summary: "Update program configuration: aum_fee_bps, commission_bps",
    },
    // "pause the managed vault (manual override / emergency stop)"
    pause_vault: {
      msg: { pause_vault: { reason: "incident" } },
      summary: "Pause the managed vault",
    },
    unpause_vault: { msg: { unpause_vault: {} }, summary: "Unpause the managed vault" },
    // "abort a stuck epoch continuation by dropping the persisted delegation targets"
    clear_pending_delegations: {
      msg: { clear_pending_delegations: {} },
      summary: "Abort a stuck epoch continuation",
    },
    run_epoch: { msg: { run_epoch: {} }, summary: "Run the epoch crank" },
    claim_rewards: { msg: { claim_rewards: {} }, summary: "Claim accrued staking rewards" },
    service_redemptions: {
      msg: { service_redemptions: {} },
      summary: "Service queued redemptions",
    },
    capture_uptime_signal: {
      msg: { capture_uptime_signal: {} },
      summary: "Capture the uptime signal",
    },
  };

  it("every variant in the shared vocabulary has a golden summary here", () => {
    // The totality gate. `OPERATOR_VARIANTS`, `ADMIN_VARIANTS` and
    // `KEEPER_VARIANTS` are the ONE vocabulary: a variant added
    // there is a variant this page must be able to describe, and this assertion
    // is what makes that a build failure instead of a silent "unrecognized".
    const vocabulary = [...OPERATOR_VARIANTS, ...ADMIN_VARIANTS, ...KEEPER_VARIANTS];
    expect(Object.keys(GOLDEN).sort()).toEqual([...vocabulary].sort());
  });

  it("each summarizes exactly as the contract describes the action", () => {
    for (const [variant, golden] of Object.entries(GOLDEN)) {
      const decoded = decodeMessage(execute(golden.msg), CONTRACT);
      expect(decoded.kind, variant).toBe("program-action");
      if (decoded.kind !== "program-action") throw new Error("unreachable");
      expect(decoded.variant).toBe(variant);
      expect(summarizeMessage(en, decoded), variant).toBe(golden.summary);
      // Never "unrecognized" for a variant the vocabulary carries.
      expect(summarizeMessage(en, decoded)).not.toMatch(/Unrecognized|not recognized/i);
    }
  });

  it("authority is carried, and the three sets stay disjoint", () => {
    const byVariant = new Map(
      Object.entries(GOLDEN).map(([variant, golden]) => {
        const decoded = decodeMessage(execute(golden.msg), CONTRACT);
        if (decoded.kind !== "program-action") throw new Error(`not decoded: ${variant}`);
        return [variant, decoded.authority] as const;
      }),
    );
    for (const v of OPERATOR_VARIANTS) expect(byVariant.get(v), v).toBe("operator");
    for (const v of ADMIN_VARIANTS) expect(byVariant.get(v), v).toBe("admin");
    for (const v of KEEPER_VARIANTS) expect(byVariant.get(v), v).toBe("keeper");
  });

  it("set_halted's meaning INVERTS on its field, and both are said plainly", () => {
    // One summary covering both would be an invented meaning: halting and
    // resuming the program's fund-moving cranks are opposite acts.
    const on = decodeMessage(execute({ set_halted: { halted: true } }), CONTRACT);
    const off = decodeMessage(execute({ set_halted: { halted: false } }), CONTRACT);
    expect(summarizeMessage(en, on)).toBe("Halt the program's fund-moving cranks");
    expect(summarizeMessage(en, off)).toBe("Resume the program's fund-moving cranks");
    // A missing/ill-typed field must not silently pick one of the two.
    const unknownState = decodeMessage(execute({ set_halted: { halted: "yes" } }), CONTRACT);
    expect(summarizeMessage(en, unknownState)).toBe("Change the program's crank halt state");
  });

  it("attached funds are carried — a payment proposal without its amount is a lie", () => {
    const decoded = decodeMessage(
      execute({ pay_commission: { valoper: VALOPER } }, CONTRACT, [
        { denom: "nhash", amount: "1500000000" },
      ]),
      CONTRACT,
    );
    if (decoded.kind !== "program-action") throw new Error("unreachable");
    expect(decoded.funds).toEqual([{ denom: "nhash", amount: "1500000000", hash: "1.5000" }]);
  });

  it("reads the execute payload in either wire encoding", () => {
    // wasmd marshals `msg` as raw JSON; the plain proto-JSON encoding of a bytes
    // field is base64. No fixture pins which one a proposal carries (§3.4 R3).
    const raw = decodeMessage(execute({ run_epoch: {} }), CONTRACT);
    const encoded = decodeMessage(
      execute(Buffer.from(JSON.stringify({ run_epoch: {} }), "utf8").toString("base64")),
      CONTRACT,
    );
    expect(raw.kind).toBe("program-action");
    expect(encoded.kind).toBe("program-action");
  });
});

describe("unknown is a first-class outcome, with a distinct reason each time", () => {
  it("a type URL outside the union is unknown-type, never guessed at", () => {
    // x/group's own messages are the case that matters: they are plausible in a
    // governance proposal and no fixture pins their shape on this build, so an
    // arm written from proto knowledge is exactly the confident-wrong summary.
    for (const typeUrl of [
      "/cosmos.group.v1.MsgUpdateGroupMembers",
      "/cosmos.group.v1.MsgUpdateGroupPolicyDecisionPolicy",
      "/cosmos.gov.v1.MsgSubmitProposal",
      "/ibc.applications.transfer.v1.MsgTransfer",
    ]) {
      const decoded = decodeMessage({ "@type": typeUrl, whatever: 1 }, CONTRACT);
      expect(decoded.kind, typeUrl).toBe("unknown");
      if (decoded.kind !== "unknown") throw new Error("unreachable");
      expect(decoded.reason).toBe("unknown-type");
      expect(decoded.typeUrl).toBe(typeUrl);
      expect(summarizeMessage(en, decoded)).toMatch(/^Unrecognized message type/);
    }
  });

  it("a call to ANOTHER contract is not described in this program's words", () => {
    const decoded = decodeMessage(
      execute({ pay_commission: { valoper: VALOPER } }, OTHER_CONTRACT),
      CONTRACT,
    );
    expect(decoded.kind).toBe("unknown");
    if (decoded.kind !== "unknown") throw new Error("unreachable");
    expect(decoded.reason).toBe("other-contract");
    // The give-away that this matters: the payload LOOKS like one of ours.
    expect(decoded.json).toContain("pay_commission");
  });

  it("an unrecognized or multi-key variant on OUR contract is unknown-variant", () => {
    for (const msg of [
      { future_action: {} },
      { pay_tip: { valoper: VALOPER }, set_halted: { halted: true } },
    ]) {
      const decoded = decodeMessage(execute(msg), CONTRACT);
      expect(decoded.kind, JSON.stringify(msg)).toBe("unknown");
      if (decoded.kind !== "unknown") throw new Error("unreachable");
      expect(decoded.reason).toBe("unknown-variant");
    }
  });

  it("malformed input degrades rather than throwing", () => {
    for (const message of [
      null,
      42,
      "string",
      [],
      {},
      { "@type": 7 },
      { "@type": MSG_EXECUTE_CONTRACT_TYPE_URL },
      { "@type": MSG_EXECUTE_CONTRACT_TYPE_URL, contract: CONTRACT, msg: "!!not base64!!" },
      { "@type": MSG_EXECUTE_CONTRACT_TYPE_URL, contract: CONTRACT, msg: { pay_tip: "scalar" } },
    ]) {
      const decoded = decodeMessage(message, CONTRACT);
      expect(decoded.kind, JSON.stringify(message)).toBe("unknown");
      if (decoded.kind !== "unknown") throw new Error("unreachable");
      expect(["malformed", "unknown-variant"]).toContain(decoded.reason);
      expect(summarizeMessage(en, decoded).length).toBeGreaterThan(0);
    }
  });
});
