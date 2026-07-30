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
  encodeTxBody,
  encodeTxRaw,
  ADMIN_VARIANTS,
  ALLOWED_MSG_TYPE_URLS,
  KEEPER_VARIANTS,
  MSG_EXECUTE_CONTRACT,
  OPERATOR_VARIANTS,
  type OperatorIntent,
  type TxIntent,
} from "~/tx/build";
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
  it("accepts the session's own vault tx", () => {
    expect(guardSignedTx(config, SESSION_ADDRESS, signedTx())).toEqual({ ok: true });
  });

  it("SIGNER pubkey not deriving the session address → 403", () => {
    const verdict = guardSignedTx(config, SESSION_ADDRESS, signedTx({ pubkey: OTHER_PUB }));
    expect(verdict).toMatchObject({ ok: false, status: 403 });
  });

  it("message owner differing from the session address → 403", () => {
    const verdict = guardSignedTx(
      config,
      SESSION_ADDRESS,
      signedTx({ owner: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad" }),
    );
    expect(verdict).toMatchObject({ ok: false, status: 403 });
  });

  it("non-allowlisted message type → 400", () => {
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
    expect(guardSignedTx(config, SESSION_ADDRESS, tx)).toMatchObject({ ok: false, status: 400 });
  });

  // M7.1 §2.5 / §4 invariant 13: the governance indexing PR adds NO signing path.
  // `ALLOWED_MSG_TYPE_URLS` is unchanged by it, and this row is what makes that a
  // gated fact rather than a claim in a plan — the governance amendment is
  // 7.3–7.4's focused review, and until it lands a vote must be refused.
  it("a governance MsgVote → 400 (the relay stays closed through PR 7.1)", () => {
    // Hand-encode `cosmos.group.v1.MsgVote` (proposal_id, voter, option) inside a
    // TxBody signed by the session key: everything about it is legitimate EXCEPT
    // that its type URL is not on the allowlist.
    const msgVote = new ProtoWriter()
      .uint(1, 1n)
      .string(2, SESSION_ADDRESS)
      .uint(3, 1n)
      .finish();
    const anyMsg = new ProtoWriter()
      .string(1, "/cosmos.group.v1.MsgVote")
      .bytes(2, msgVote)
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
    expect(guardSignedTx(config, SESSION_ADDRESS, tx)).toMatchObject({ ok: false, status: 400 });
  });

  it("the allowlist itself carries no x/group type URL", () => {
    // Asserted on the CONSTANT, not just on a rejection path: a future edit that
    // admitted a governance message would have to change this line, which is
    // exactly the review event 7.3–7.4 is scheduled to be.
    for (const url of ALLOWED_MSG_TYPE_URLS) {
      expect(url).not.toMatch(/^\/cosmos\.group\./);
    }
  });

  it("unexpected vault address → 400", () => {
    const verdict = guardSignedTx(
      config,
      SESSION_ADDRESS,
      signedTx({ vault: "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0" }),
    );
    expect(verdict).toMatchObject({ ok: false, status: 400 });
  });

  it("oversize → 413", () => {
    const verdict = guardSignedTx(config, SESSION_ADDRESS, new Uint8Array(SIZE_CAP_BYTES + 1));
    expect(verdict).toMatchObject({ ok: false, status: 413 });
  });

  it("malformed bytes → 400", () => {
    expect(guardSignedTx(config, SESSION_ADDRESS, new Uint8Array([0xff, 0x01, 0x02]))).toMatchObject(
      { ok: false, status: 400 },
    );
  });

  it("multiple signatures → 400 (sole-signer rule)", () => {
    const verdict = guardSignedTx(config, SESSION_ADDRESS, signedTx({ signatures: 2 }));
    expect(verdict).toMatchObject({ ok: false, status: 400 });
  });

  it("empty TxBody (no messages) → 400", () => {
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
    expect(guardSignedTx(config, SESSION_ADDRESS, tx)).toMatchObject({ ok: false, status: 400 });
  });

  it("rate limit: request N+1 in a minute → 429; a new window admits again", () => {
    const nowMs = 1_750_000_000_000;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i += 1) {
      expect(guardSignedTx(config, SESSION_ADDRESS, signedTx(), nowMs + i)).toEqual({ ok: true });
    }
    expect(guardSignedTx(config, SESSION_ADDRESS, signedTx(), nowMs + 10)).toMatchObject({
      ok: false,
      status: 429,
    });
    expect(guardSignedTx(config, SESSION_ADDRESS, signedTx(), nowMs + 61_000)).toEqual({ ok: true });
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
  it("accepts each funded payment variant", () => {
    for (const variant of ["pay_commission", "pay_tip"] as const) {
      expect(guardSignedTx(config, SESSION_ADDRESS, operatorTx({ variant })), variant).toEqual({
        ok: true,
      });
    }
  });

  it("accepts each fundless variant with no funds attached", () => {
    for (const variant of [
      "register_participation",
      "unregister_participation",
      "report_jailed_validator",
      "purge_jailed_validator",
    ] as const) {
      expect(
        guardSignedTx(config, SESSION_ADDRESS, operatorTx({ variant, amount: 0n })),
        variant,
      ).toEqual({ ok: true });
    }
  });

  it("accepts a purge carrying an optional claimant valoper", () => {
    expect(
      guardSignedTx(
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

  it("still binds the sender to the session address (403, like a swap owner)", () => {
    const tx = operatorTx({ sender: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad" });
    expect(guardSignedTx(config, SESSION_ADDRESS, tx)).toMatchObject({ ok: false, status: 403 });
  });
});

describe("operator execute — the rejection matrix (§2.5)", () => {
  // Each case gets its own rate-limit window: these loops submit far more than
  // RATE_LIMIT_PER_MINUTE attempts, and a 429 would mask the 400 under test.
  let clock = 1_750_000_000_000;
  const reject = (tx: Uint8Array, label: string) => {
    clock += 61_000;
    expect(guardSignedTx(config, SESSION_ADDRESS, tx, clock), label).toMatchObject({
      ok: false,
      status: 400,
    });
  };

  it("a DIFFERENT contract address → 400 (the relay is not a general caller)", () => {
    reject(
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

  it("every ADMIN / KEEPER variant → 400", () => {
    for (const variant of [...ADMIN_VARIANTS, ...KEEPER_VARIANTS]) {
      const msg = REJECTED_VARIANT_BODIES[variant];
      reject(signedExecuteTx(rawExecute({ msg })), msg);
    }
  });

  it("the admin/keeper vocabulary is disjoint from the relay's operator set", () => {
    // The lists exist so the decoder and the composer share one vocabulary; an
    // overlap would mean naming an action twice with different authority.
    const operators = new Set<string>(OPERATOR_VARIANTS);
    for (const variant of [...ADMIN_VARIANTS, ...KEEPER_VARIANTS]) {
      expect(operators.has(variant)).toBe(false);
    }
  });

  it("a multi-key inner payload → 400 (an allowed variant beside a forbidden one)", () => {
    reject(
      signedExecuteTx(
        rawExecute({
          msg: `{"pay_tip":{"valoper":"${VALOPER}"},"set_halted":{"halted":true}}`,
        }),
      ),
      "two keys",
    );
  });

  it("an extra field inside an allowed variant → 400", () => {
    reject(
      signedExecuteTx(
        rawExecute({ msg: `{"register_participation":{"valoper":"${VALOPER}","admin":true}}` }),
      ),
      "extra field",
    );
  });

  it("a claimant on a variant that has no claimant → 400", () => {
    reject(
      signedExecuteTx(
        rawExecute({
          msg: `{"report_jailed_validator":{"valoper":"${VALOPER}","claimant_valoper":"${OTHER_VALOPER}"}}`,
        }),
      ),
      "claimant on report",
    );
  });

  it("an explicit claimant_valoper: null → 400 (one accepted encoding only)", () => {
    // There is exactly ONE byte sequence per (variant, arguments): the
    // canonical builder omits a null claimant entirely, so spelling it out
    // explicitly is a different encoding of the same intent and the
    // canonical-bytes check refuses it. The body-shape check deliberately
    // tolerates the null — condition 5 is what closes it, and this pins that
    // division of labour so a future edit to either half cannot open a second
    // accepted encoding unnoticed (2026-07-28 review).
    reject(
      signedExecuteTx(
        rawExecute({
          msg: `{"purge_jailed_validator":{"valoper":"${VALOPER}","claimant_valoper":null}}`,
        }),
      ),
      "explicit null claimant",
    );
  });

  it("a valoper that is not a valoper → 400", () => {
    for (const bad of [
      SESSION_ADDRESS, // an ACCOUNT address where a valoper is required
      "not-bech32",
      "tpvaloper1UPPER",
      "",
    ]) {
      reject(
        signedExecuteTx(rawExecute({ msg: `{"unregister_participation":{"valoper":"${bad}"}}` })),
        `valoper=${bad}`,
      );
    }
  });

  it("FUNDS on a fundless variant → 400 (funds smuggling)", () => {
    for (const variant of [
      "register_participation",
      "unregister_participation",
      "report_jailed_validator",
      "purge_jailed_validator",
    ]) {
      reject(
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

  it("a payment with the wrong denom, zero, or no coin → 400", () => {
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
      reject(
        signedExecuteTx(rawExecute({ msg: `{"pay_commission":{"valoper":"${VALOPER}"}}`, funds })),
        label,
      );
    }
  });

  it("a NON-CANONICAL encoding of an otherwise-valid variant → 400", () => {
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
      reject(signedExecuteTx(rawExecute({ msg, funds })), msg);
    }
  });

  it("a payload that is not a JSON object → 400", () => {
    for (const msg of [`"pay_commission"`, `["pay_commission"]`, `null`, `42`, `not json`, ``]) {
      reject(signedExecuteTx(rawExecute({ msg, funds: [] })), JSON.stringify(msg));
    }
  });

  it("an execute with NO inner payload at all → 400", () => {
    const value = new ProtoWriter()
      .string(1, SESSION_ADDRESS)
      .string(2, config.contractAddress)
      .finish();
    reject(signedExecuteTx(value), "no msg field");
  });

  it("a SECOND proto payload field → 400 (no last-wins ambiguity at the wire level)", () => {
    // Two `msg` fields: a decoder that took the first (or the last) could
    // validate one payload while the chain executes the other. The decode
    // refuses the ambiguity outright rather than picking a winner.
    const value = new ProtoWriter()
      .string(1, SESSION_ADDRESS)
      .string(2, config.contractAddress)
      .bytes(3, new TextEncoder().encode(`{"pay_tip":{"valoper":"${VALOPER}"}}`))
      .bytes(3, new TextEncoder().encode(`{"set_halted":{"halted":true}}`))
      .finish();
    reject(signedExecuteTx(value), "duplicate msg field");
  });

  it("a payload that is not valid UTF-8 → 400", () => {
    const value = new ProtoWriter()
      .string(1, SESSION_ADDRESS)
      .string(2, config.contractAddress)
      .bytes(3, Uint8Array.from([0xff, 0xfe, 0x7b, 0x7d]))
      .finish();
    reject(signedExecuteTx(value), "invalid utf-8");
  });

  it("a contract call disguised under an unknown type URL → 400 (first level)", () => {
    reject(
      signedExecuteTx(rawExecute({ msg: `{"pay_commission":{"valoper":"${VALOPER}"}}` }), {
        typeUrl: "/cosmwasm.wasm.v1.MsgMigrateContract",
      }),
      "migrate",
    );
  });

  it("a valid operator msg BESIDE a forbidden one in the same tx → 400", () => {
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
    reject(encodeTxRaw(body, plan.authInfoBytes, [new Uint8Array(64)]), "mixed batch");
  });
});
