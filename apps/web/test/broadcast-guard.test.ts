// Broadcast-relay guard gate (plan 5.2 §4.9; §12.3 amendment): the relay
// accepts ONLY a fully-signed tx whose sole signer is the session address,
// whose messages are the closed vault set against the configured vault,
// size-capped and rate-limited. Every guard has its case here — wrong
// signer → 403, non-allowlisted msg → 400, oversize → 413, malformed → 400,
// rate → 429. (The session requirement's 401 is covered by the
// session-scope suite; the route wires requireSession.)

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { beforeEach, describe, expect, it } from "vitest";

import { pubkeyToBech32 } from "~/lib/adr36-verify.server";
import { loadConfig } from "~/config/config.server";
import {
  buildTxPlan,
  encodeAuthInfo,
  encodeTxBody,
  encodeTxRaw,
  templateExecuteAny,
  ADMIN_VARIANTS,
  ALLOWED_MSG_TYPE_URLS,
  GOVERNANCE_VOTE_OPTIONS,
  KEEPER_VARIANTS,
  MSG_EXECUTE_CONTRACT,
  MSG_GOV_EXEC,
  MSG_GOV_SUBMIT_PROPOSAL,
  MSG_GOV_VOTE,
  OPERATOR_VARIANTS,
  type GovSubmitProposalIntent,
  type OperatorIntent,
  type ProposalTemplateInstance,
  type TxIntent,
} from "~/tx/build";
import { MAX_PROPOSAL_MESSAGES, MAX_PROPOSAL_METADATA_LEN } from "@nvhash/api-types";
import { ProtoWriter } from "~/tx/proto";
import {
  guardSignedTx,
  RATE_LIMIT_PER_MINUTE,
  resetRelayRateLimitForTests,
  SIZE_CAP_BYTES,
} from "~/tx/broadcast.server";

const config = loadConfig({
  APP_ENV: "development",
  CHAIN_ID: "chain-dev",
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8",
  VAULT_ADDRESS: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad",
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: "chain-dev",
  API_URL: "http://api.mock:8787",
} as NodeJS.ProcessEnv);

const PRIV = sha256(new TextEncoder().encode("nvhash-broadcast-guard-key"));
const PUB = secp256k1.getPublicKey(PRIV, true);
const SESSION_ADDRESS = pubkeyToBech32(PUB, "tp");
const OTHER_PRIV = sha256(new TextEncoder().encode("someone-else"));
const OTHER_PUB = secp256k1.getPublicKey(OTHER_PRIV, true);

beforeEach(() => resetRelayRateLimitForTests());

/**
 * A clock that jumps a full rate window on every call.
 *
 * The matrices below submit far more than `RATE_LIMIT_PER_MINUTE` attempts, and
 * a 429 would MASK the 400 under test — a rejection matrix that passes for the
 * wrong reason proves nothing about the guard it names.
 */
let sharedClock = 1_750_000_000_000;
function freshClock(): number {
  sharedClock += 61_000;
  return sharedClock;
}

/** The session signer's `auth_info`, for the hand-encoded bodies below. */
function authInfoBytes(pubkey: Uint8Array = PUB): Uint8Array {
  return encodeAuthInfo(
    {
      chainId: config.chainId,
      accountNumber: 1n,
      sequence: 0n,
      pubkeyBase64: Buffer.from(pubkey).toString("base64"),
    },
    { gasLimit: 1n, amount: 1n, denom: "nhash" },
  );
}

function signedTx(overrides?: {
  owner?: string;
  vault?: string;
  pubkey?: Uint8Array;
  signatures?: number;
}): Uint8Array {
  const intent: TxIntent = {
    kind: "swap_in",
    owner: overrides?.owner ?? SESSION_ADDRESS,
    vaultAddress: overrides?.vault ?? config.vaultAddress,
    amount: 1_000_000_000n,
    denom: "nhash",
  };
  const plan = buildTxPlan(
    intent,
    { gasLimit: 200_000n, amount: 381_000_000n, denom: "nhash" },
    {
      chainId: config.chainId,
      accountNumber: 1n,
      sequence: 0n,
      pubkeyBase64: Buffer.from(overrides?.pubkey ?? PUB).toString("base64"),
    },
  );
  const sigs = Array.from({ length: overrides?.signatures ?? 1 }, () => new Uint8Array(64));
  return encodeTxRaw(plan.bodyBytes, plan.authInfoBytes, sigs);
}

describe("relay guards (each an enforced mechanism)", () => {
  it("accepts the session's own vault tx", async () => {
    expect(await guardSignedTx(config, SESSION_ADDRESS, signedTx())).toEqual({ ok: true });
  });

  it("SIGNER pubkey not deriving the session address → 403", async () => {
    const verdict = await guardSignedTx(config, SESSION_ADDRESS, signedTx({ pubkey: OTHER_PUB }));
    expect(verdict).toMatchObject({ ok: false, status: 403 });
  });

  it("message owner differing from the session address → 403", async () => {
    const verdict = await guardSignedTx(
      config,
      SESSION_ADDRESS,
      signedTx({ owner: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad" }),
    );
    expect(verdict).toMatchObject({ ok: false, status: 403 });
  });

  it("non-allowlisted message type → 400", async () => {
    // Hand-encode a bank MsgSend Any inside a TxBody with our signer.
    const msgSend = new ProtoWriter()
      .string(1, SESSION_ADDRESS)
      .string(2, SESSION_ADDRESS)
      .finish();
    const anyMsg = new ProtoWriter()
      .string(1, "/cosmos.bank.v1beta1.MsgSend")
      .bytes(2, msgSend)
      .finish();
    const body = new ProtoWriter().message(1, anyMsg, true).finish();
    const plan = buildTxPlan(
      {
        kind: "swap_in",
        owner: SESSION_ADDRESS,
        vaultAddress: config.vaultAddress,
        amount: 1n,
        denom: "nhash",
      },
      { gasLimit: 1n, amount: 1n, denom: "nhash" },
      {
        chainId: config.chainId,
        accountNumber: 1n,
        sequence: 0n,
        pubkeyBase64: Buffer.from(PUB).toString("base64"),
      },
    );
    const tx = encodeTxRaw(body, plan.authInfoBytes, [new Uint8Array(64)]);
    expect(await guardSignedTx(config, SESSION_ADDRESS, tx)).toMatchObject({ ok: false, status: 400 });
  });

  // ── The §12.3 amendment, asserted on the CONSTANT ─────────────────────
  //
  // Through PR 7.1 this suite held the opposite assertion — "the allowlist
  // carries no x/group type URL" — precisely so that admitting one would be a
  // line someone had to delete. THIS PR is that deliberate design-review event,
  // and the replacement is not weaker: it pins the admitted set to EXACTLY the
  // three named types, so a fourth is still an edit to this line.
  it("the allowlist admits EXACTLY three x/group types and no others", () => {
    const group = ALLOWED_MSG_TYPE_URLS.filter((url) => url.startsWith("/cosmos.group."));
    expect([...group].sort()).toEqual(
      [MSG_GOV_VOTE, MSG_GOV_EXEC, MSG_GOV_SUBMIT_PROPOSAL].sort(),
    );
    // …and the M6.4 entries are untouched by the extension.
    expect(ALLOWED_MSG_TYPE_URLS).toContain(MSG_EXECUTE_CONTRACT);
    expect(ALLOWED_MSG_TYPE_URLS).toHaveLength(6);
  });

  it("every OTHER cosmos.group.v1 message type → 400", async () => {
    // The types that reach the same authority by a different route. Naming them
    // individually rather than relying on "not in the list" is the point:
    // `MsgUpdateGroupMembers` changes WHO GOVERNS, and `MsgExec` under authz is
    // a different module's wrapper around the same call.
    for (const typeUrl of [
      "/cosmos.group.v1.MsgUpdateGroupMembers",
      "/cosmos.group.v1.MsgUpdateGroupPolicyDecisionPolicy",
      "/cosmos.group.v1.MsgUpdateGroupPolicyAdmin",
      "/cosmos.group.v1.MsgUpdateGroupAdmin",
      "/cosmos.group.v1.MsgWithdrawProposal",
      "/cosmos.group.v1.MsgLeaveGroup",
      "/cosmos.group.v1.MsgCreateGroup",
      "/cosmos.authz.v1beta1.MsgExec",
    ]) {
      const inner = new ProtoWriter().string(1, SESSION_ADDRESS).string(2, SESSION_ADDRESS).finish();
      const anyMsg = new ProtoWriter().string(1, typeUrl).bytes(2, inner).finish();
      const body = new ProtoWriter().message(1, anyMsg, true).finish();
      const tx = encodeTxRaw(body, authInfoBytes(), [new Uint8Array(64)]);
      expect(
        await guardSignedTx(config, SESSION_ADDRESS, tx, { nowMs: freshClock() }),
        typeUrl,
      ).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("unexpected vault address → 400", async () => {
    const verdict = await guardSignedTx(
      config,
      SESSION_ADDRESS,
      signedTx({ vault: "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0" }),
    );
    expect(verdict).toMatchObject({ ok: false, status: 400 });
  });

  it("oversize → 413", async () => {
    const verdict = await guardSignedTx(config, SESSION_ADDRESS, new Uint8Array(SIZE_CAP_BYTES + 1));
    expect(verdict).toMatchObject({ ok: false, status: 413 });
  });

  it("malformed bytes → 400", async () => {
    expect(await guardSignedTx(config, SESSION_ADDRESS, new Uint8Array([0xff, 0x01, 0x02]))).toMatchObject(
      { ok: false, status: 400 },
    );
  });

  it("multiple signatures → 400 (sole-signer rule)", async () => {
    const verdict = await guardSignedTx(config, SESSION_ADDRESS, signedTx({ signatures: 2 }));
    expect(verdict).toMatchObject({ ok: false, status: 400 });
  });

  it("empty TxBody (no messages) → 400", async () => {
    const plan = buildTxPlan(
      {
        kind: "swap_in",
        owner: SESSION_ADDRESS,
        vaultAddress: config.vaultAddress,
        amount: 1n,
        denom: "nhash",
      },
      { gasLimit: 1n, amount: 1n, denom: "nhash" },
      {
        chainId: config.chainId,
        accountNumber: 1n,
        sequence: 0n,
        pubkeyBase64: Buffer.from(PUB).toString("base64"),
      },
    );
    const emptyBody = encodeTxBody([]);
    const tx = encodeTxRaw(emptyBody, plan.authInfoBytes, [new Uint8Array(64)]);
    expect(await guardSignedTx(config, SESSION_ADDRESS, tx)).toMatchObject({ ok: false, status: 400 });
  });

  it("rate limit: request N+1 in a minute → 429; a new window admits again", async () => {
    const nowMs = 1_750_000_000_000;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i += 1) {
      expect(await guardSignedTx(config, SESSION_ADDRESS, signedTx(), { nowMs: nowMs + i })).toEqual({ ok: true });
    }
    expect(await guardSignedTx(config, SESSION_ADDRESS, signedTx(), { nowMs: nowMs + 10 })).toMatchObject({
      ok: false,
      status: 429,
    });
    expect(await guardSignedTx(config, SESSION_ADDRESS, signedTx(), { nowMs: nowMs + 61_000 })).toEqual({ ok: true });
  });
});

// ── M6.4 §2.5: the operator-execute DEEP guard ───────────────────────────
//
// `MsgExecuteContract` is in the allowlist, so on the first level this type
// URL is "allowed". Everything below is an attempt to reach the chain with it
// anyway — another contract, an admin variant, a smuggled second key, funds on
// a fundless action, a non-canonical encoding of an allowed variant. Each must
// be refused. This matrix IS the reason the allowlist entry is safe; the plan
// (§8) makes the flows conditional on it passing.

/** Build a signed tx carrying ONE MsgExecuteContract with arbitrary bytes,
 * so the matrix can submit payloads the builder would never produce. */
function signedExecuteTx(
  execValue: Uint8Array,
  overrides?: { pubkey?: Uint8Array; typeUrl?: string },
): Uint8Array {
  const anyMsg = new ProtoWriter()
    .string(1, overrides?.typeUrl ?? MSG_EXECUTE_CONTRACT)
    .bytes(2, execValue)
    .finish();
  const body = new ProtoWriter().message(1, anyMsg, true).finish();
  const plan = buildTxPlan(
    {
      kind: "swap_in",
      owner: SESSION_ADDRESS,
      vaultAddress: config.vaultAddress,
      amount: 1n,
      denom: "nhash",
    },
    { gasLimit: 1n, amount: 1n, denom: "nhash" },
    {
      chainId: config.chainId,
      accountNumber: 1n,
      sequence: 0n,
      pubkeyBase64: Buffer.from(overrides?.pubkey ?? PUB).toString("base64"),
    },
  );
  return encodeTxRaw(body, plan.authInfoBytes, [new Uint8Array(64)]);
}

/** Hand-encode MsgExecuteContract with a RAW inner payload (bypassing the
 * canonical builder), so malformed/hostile payloads can be submitted. */
function rawExecute(opts: {
  sender?: string;
  contract?: string;
  msg: string;
  funds?: { denom: string; amount: string }[];
}): Uint8Array {
  const writer = new ProtoWriter()
    .string(1, opts.sender ?? SESSION_ADDRESS)
    .string(2, opts.contract ?? config.contractAddress)
    .bytes(3, new TextEncoder().encode(opts.msg));
  for (const coin of opts.funds ?? []) {
    writer.message(
      5,
      new ProtoWriter().string(1, coin.denom).string(2, coin.amount).finish(),
      true,
    );
  }
  return writer.finish();
}

const VALOPER = "tpvaloper1l39wu7cht0zcycc5rkcd90sdd4ksjmxwjqvnjp";
const OTHER_VALOPER = "tpvaloper1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

/** A legitimately-built operator tx (the positive control). */
function operatorTx(overrides: Partial<OperatorIntent> = {}): Uint8Array {
  const intent: OperatorIntent = {
    kind: "operator",
    variant: "pay_commission",
    sender: SESSION_ADDRESS,
    contractAddress: config.contractAddress,
    valoper: VALOPER,
    claimantValoper: null,
    amount: 1_500_000_000n,
    denom: "nhash",
    ...overrides,
  };
  const plan = buildTxPlan(
    intent,
    { gasLimit: 300_000n, amount: 400_000n, denom: "nhash" },
    {
      chainId: config.chainId,
      accountNumber: 1n,
      sequence: 0n,
      pubkeyBase64: Buffer.from(PUB).toString("base64"),
    },
  );
  return encodeTxRaw(plan.bodyBytes, plan.authInfoBytes, [new Uint8Array(64)]);
}

describe("operator execute — the six allowed variants are accepted", () => {
  it("accepts each funded payment variant", async () => {
    for (const variant of ["pay_commission", "pay_tip"] as const) {
      expect(await guardSignedTx(config, SESSION_ADDRESS, operatorTx({ variant })), variant).toEqual({
        ok: true,
      });
    }
  });

  it("accepts each fundless variant with no funds attached", async () => {
    for (const variant of [
      "register_participation",
      "unregister_participation",
      "report_jailed_validator",
      "purge_jailed_validator",
    ] as const) {
      expect(
        await guardSignedTx(config, SESSION_ADDRESS, operatorTx({ variant, amount: 0n })),
        variant,
      ).toEqual({ ok: true });
    }
  });

  it("accepts a purge carrying an optional claimant valoper", async () => {
    expect(
      await guardSignedTx(
        config,
        SESSION_ADDRESS,
        operatorTx({
          variant: "purge_jailed_validator",
          amount: 0n,
          claimantValoper: OTHER_VALOPER,
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("still binds the sender to the session address (403, like a swap owner)", async () => {
    const tx = operatorTx({ sender: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad" });
    expect(await guardSignedTx(config, SESSION_ADDRESS, tx)).toMatchObject({ ok: false, status: 403 });
  });
});

describe("operator execute — the rejection matrix (§2.5)", () => {
  // Each case gets its own rate-limit window: these loops submit far more than
  // RATE_LIMIT_PER_MINUTE attempts, and a 429 would mask the 400 under test.
  let clock = 1_750_000_000_000;
  const reject = async (tx: Uint8Array, label: string) => {
    clock += 61_000;
    expect(await guardSignedTx(config, SESSION_ADDRESS, tx, { nowMs: clock }), label).toMatchObject({
      ok: false,
      status: 400,
    });
  };

  it("a DIFFERENT contract address → 400 (the relay is not a general caller)", async () => {
    await reject(
      signedExecuteTx(
        rawExecute({
          contract: "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0",
          msg: `{"pay_commission":{"valoper":"${VALOPER}"}}`,
          funds: [{ denom: "nhash", amount: "1" }],
        }),
      ),
      "other contract",
    );
  });

  // The variants that halt the program, rewrite its config, pause the vault, or
  // drive the cranks. None is in the relay's set; each must be refused. The
  // bodies are a TOTAL map over `ADMIN_VARIANTS ∪ KEEPER_VARIANTS` (M7.2 §3.4
  // R4), so a variant added to either list without a case here is a type error
  // rather than a silently unrejected message — before this the matrix was
  // string literals that could drift from the vocabulary it was proving closed.
  const REJECTED_VARIANT_BODIES = {
    set_halted: `{"set_halted":{"halted":true}}`,
    update_config: `{"update_config":{"aum_fee_bps":9999}}`,
    pause_vault: `{"pause_vault":{"reason":"x"}}`,
    unpause_vault: `{"unpause_vault":{}}`,
    clear_pending_delegations: `{"clear_pending_delegations":{}}`,
    run_epoch: `{"run_epoch":{}}`,
    claim_rewards: `{"claim_rewards":{}}`,
    service_redemptions: `{"service_redemptions":{}}`,
    capture_uptime_signal: `{"capture_uptime_signal":{}}`,
  } as const satisfies Record<
    (typeof ADMIN_VARIANTS)[number] | (typeof KEEPER_VARIANTS)[number],
    string
  >;

  it("every ADMIN / KEEPER variant → 400", async () => {
    for (const variant of [...ADMIN_VARIANTS, ...KEEPER_VARIANTS]) {
      const msg = REJECTED_VARIANT_BODIES[variant];
      await reject(signedExecuteTx(rawExecute({ msg })), msg);
    }
  });

  it("the admin/keeper vocabulary is disjoint from the relay's operator set", async () => {
    // The lists exist so the decoder and the composer share one vocabulary; an
    // overlap would mean naming an action twice with different authority.
    const operators = new Set<string>(OPERATOR_VARIANTS);
    for (const variant of [...ADMIN_VARIANTS, ...KEEPER_VARIANTS]) {
      expect(operators.has(variant)).toBe(false);
    }
  });

  it("a multi-key inner payload → 400 (an allowed variant beside a forbidden one)", async () => {
    await reject(
      signedExecuteTx(
        rawExecute({
          msg: `{"pay_tip":{"valoper":"${VALOPER}"},"set_halted":{"halted":true}}`,
        }),
      ),
      "two keys",
    );
  });

  it("an extra field inside an allowed variant → 400", async () => {
    await reject(
      signedExecuteTx(
        rawExecute({ msg: `{"register_participation":{"valoper":"${VALOPER}","admin":true}}` }),
      ),
      "extra field",
    );
  });

  it("a claimant on a variant that has no claimant → 400", async () => {
    await reject(
      signedExecuteTx(
        rawExecute({
          msg: `{"report_jailed_validator":{"valoper":"${VALOPER}","claimant_valoper":"${OTHER_VALOPER}"}}`,
        }),
      ),
      "claimant on report",
    );
  });

  it("an explicit claimant_valoper: null → 400 (one accepted encoding only)", async () => {
    // There is exactly ONE byte sequence per (variant, arguments): the
    // canonical builder omits a null claimant entirely, so spelling it out
    // explicitly is a different encoding of the same intent and the
    // canonical-bytes check refuses it. The body-shape check deliberately
    // tolerates the null — condition 5 is what closes it, and this pins that
    // division of labour so a future edit to either half cannot open a second
    // accepted encoding unnoticed (2026-07-28 review).
    await reject(
      signedExecuteTx(
        rawExecute({
          msg: `{"purge_jailed_validator":{"valoper":"${VALOPER}","claimant_valoper":null}}`,
        }),
      ),
      "explicit null claimant",
    );
  });

  it("a valoper that is not a valoper → 400", async () => {
    for (const bad of [
      SESSION_ADDRESS, // an ACCOUNT address where a valoper is required
      "not-bech32",
      "tpvaloper1UPPER",
      "",
    ]) {
      await reject(
        signedExecuteTx(rawExecute({ msg: `{"unregister_participation":{"valoper":"${bad}"}}` })),
        `valoper=${bad}`,
      );
    }
  });

  it("FUNDS on a fundless variant → 400 (funds smuggling)", async () => {
    for (const variant of [
      "register_participation",
      "unregister_participation",
      "report_jailed_validator",
      "purge_jailed_validator",
    ]) {
      await reject(
        signedExecuteTx(
          rawExecute({
            msg: `{"${variant}":{"valoper":"${VALOPER}"}}`,
            funds: [{ denom: "nhash", amount: "1000" }],
          }),
        ),
        variant,
      );
    }
  });

  it("a payment with the wrong denom, zero, or no coin → 400", async () => {
    const cases: { label: string; funds: { denom: string; amount: string }[] }[] = [
      { label: "wrong denom", funds: [{ denom: "uatom", amount: "1000" }] },
      { label: "zero amount", funds: [{ denom: "nhash", amount: "0" }] },
      { label: "no funds", funds: [] },
      {
        label: "two coins",
        funds: [
          { denom: "nhash", amount: "1" },
          { denom: "nhash", amount: "2" },
        ],
      },
      { label: "non-canonical amount", funds: [{ denom: "nhash", amount: "01" }] },
      { label: "fractional amount", funds: [{ denom: "nhash", amount: "1.5" }] },
      { label: "negative amount", funds: [{ denom: "nhash", amount: "-1" }] },
    ];
    for (const { label, funds } of cases) {
      await reject(
        signedExecuteTx(rawExecute({ msg: `{"pay_commission":{"valoper":"${VALOPER}"}}`, funds })),
        label,
      );
    }
  });

  it("a NON-CANONICAL encoding of an otherwise-valid variant → 400", async () => {
    // Each of these parses to a payload the structural checks would accept.
    // Only the canonical-bytes check refuses them — which is what keeps the
    // guard from being a parser arms race against whatever the chain's
    // deserializer does with the same bytes.
    const funds = [{ denom: "nhash", amount: "1" }];
    for (const msg of [
      `{ "pay_commission" : { "valoper" : "${VALOPER}" } }`, // whitespace
      `{"pay_commission":{"valoper":"${VALOPER}"}}\n`, // trailing newline
      `{"\\u0070ay_commission":{"valoper":"${VALOPER}"}}`, // escaped variant name
      `{"pay_commission":{"valoper":"${VALOPER}","valoper":"${VALOPER}"}}`, // duplicate key
    ]) {
      await reject(signedExecuteTx(rawExecute({ msg, funds })), msg);
    }
  });

  it("a payload that is not a JSON object → 400", async () => {
    for (const msg of [`"pay_commission"`, `["pay_commission"]`, `null`, `42`, `not json`, ``]) {
      await reject(signedExecuteTx(rawExecute({ msg, funds: [] })), JSON.stringify(msg));
    }
  });

  it("an execute with NO inner payload at all → 400", async () => {
    const value = new ProtoWriter()
      .string(1, SESSION_ADDRESS)
      .string(2, config.contractAddress)
      .finish();
    await reject(signedExecuteTx(value), "no msg field");
  });

  it("a SECOND proto payload field → 400 (no last-wins ambiguity at the wire level)", async () => {
    // Two `msg` fields: a decoder that took the first (or the last) could
    // validate one payload while the chain executes the other. The decode
    // refuses the ambiguity outright rather than picking a winner.
    const value = new ProtoWriter()
      .string(1, SESSION_ADDRESS)
      .string(2, config.contractAddress)
      .bytes(3, new TextEncoder().encode(`{"pay_tip":{"valoper":"${VALOPER}"}}`))
      .bytes(3, new TextEncoder().encode(`{"set_halted":{"halted":true}}`))
      .finish();
    await reject(signedExecuteTx(value), "duplicate msg field");
  });

  it("a payload that is not valid UTF-8 → 400", async () => {
    const value = new ProtoWriter()
      .string(1, SESSION_ADDRESS)
      .string(2, config.contractAddress)
      .bytes(3, Uint8Array.from([0xff, 0xfe, 0x7b, 0x7d]))
      .finish();
    await reject(signedExecuteTx(value), "invalid utf-8");
  });

  it("a contract call disguised under an unknown type URL → 400 (first level)", async () => {
    await reject(
      signedExecuteTx(rawExecute({ msg: `{"pay_commission":{"valoper":"${VALOPER}"}}` }), {
        typeUrl: "/cosmwasm.wasm.v1.MsgMigrateContract",
      }),
      "migrate",
    );
  });

  it("a valid operator msg BESIDE a forbidden one in the same tx → 400", async () => {
    // Per-message enforcement, not first-message enforcement.
    const good = new ProtoWriter()
      .string(1, MSG_EXECUTE_CONTRACT)
      .bytes(2, rawExecute({ msg: `{"pay_tip":{"valoper":"${VALOPER}"}}`, funds: [{ denom: "nhash", amount: "5" }] }))
      .finish();
    const bad = new ProtoWriter()
      .string(1, MSG_EXECUTE_CONTRACT)
      .bytes(2, rawExecute({ msg: `{"set_halted":{"halted":true}}` }))
      .finish();
    const body = new ProtoWriter().message(1, good, true).message(1, bad, true).finish();
    const plan = buildTxPlan(
      {
        kind: "swap_in",
        owner: SESSION_ADDRESS,
        vaultAddress: config.vaultAddress,
        amount: 1n,
        denom: "nhash",
      },
      { gasLimit: 1n, amount: 1n, denom: "nhash" },
      {
        chainId: config.chainId,
        accountNumber: 1n,
        sequence: 0n,
        pubkeyBase64: Buffer.from(PUB).toString("base64"),
      },
    );
    await reject(encodeTxRaw(body, plan.authInfoBytes, [new Uint8Array(64)]), "mixed batch");
  });
});

// ── M7.3–7.4 §2.2: the GOVERNANCE guards ─────────────────────────────────
//
// The three `cosmos.group.v1` types are on the allowlist, so on the first level
// they are "allowed". Everything below is an attempt to reach the chain with
// one anyway — a vote for someone else, a vote that also executes, a proposal
// for a policy nobody discovered, a proposal carrying a message outside the
// template set, a template with one field mutated after encoding. Each must be
// refused. THIS MATRIX IS THE REASON THE THREE ALLOWLIST ENTRIES ARE SAFE, and
// the plan (§8) makes the flows conditional on it passing.
//
// The policy set is INJECTED rather than read: condition 3 asks the live chain
// which policies the program has, and a matrix whose verdicts depended on a
// network read would be proving something about the network.

const POLICY = "tp1qgvqctd47dqe9ryqkzc0zpu3wkqjr3sndkldpwfjfcqz0f4tqzsq7wshjm";
const OTHER_POLICY = "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0";

/** Guard deps for a governance case: a discovered policy set and a fresh
 * rate-limit window. `resolvePolicies` stands in for the live sweep. */
const govDeps = (policies: readonly string[] = [POLICY]) => ({
  nowMs: freshClock(),
  resolvePolicies: async () => policies,
});

const SIGNER_CONTEXT = {
  chainId: config.chainId,
  accountNumber: 1n,
  sequence: 0n,
  pubkeyBase64: Buffer.from(PUB).toString("base64"),
};
const FEE = { gasLimit: 1n, amount: 1n, denom: "nhash" };

/** A legitimately-BUILT governance tx (the positive control). */
function govTx(intent: TxIntent): Uint8Array {
  const plan = buildTxPlan(intent, FEE, SIGNER_CONTEXT);
  return encodeTxRaw(plan.bodyBytes, plan.authInfoBytes, [new Uint8Array(64)]);
}

/** A hand-encoded governance message, so the matrix can submit payloads the
 * builder would never produce. */
function signedGovTx(typeUrl: string, value: Uint8Array, pubkey: Uint8Array = PUB): Uint8Array {
  const anyMsg = new ProtoWriter().string(1, typeUrl).bytes(2, value).finish();
  const body = new ProtoWriter().message(1, anyMsg, true).finish();
  return encodeTxRaw(body, authInfoBytes(pubkey), [new Uint8Array(64)]);
}

/**
 * A varint field written even when its value is ZERO.
 *
 * `ProtoWriter.uint` omits a zero, which is canonical proto3 and exactly right
 * for the builder — but it makes an EXPLICIT `exec: EXEC_UNSPECIFIED`
 * unwritable through it, and that is a case the matrix must be able to submit:
 * "the pin's own value, spelled out" is a second encoding of the same intent,
 * and only the canonical re-encode refuses it. So the matrix drops to raw
 * bytes rather than testing a case it cannot construct.
 */
function rawVarintField(field: number, value: bigint): Uint8Array {
  const out = [(field << 3) | 0];
  let v = value;
  for (;;) {
    const septet = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      out.push(septet);
      break;
    }
    out.push(septet | 0x80);
  }
  return Uint8Array.from(out);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Hand-encode `MsgVote` with arbitrary field control, in field-number order. */
function rawVote(opts: {
  proposalId?: bigint;
  voter?: string;
  option?: bigint;
  metadata?: string;
  exec?: bigint;
  extraField?: number;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  if (opts.proposalId !== undefined && opts.proposalId !== 0n) {
    parts.push(rawVarintField(1, opts.proposalId));
  }
  parts.push(new ProtoWriter().string(2, opts.voter ?? SESSION_ADDRESS).finish());
  if (opts.option !== undefined) parts.push(rawVarintField(3, opts.option));
  if (opts.metadata !== undefined) {
    // An empty metadata string must still be WRITTEN here: the pin is "field
    // absent", so an explicitly-empty field is a distinct wire fact to refuse.
    parts.push(
      concatBytes([
        Uint8Array.from([(4 << 3) | 2, opts.metadata.length]),
        new TextEncoder().encode(opts.metadata),
      ]),
    );
  }
  if (opts.exec !== undefined) parts.push(rawVarintField(5, opts.exec));
  if (opts.extraField !== undefined) {
    parts.push(new ProtoWriter().string(opts.extraField, "x").finish());
  }
  return concatBytes(parts);
}

/** Hand-encode one inner `Any` for a proposal. */
function innerAny(opts: {
  typeUrl?: string;
  sender?: string;
  contract?: string;
  msg: string;
  funds?: { denom: string; amount: string }[];
}): Uint8Array {
  const exec = new ProtoWriter()
    .string(1, opts.sender ?? POLICY)
    .string(2, opts.contract ?? config.contractAddress)
    .bytes(3, new TextEncoder().encode(opts.msg));
  for (const coin of opts.funds ?? []) {
    exec.message(5, new ProtoWriter().string(1, coin.denom).string(2, coin.amount).finish(), true);
  }
  return new ProtoWriter()
    .string(1, opts.typeUrl ?? MSG_EXECUTE_CONTRACT)
    .bytes(2, exec.finish())
    .finish();
}

/** Hand-encode `MsgSubmitProposal` with arbitrary field control. */
function rawSubmit(opts: {
  policy?: string;
  proposers?: string[];
  metadata?: string;
  messages?: Uint8Array[];
  exec?: bigint;
  title?: string;
  summary?: string;
  /** Emit title/summary BEFORE the messages — same fields, wrong order. */
  reorder?: boolean;
  extraField?: number;
}): Uint8Array {
  const messages = opts.messages ?? [innerAny({ msg: `{"unpause_vault":{}}` })];
  const head = new ProtoWriter().string(1, opts.policy ?? POLICY);
  for (const proposer of opts.proposers ?? [SESSION_ADDRESS]) head.string(2, proposer);
  head.string(3, opts.metadata ?? "");

  const messageBytes = new ProtoWriter();
  for (const message of messages) messageBytes.message(4, message, true);
  const tail = new ProtoWriter()
    .string(6, opts.title ?? "Unpause the vault")
    .string(7, opts.summary ?? "Restore deposits and redemptions.");
  const extra =
    opts.extraField === undefined
      ? new Uint8Array()
      : new ProtoWriter().string(opts.extraField, "x").finish();

  // `exec` sits at field 5, BETWEEN the messages and the title, so a rejection
  // here is attributable to the pin rather than to field ordering.
  const exec = opts.exec === undefined ? new Uint8Array() : rawVarintField(5, opts.exec);
  return opts.reorder
    ? concatBytes([head.finish(), tail.finish(), messageBytes.finish(), extra])
    : concatBytes([head.finish(), messageBytes.finish(), exec, tail.finish(), extra]);
}

const UNPAUSE: ProposalTemplateInstance = { id: "unpause_vault", values: {} };
const submitIntent = (
  overrides: Partial<GovSubmitProposalIntent> = {},
): GovSubmitProposalIntent => ({
  kind: "gov_submit",
  proposer: SESSION_ADDRESS,
  policyAddress: POLICY,
  contractAddress: config.contractAddress,
  templates: [UNPAUSE],
  title: "Unpause the vault",
  summary: "Restore deposits and redemptions.",
  metadata: "",
  ...overrides,
});

describe("governance — the three admitted types are accepted in canonical form", () => {
  it("accepts a vote for each of the four options", async () => {
    for (const option of Object.keys(GOVERNANCE_VOTE_OPTIONS) as (keyof typeof GOVERNANCE_VOTE_OPTIONS)[]) {
      const tx = govTx({ kind: "gov_vote", voter: SESSION_ADDRESS, proposalId: 12n, option });
      expect(await guardSignedTx(config, SESSION_ADDRESS, tx, govDeps()), option).toEqual({
        ok: true,
      });
    }
  });

  it("accepts an exec of a passed proposal", async () => {
    const tx = govTx({ kind: "gov_exec", signer: SESSION_ADDRESS, proposalId: 12n });
    expect(await guardSignedTx(config, SESSION_ADDRESS, tx, govDeps())).toEqual({ ok: true });
  });

  it("accepts a proposal carrying EACH of the five admin templates", async () => {
    // The positive half of invariant 7: every template the registry offers
    // actually survives the guard. A template the composer can build and the
    // relay refuses would be a dead affordance.
    const instances: ProposalTemplateInstance[] = [
      { id: "update_config", values: { aum_fee_bps: 25n } },
      { id: "set_halted", values: { halted: true } },
      { id: "pause_vault", values: { reason: "emergency stop" } },
      { id: "unpause_vault", values: {} },
      { id: "clear_pending_delegations", values: {} },
    ];
    for (const instance of instances) {
      const tx = govTx(submitIntent({ templates: [instance] }));
      expect(await guardSignedTx(config, SESSION_ADDRESS, tx, govDeps()), instance.id).toEqual({
        ok: true,
      });
    }
  });

  it("accepts an update_config supplying ALL TEN optional fields", async () => {
    // The 2^10 shape space (§4b C1) at its far end: the canonical builder emits
    // every supplied field in declaration order, and condition 5 makes the
    // shape space irrelevant rather than enumerated.
    const tx = govTx(
      submitIntent({
        templates: [
          {
            id: "update_config",
            values: {
              max_delegations_per_run: 8n,
              aum_fee_bps: 25n,
              performance_threshold_bps: 9_500n,
              min_capture_interval_secs: 3_600n,
              max_concentration_multiple_bps: 55_000n,
              min_bonded_cap_bps: 500n,
              max_bonded_cap_bps: 3_300n,
              concentration_safety_offset_bps: 500n,
              commission_bps: 1_000n,
              jail_unbond_delay_secs: 28_800n,
            },
          },
        ],
        title: "Retune the program",
        summary: "Adjust every configurable parameter.",
      }),
    );
    expect(await guardSignedTx(config, SESSION_ADDRESS, tx, govDeps())).toEqual({ ok: true });
  });

  it("accepts a proposal carrying the optional public rationale", async () => {
    const tx = govTx(submitIntent({ metadata: "Discussed in the operator call on 2026-07-29." }));
    expect(await guardSignedTx(config, SESSION_ADDRESS, tx, govDeps())).toEqual({ ok: true });
  });

  it("accepts a proposal for ANY discovered policy, not just the first", async () => {
    // D1: policy discovery is SET-VALUED. A guard that compared against "the"
    // admin policy would reject a legitimate proposal to the ops policy, and
    // the devnet corpus carries two policies on one group precisely so this is
    // exercised by data rather than by belief.
    const tx = govTx(submitIntent({ policyAddress: OTHER_POLICY }));
    expect(
      await guardSignedTx(config, SESSION_ADDRESS, tx, govDeps([POLICY, OTHER_POLICY])),
    ).toEqual({ ok: true });
  });
});

describe("governance — the rejection matrix (§4 invariants 1–5)", () => {
  const reject = async (tx: Uint8Array, label: string, policies?: readonly string[]) => {
    expect(
      await guardSignedTx(config, SESSION_ADDRESS, tx, govDeps(policies)),
      label,
    ).toMatchObject({ ok: false, status: 400 });
  };

  // ── invariant 4: the `exec` pin, on BOTH messages ──────────────────────
  it("a MsgVote with ANY exec value → 400 (the pin, §2.4)", async () => {
    // EXEC_TRY would turn this vote into a vote PLUS execution of whatever the
    // proposal contains. An explicit EXEC_UNSPECIFIED is refused too: proto3
    // omits a zero varint, so writing it is a second encoding of the same
    // intent and there is exactly one accepted form.
    for (const exec of [0n, 1n, 2n, 255n]) {
      await reject(signedGovTx(MSG_GOV_VOTE, rawVote({ proposalId: 1n, option: 1n, exec })), `exec=${exec}`);
    }
  });

  it("a MsgSubmitProposal with ANY exec value → 400 (the pin, §2.4)", async () => {
    for (const exec of [0n, 1n, 2n, 255n]) {
      await reject(signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ exec })), `exec=${exec}`);
    }
  });

  // ── invariant 5: the sole signer is the session address ────────────────
  it("a vote for ANOTHER voter → 400", async () => {
    await reject(
      signedGovTx(MSG_GOV_VOTE, rawVote({ proposalId: 1n, option: 1n, voter: OTHER_POLICY })),
      "foreign voter",
    );
  });

  it("an exec signed for ANOTHER signer → 400", async () => {
    const value = new ProtoWriter().uint(1, 1n).string(2, OTHER_POLICY).finish();
    await reject(signedGovTx(MSG_GOV_EXEC, value), "foreign signer");
  });

  it("a proposal whose proposer is not the session → 400", async () => {
    await reject(signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ proposers: [OTHER_POLICY] })), "foreign proposer");
  });

  it("a proposal whose SECOND proposer is not the session → 400", async () => {
    // §4b C1's disproof, made executable: a verdict decided by ONE element of a
    // collection while another rides along unchecked. Checking only
    // `proposers[0]` would admit this.
    await reject(
      signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ proposers: [SESSION_ADDRESS, OTHER_POLICY] })),
      "second proposer is foreign",
    );
  });

  it("a proposal with the session address duplicated in proposers → 400", async () => {
    // Every entry passes the binding check; the CANONICAL form emits exactly
    // one, so the closing re-encode refuses it. That division of labour is
    // pinned here so a future edit cannot open a second accepted encoding.
    await reject(
      signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ proposers: [SESSION_ADDRESS, SESSION_ADDRESS] })),
      "duplicate proposer",
    );
  });

  it("a proposal with NO proposer → 400", async () => {
    await reject(signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ proposers: [] })), "no proposer");
  });

  // ── invariant 5: the policy must be a DISCOVERED program policy ────────
  it("a proposal for a policy that is not a program policy → 400", async () => {
    await reject(signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ policy: OTHER_POLICY })), "foreign policy");
  });

  it("a proposal when the policy set could NOT be resolved → 503, never admitted", async () => {
    // The conservative direction. "The chain was slow" is not a reason to relay
    // an admin proposal to an account nobody verified.
    const tx = govTx(submitIntent());
    for (const resolver of [
      async () => null,
      async () => [] as readonly string[],
      async () => {
        throw new Error("lcd down");
      },
    ]) {
      expect(
        await guardSignedTx(config, SESSION_ADDRESS, tx, {
          nowMs: freshClock(),
          resolvePolicies: resolver,
        }),
      ).toMatchObject({ ok: false, status: 503 });
    }
  });

  // ── invariant 2: only exact template instances ─────────────────────────
  it("a proposal with ZERO inner messages → 400", async () => {
    // Legal on the wire, and explicitly refused: an empty proposal is not a
    // template instance, and it would still consume a voting period.
    await reject(signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ messages: [] })), "zero messages");
  });

  it("a proposal MIXING one valid template with one arbitrary message → 400", async () => {
    // Per-element enforcement, not first-element enforcement. This is the M6.4
    // batched-payment failure shape transposed into a guard, where the cost is
    // an arbitrary message executed by the contract's admin.
    await reject(
      signedGovTx(
        MSG_GOV_SUBMIT_PROPOSAL,
        rawSubmit({
          messages: [
            innerAny({ msg: `{"unpause_vault":{}}` }),
            innerAny({ msg: `{"pay_commission":{"valoper":"${VALOPER}"}}` }),
          ],
        }),
      ),
      "valid + operator variant",
    );
  });

  it("a proposal whose inner message targets a DIFFERENT contract → 400", async () => {
    await reject(
      signedGovTx(
        MSG_GOV_SUBMIT_PROPOSAL,
        rawSubmit({
          messages: [
            innerAny({ contract: "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0", msg: `{"unpause_vault":{}}` }),
          ],
        }),
      ),
      "other contract",
    );
  });

  it("a proposal whose inner sender is not the group policy → 400", async () => {
    // x/group executes a proposal's messages AS the policy. A different sender
    // is either a message that cannot execute or one aimed somewhere the guard
    // does not reason about; neither is relayed.
    await reject(
      signedGovTx(
        MSG_GOV_SUBMIT_PROPOSAL,
        rawSubmit({ messages: [innerAny({ sender: SESSION_ADDRESS, msg: `{"unpause_vault":{}}` })] }),
      ),
      "sender is the proposer",
    );
  });

  it("the THREE alternate routes to the same authority → 400 (invariant 8 disproof)", async () => {
    // Each reaches the contract's admin — or decides who holds it — by a path
    // the M6.4 matrix does not model at all.
    const cases: { label: string; typeUrl: string }[] = [
      // Governance NESTING: a proposal whose inner message is a proposal.
      { label: "nested MsgSubmitProposal", typeUrl: MSG_GOV_SUBMIT_PROPOSAL },
      // The GROUP MODULE rather than the contract: this one changes WHO GOVERNS.
      { label: "MsgUpdateGroupMembers", typeUrl: "/cosmos.group.v1.MsgUpdateGroupMembers" },
      // An authz-wrapped admin message.
      { label: "authz MsgExec", typeUrl: "/cosmos.authz.v1beta1.MsgExec" },
    ];
    for (const { label, typeUrl } of cases) {
      await reject(
        signedGovTx(
          MSG_GOV_SUBMIT_PROPOSAL,
          rawSubmit({ messages: [innerAny({ typeUrl, msg: `{"unpause_vault":{}}` })] }),
        ),
        label,
      );
    }
  });

  it("a proposal carrying an OPERATOR or KEEPER variant → 400 (templates are ADMIN only)", async () => {
    for (const variant of [...OPERATOR_VARIANTS, ...KEEPER_VARIANTS]) {
      const body = (OPERATOR_VARIANTS as readonly string[]).includes(variant)
        ? `{"${variant}":{"valoper":"${VALOPER}"}}`
        : `{"${variant}":{}}`;
      await reject(
        signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ messages: [innerAny({ msg: body })] })),
        variant,
      );
    }
  });

  it("a template MUTATED byte-for-byte after canonical encoding → 400", async () => {
    // Start from bytes the builder itself produced, tamper INSIDE the encoded
    // payload, then re-frame so every proto length prefix is valid and the
    // message decodes cleanly. The second mutation is the one that makes
    // condition 5 load-bearing rather than belt-and-braces: it parses to
    // exactly the object the guard would accept, and differs only in bytes.
    const canonical = templateExecuteAny(POLICY, config.contractAddress, {
      id: "update_config",
      values: { aum_fee_bps: 25n },
    });
    const text = new TextDecoder().decode(canonical.value);
    const mutations: { label: string; from: string; to: string }[] = [
      // A parameter name this variant does not declare (same length → condition 4).
      { label: "unknown parameter", from: "aum_fee_bps", to: "aum_fee_bpz" },
      // A payload that parses to EXACTLY the object the guard accepts and
      // differs only in bytes: one space of padding. Every structural check
      // passes; only the re-encode comparison refuses it.
      { label: "padded payload", from: `{"update_config"`, to: `{"update_config" ` },
    ];
    for (const { label, from, to } of mutations) {
      expect(text).toContain(from);
      const mutated = text.replace(from, to);
      const value = new ProtoWriter()
        .string(1, POLICY)
        .string(2, config.contractAddress)
        .bytes(3, new TextEncoder().encode(mutated))
        .finish();
      // Rebuilt as a raw execute so the tamper is what differs, not the framing.
      const tamperedAny = new ProtoWriter()
        .string(1, MSG_EXECUTE_CONTRACT)
        .bytes(2, value)
        .finish();
      await reject(
        signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ messages: [tamperedAny] })),
        label,
      );
    }
  });

  it("a template re-encoded with a DIFFERENT value is accepted, and that is correct", async () => {
    // The counterpart the case above must not be confused with. Changing 25 to
    // 26 and re-encoding canonically yields a DIFFERENT, VALID proposal — and
    // the user signs those bytes with that number in the disclosure. The guard
    // refuses payloads that differ from what it validated, not payloads whose
    // values someone chose. Asserting this keeps a future "tighten the guard"
    // edit from quietly making legitimate proposals unsubmittable.
    const tx = govTx(
      submitIntent({ templates: [{ id: "update_config", values: { aum_fee_bps: 26n } }] }),
    );
    expect(await guardSignedTx(config, SESSION_ADDRESS, tx, govDeps())).toEqual({ ok: true });
  });

  it("a NON-CANONICAL encoding of an otherwise-valid template → 400", async () => {
    // Each parses to a payload the structural checks accept. Only the canonical
    // bytes check refuses them — the same property that keeps the M6.4 guard
    // out of a parser arms race, applied per inner message.
    for (const msg of [
      `{ "unpause_vault" : { } }`, // whitespace
      `{"unpause_vault":{}}\n`, // trailing newline
      `{"\\u0075npause_vault":{}}`, // escaped variant name
      `{"update_config":{"aum_fee_bps":25,"aum_fee_bps":25}}`, // duplicate key
      `{"update_config":{"commission_bps":1000,"aum_fee_bps":25}}`, // wrong key order
    ]) {
      await reject(
        signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ messages: [innerAny({ msg })] })),
        msg,
      );
    }
  });

  it("a template parameter OUTSIDE its contract bound → 400 (reject, never clamp)", async () => {
    for (const msg of [
      `{"update_config":{"aum_fee_bps":10001}}`, // > 10000
      `{"update_config":{"concentration_safety_offset_bps":10000}}`, // must be < 10000
      `{"update_config":{"max_bonded_cap_bps":0}}`, // must be >= 1
      `{"update_config":{"max_concentration_multiple_bps":0}}`, // must be > 0
      `{"update_config":{"aum_fee_bps":-1}}`, // negative
      `{"update_config":{"aum_fee_bps":25.5}}`, // fractional
      `{"update_config":{"aum_fee_bps":"25"}}`, // string-wrapped
      `{"update_config":{}}`, // supplies nothing: a vote on no change
      `{"update_config":{"admin":"tp1..."}}`, // a field the variant does not have
      `{"set_halted":{"halted":"true"}}`, // wrong type
      `{"set_halted":{}}`, // missing required field
      `{"pause_vault":{"reason":""}}`, // empty reason
      `{"unpause_vault":{"reason":"x"}}`, // extra field on a fieldless variant
    ]) {
      await reject(
        signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ messages: [innerAny({ msg })] })),
        msg,
      );
    }
  });

  it("FUNDS on an inner admin message → 400 (no admin variant is payable)", async () => {
    await reject(
      signedGovTx(
        MSG_GOV_SUBMIT_PROPOSAL,
        rawSubmit({
          messages: [
            innerAny({ msg: `{"unpause_vault":{}}`, funds: [{ denom: "nhash", amount: "1000" }] }),
          ],
        }),
      ),
      "funds on unpause",
    );
  });

  it("a proposal ABOVE the per-proposal message cap → 400, never truncated", async () => {
    const messages = Array.from({ length: MAX_PROPOSAL_MESSAGES + 1 }, () =>
      innerAny({ msg: `{"unpause_vault":{}}` }),
    );
    await reject(signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ messages })), "over cap");
  });

  // ── invariant 13: inputs bounded at entry ──────────────────────────────
  it("a vote with an out-of-range or absent option → 400", async () => {
    for (const option of [undefined, 0n, 5n, 255n, 1_000n]) {
      await reject(
        signedGovTx(MSG_GOV_VOTE, rawVote({ proposalId: 1n, option })),
        `option=${String(option)}`,
      );
    }
  });

  it("a vote or exec on proposal id 0 (absent on the wire) → 400", async () => {
    await reject(signedGovTx(MSG_GOV_VOTE, rawVote({ option: 1n })), "vote id 0");
    await reject(
      signedGovTx(MSG_GOV_EXEC, new ProtoWriter().string(2, SESSION_ADDRESS).finish()),
      "exec id 0",
    );
  });

  it("a vote carrying metadata → 400 (votes carry none, §7 Q3)", async () => {
    for (const metadata of ["", "because"]) {
      await reject(
        signedGovTx(MSG_GOV_VOTE, rawVote({ proposalId: 1n, option: 1n, metadata })),
        `metadata=${metadata}`,
      );
    }
  });

  it("a proposal with over-long metadata, title or summary → 400", async () => {
    await reject(
      signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ metadata: "x".repeat(MAX_PROPOSAL_METADATA_LEN + 1) })),
      "metadata too long",
    );
    await reject(signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ title: "" })), "no title");
    await reject(signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ summary: "" })), "no summary");
  });

  it("an UNKNOWN proto field smuggled into any of the three → 400", async () => {
    await reject(
      signedGovTx(MSG_GOV_VOTE, rawVote({ proposalId: 1n, option: 1n, extraField: 9 })),
      "vote field 9",
    );
    await reject(
      signedGovTx(
        MSG_GOV_EXEC,
        new ProtoWriter().uint(1, 1n).string(2, SESSION_ADDRESS).string(9, "x").finish(),
      ),
      "exec field 9",
    );
    await reject(signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ extraField: 9 })), "submit field 9");
  });

  it("a proposal whose fields are REORDERED → 400", async () => {
    // Every field is individually valid; only the closing whole-message
    // re-encode refuses the arrangement.
    await reject(signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawSubmit({ reorder: true })), "reordered");
  });

  it("a MsgSubmitProposal SHAPED to look like a vote → 400", async () => {
    // Field 1 as a varint proposal id and field 2 as the voter — the vote's
    // shape under the submission's type URL. Field 1 is the POLICY here, so a
    // guard that read field 1 as "whatever this message's first field is" would
    // be comparing a proposal id against a policy set.
    await reject(
      signedGovTx(MSG_GOV_SUBMIT_PROPOSAL, rawVote({ proposalId: 1n, option: 1n })),
      "vote shape under submit type URL",
    );
  });

  it("a MsgVote SHAPED as a submission → 400", async () => {
    await reject(signedGovTx(MSG_GOV_VOTE, rawSubmit({})), "submit shape under vote type URL");
  });

  it("a governance msg BESIDE an unguarded one in the same tx → 400", async () => {
    // The guard runs over EVERY message in the body (§4b C1), so pairing a
    // legitimate vote with a message that would otherwise be refused does not
    // smuggle the second one through.
    const vote = new ProtoWriter()
      .string(1, MSG_GOV_VOTE)
      .bytes(2, rawVote({ proposalId: 1n, option: 1n }))
      .finish();
    const bad = new ProtoWriter()
      .string(1, "/cosmos.group.v1.MsgUpdateGroupMembers")
      .bytes(2, new ProtoWriter().string(1, SESSION_ADDRESS).finish())
      .finish();
    const body = new ProtoWriter().message(1, vote, true).message(1, bad, true).finish();
    await reject(encodeTxRaw(body, authInfoBytes(), [new Uint8Array(64)]), "vote + group update");
  });

  it("a signer pubkey that does not derive the session address → 403", async () => {
    const tx = signedGovTx(MSG_GOV_VOTE, rawVote({ proposalId: 1n, option: 1n }), OTHER_PUB);
    expect(await guardSignedTx(config, SESSION_ADDRESS, tx, govDeps())).toMatchObject({
      ok: false,
      status: 403,
    });
  });
});

describe("invariant 8 — the direct-admin path stays closed after the amendment", () => {
  // THE INVARIANT MOST AT RISK OF ACCIDENTAL EROSION (plan §9). Admin ops reach
  // the chain ONLY through governance, and the easiest way to lose that is to
  // relax the older matrix while extending the newer one. So the M6.4 rows are
  // re-asserted HERE, after the governance guards exist, rather than trusted to
  // still be passing further up the file.
  it("every ADMIN variant is STILL refused as a direct MsgExecuteContract", async () => {
    const bodies: Record<(typeof ADMIN_VARIANTS)[number], string> = {
      set_halted: `{"set_halted":{"halted":true}}`,
      update_config: `{"update_config":{"aum_fee_bps":25}}`,
      pause_vault: `{"pause_vault":{"reason":"x"}}`,
      unpause_vault: `{"unpause_vault":{}}`,
      clear_pending_delegations: `{"clear_pending_delegations":{}}`,
    };
    for (const variant of ADMIN_VARIANTS) {
      const value = new ProtoWriter()
        .string(1, SESSION_ADDRESS)
        .string(2, config.contractAddress)
        .bytes(3, new TextEncoder().encode(bodies[variant]))
        .finish();
      const anyMsg = new ProtoWriter().string(1, MSG_EXECUTE_CONTRACT).bytes(2, value).finish();
      const body = new ProtoWriter().message(1, anyMsg, true).finish();
      expect(
        await guardSignedTx(
          config,
          SESSION_ADDRESS,
          encodeTxRaw(body, authInfoBytes(), [new Uint8Array(64)]),
          { nowMs: freshClock() },
        ),
        variant,
      ).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("the canonical governance path carries the SAME variant successfully", async () => {
    // The two halves of the design, adjacent: refused directly, carried as a
    // template-scoped proposal. If a future edit ever made the first pass, this
    // pair is where the contradiction shows.
    const tx = govTx(submitIntent({ templates: [{ id: "set_halted", values: { halted: true } }] }));
    expect(await guardSignedTx(config, SESSION_ADDRESS, tx, govDeps())).toEqual({ ok: true });
  });
});
