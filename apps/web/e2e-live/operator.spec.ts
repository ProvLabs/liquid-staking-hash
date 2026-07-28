// e2e-live: the M6.4 operator flows on devnet (plan 6.4 §3 commit D). The
// offline layers prove the pieces — byte-goldens against captured txs, the
// deep-guard rejection matrix, disclosure-equals-signed-bytes, the pure
// predicate matrix. What ONLY a live run proves is the wiring between them:
// that a real session, real preflight against live chain state, a real
// simulate, and the real relay compose into a transaction the chain executes.
//
// ── What this spec can and cannot drive ────────────────────────────────────
//
// The throwaway `E2E_LIVE_SIGNER_KEY` is a funded account, NOT a validator's
// operator key. That is not a limitation to work around — it is the shape of
// the contract's own authorization, and it splits the six variants cleanly:
//
//   * PERMISSIONLESS (covered here): `pay_commission` and `pay_tip` — "anyone,
//     nhash attached". This is exactly the property `operatorPreflightReasons`
//     models by NOT applying an operator check to payments, so driving it with
//     a non-operator key is the honest test of it, not a workaround.
//   * OPERATOR-GATED (covered only with `E2E_LIVE_OPERATOR_KEY`):
//     `register_participation` needs the caller's bech32 payload to equal the
//     valoper's, and `unregister_participation` needs the enrolled operator.
//     Those legs skip cleanly, loudly, when that key is absent.
//   * JAIL-GATED (NOT covered — plan §7 Q4's honest-gap posture):
//     `report_jailed_validator` / `purge_jailed_validator` need a genuinely
//     jailed validator plus an elapsed cooldown. `contracts/drills/jail-drill.sh`
//     can produce one, but only on a chain reset for that purpose, which would
//     destroy the state every other live spec runs against. Recorded as not
//     covered rather than faked with a stubbed jail state — a purge test that
//     did not purge would be worse than no purge test.
//
// The guard assertion below is the one this spec exists for above all: it
// submits an ADMIN variant through the LIVE relay, with a valid session, and
// requires a 400. The unit matrix proves the guard function; this proves the
// guard is actually WIRED into the route that faces the network.
//
// Needs the devnet stack + E2E_LIVE_SIGNER_KEY, E2E_LIVE_VAULT_ADDRESS,
// E2E_LIVE_LCD_URL; skips cleanly otherwise.

import { expect, test, type APIRequestContext } from "@playwright/test";

import { LcdClient, NvhashContractClient, VaultClient } from "@nvhash/chain-client";

import {
  buildTxPlan,
  encodeTxRaw,
  MSG_EXECUTE_CONTRACT,
  type OperatorIntent,
} from "../app/tx/build";
import { ProtoWriter } from "../app/tx/proto";
import { DevnetTestSigner } from "./signer";

const KEY = process.env.E2E_LIVE_SIGNER_KEY;
const VAULT = process.env.E2E_LIVE_VAULT_ADDRESS;
const LCD = process.env.E2E_LIVE_LCD_URL;
/** The validator's OWN operator key — enables the enroll/unregister legs. */
const OPERATOR_KEY = process.env.E2E_LIVE_OPERATOR_KEY;

test.skip(
  KEY === undefined || VAULT === undefined || LCD === undefined,
  "e2e-live env not set (E2E_LIVE_SIGNER_KEY / _VAULT_ADDRESS / _LCD_URL)",
);

/** A deliberately small commission payment: non-refundable, and it sweeps into
 * vault principal at the next epoch, so a live run should not move real value
 * around more than it must. */
const PAYMENT_NHASH = 1_000_000n; // 0.001 HASH

interface SimResult {
  fee: { gas_limit: string; amount: string; denom: string };
  signer: { account_number: string; sequence: string; chain_id: string };
}

/** Log in over the same HTTP surface the app uses (nonce → ADR-36 → cookie). */
async function login(request: APIRequestContext, signer: DevnetTestSigner): Promise<void> {
  const { nonce, challenge } = (await (
    await request.post("/session/nonce", { data: { address: signer.address } })
  ).json()) as { nonce: string; challenge: string };
  const res = await request.post("/session/login", {
    data: {
      address: signer.address,
      nonce,
      pubkey: signer.pubkeyBase64,
      signature: signer.signChallenge(challenge),
    },
  });
  expect(res.ok()).toBe(true);
}

/** Resolve the program contract + an enrolled valoper from live chain state. */
async function programContext(): Promise<{ contract: string; valoper: string | null }> {
  const lcd = new LcdClient(LCD!);
  const vault = await new VaultClient(lcd).getVault(VAULT!);
  const contract = vault.vault.assetManager;
  const validators = await new NvhashContractClient(lcd, contract).validators();
  return { contract, valoper: validators[0]?.valoper ?? null };
}

/** Drive preflight → simulate → sign → broadcast for one operator intent. */
async function runOperatorFlow(
  request: APIRequestContext,
  signer: DevnetTestSigner,
  intentBase: Omit<OperatorIntent, "kind" | "sender">,
): Promise<{ preflightReasons: unknown[]; txhash?: string; code?: number; relayStatus: number }> {
  const pfRes = await request.post("/tx/preflight", {
    data: {
      kind: "operator",
      variant: intentBase.variant,
      valoper: intentBase.valoper,
      claimantValoper: intentBase.claimantValoper,
      amount: intentBase.amount.toString(),
    },
  });
  const pf = (await pfRes.json()) as { reasons: unknown[] };
  if (pf.reasons.length > 0) return { preflightReasons: pf.reasons, relayStatus: 0 };

  const sim = (await (
    await request.post("/tx/simulate", {
      data: {
        kind: "operator",
        variant: intentBase.variant,
        valoper: intentBase.valoper,
        claimantValoper: intentBase.claimantValoper,
        amount: intentBase.amount.toString(),
        denom: intentBase.denom,
        pubkey: signer.pubkeyBase64,
      },
    })
  ).json()) as SimResult;

  const plan = buildTxPlan(
    { kind: "operator", sender: signer.address, ...intentBase },
    { gasLimit: BigInt(sim.fee.gas_limit), amount: BigInt(sim.fee.amount), denom: sim.fee.denom },
    {
      chainId: sim.signer.chain_id,
      accountNumber: BigInt(sim.signer.account_number),
      sequence: BigInt(sim.signer.sequence),
      pubkeyBase64: signer.pubkeyBase64,
    },
  );
  const txRaw = encodeTxRaw(plan.bodyBytes, plan.authInfoBytes, [
    signer.signDirect(plan.signDocBytes),
  ]);
  const bcRes = await request.post("/tx/broadcast", {
    data: { tx_raw: Buffer.from(txRaw).toString("base64") },
  });
  if (!bcRes.ok()) return { preflightReasons: [], relayStatus: bcRes.status() };
  const bc = (await bcRes.json()) as { txhash: string; code: number };
  return { preflightReasons: [], txhash: bc.txhash, code: bc.code, relayStatus: bcRes.status() };
}

/** Poll `/tx/status` until inclusion (the tracker's own surface). */
async function awaitInclusion(
  request: APIRequestContext,
  txhash: string,
): Promise<{ included: boolean; code?: number }> {
  for (let i = 0; i < 30; i += 1) {
    const status = (await (await request.get(`/tx/status?hash=${txhash}`)).json()) as {
      included: boolean;
      code?: number;
    };
    if (status.included) return status;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return { included: false };
}

test("pay commission end to end: preflight → simulate → relay → chain accepts", async ({
  request,
}) => {
  const signer = new DevnetTestSigner(KEY!);
  const { contract, valoper } = await programContext();
  test.skip(valoper === null, "no validator is enrolled on this devnet — run register-validator.sh");

  await login(request, signer);

  // Read the contract's own view of what has been paid, so the assertion is
  // against chain state rather than against our own request echoing back.
  const lcd = new LcdClient(LCD!);
  const contractClient = new NvhashContractClient(lcd, contract);
  const before = (await contractClient.validators()).find((v) => v.valoper === valoper)!;

  const result = await runOperatorFlow(request, signer, {
    variant: "pay_commission",
    contractAddress: contract,
    valoper: valoper!,
    claimantValoper: null,
    amount: PAYMENT_NHASH,
    denom: "nhash",
  });

  // Payment is PERMISSIONLESS: this signer is not the validator's operator,
  // and preflight must not have invented a reason saying otherwise.
  expect(result.preflightReasons).toEqual([]);
  expect(result.relayStatus).toBe(200);
  expect(result.code).toBe(0);

  const inclusion = await awaitInclusion(request, result.txhash!);
  expect(inclusion.included).toBe(true);
  expect(inclusion.code).toBe(0);

  // The contract credited exactly what was attached — the cumulative paid
  // total moved by the payment, proving the funds leg encoded correctly.
  const after = (await contractClient.validators()).find((v) => v.valoper === valoper)!;
  expect(after.commissionPaid - before.commissionPaid).toBe(PAYMENT_NHASH);
});

test("pay TIP credits the CURRENT epoch (the non-cumulative counterpart)", async ({ request }) => {
  const signer = new DevnetTestSigner(KEY!);
  const { contract, valoper } = await programContext();
  test.skip(valoper === null, "no validator is enrolled on this devnet");

  await login(request, signer);
  const lcd = new LcdClient(LCD!);
  const contractClient = new NvhashContractClient(lcd, contract);
  const before = (await contractClient.validators()).find((v) => v.valoper === valoper)!;

  const result = await runOperatorFlow(request, signer, {
    variant: "pay_tip",
    contractAddress: contract,
    valoper: valoper!,
    claimantValoper: null,
    amount: PAYMENT_NHASH,
    denom: "nhash",
  });
  expect(result.preflightReasons).toEqual([]);
  expect(result.code).toBe(0);
  expect((await awaitInclusion(request, result.txhash!)).code).toBe(0);

  // tip_epoch is the per-epoch accumulator, not a lifetime total — absent an
  // epoch crank mid-test it moves by exactly the payment.
  const after = (await contractClient.validators()).find((v) => v.valoper === valoper)!;
  expect(after.tipEpoch - before.tipEpoch).toBe(PAYMENT_NHASH);
});

test("THE guard is wired: an admin variant is refused by the live relay", async ({ request }) => {
  // The unit matrix proves `guardOperatorExecute` rejects this. This proves the
  // guard actually runs on the route that faces the network — with a VALID
  // session, so nothing but the deep guard stands between these bytes and the
  // chain. If this ever returns 200, the relay is a general contract-call
  // service and the §12.3 bound is broken.
  const signer = new DevnetTestSigner(KEY!);
  const { contract } = await programContext();
  await login(request, signer);

  // Hand-encode MsgExecuteContract{ set_halted } — the builder cannot produce
  // it, which is the point: this is what an attacker with a session would send.
  const execValue = new ProtoWriter()
    .string(1, signer.address)
    .string(2, contract)
    .bytes(3, new TextEncoder().encode('{"set_halted":{"halted":true}}'))
    .finish();
  const anyMsg = new ProtoWriter()
    .string(1, MSG_EXECUTE_CONTRACT)
    .bytes(2, execValue)
    .finish();
  const body = new ProtoWriter().message(1, anyMsg, true).finish();

  // A structurally valid, correctly signed tx — only the payload is forbidden.
  const scaffold = buildTxPlan(
    {
      kind: "operator",
      variant: "pay_tip",
      sender: signer.address,
      contractAddress: contract,
      valoper: "tpvaloper1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
      claimantValoper: null,
      amount: 1n,
      denom: "nhash",
    },
    { gasLimit: 2n, amount: 2n, denom: "nhash" },
    {
      chainId: "chain-dev",
      accountNumber: 0n,
      sequence: 0n,
      pubkeyBase64: signer.pubkeyBase64,
    },
  );
  const txRaw = encodeTxRaw(body, scaffold.authInfoBytes, [new Uint8Array(64)]);

  const res = await request.post("/tx/broadcast", {
    data: { tx_raw: Buffer.from(txRaw).toString("base64") },
  });
  expect(res.status()).toBe(400);
  // And it never reached the chain: the relay refused before broadcasting.
  expect(await res.text()).not.toContain("txhash");
});

test("the guard refuses a call to a DIFFERENT contract, session and all", async ({ request }) => {
  const signer = new DevnetTestSigner(KEY!);
  await login(request, signer);

  // A legitimate operator variant, aimed at the vault instead of the program
  // contract — the "relay as general contract caller" case.
  const execValue = new ProtoWriter()
    .string(1, signer.address)
    .string(2, VAULT!)
    .bytes(
      3,
      new TextEncoder().encode(
        '{"pay_tip":{"valoper":"tpvaloper1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"}}',
      ),
    )
    .message(5, new ProtoWriter().string(1, "nhash").string(2, "1").finish(), true)
    .finish();
  const anyMsg = new ProtoWriter().string(1, MSG_EXECUTE_CONTRACT).bytes(2, execValue).finish();
  const body = new ProtoWriter().message(1, anyMsg, true).finish();
  const scaffold = buildTxPlan(
    {
      kind: "operator",
      variant: "pay_tip",
      sender: signer.address,
      contractAddress: VAULT!,
      valoper: "tpvaloper1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
      claimantValoper: null,
      amount: 1n,
      denom: "nhash",
    },
    { gasLimit: 2n, amount: 2n, denom: "nhash" },
    { chainId: "chain-dev", accountNumber: 0n, sequence: 0n, pubkeyBase64: signer.pubkeyBase64 },
  );

  const res = await request.post("/tx/broadcast", {
    data: {
      tx_raw: Buffer.from(
        encodeTxRaw(body, scaffold.authInfoBytes, [new Uint8Array(64)]),
      ).toString("base64"),
    },
  });
  expect(res.status()).toBe(400);
});

test("preflight restates the contract's own enrolment rule against live state", async ({
  request,
}) => {
  // The throwaway signer is NOT any validator's operator account, so the
  // contract would reject an enrolment from it. Preflight must say so BEFORE
  // signing — the whole point of restating predicates (§12.1).
  const signer = new DevnetTestSigner(KEY!);
  const { valoper } = await programContext();
  test.skip(valoper === null, "no validator is enrolled on this devnet");
  await login(request, signer);

  const pf = (await (
    await request.post("/tx/preflight", {
      data: {
        kind: "operator",
        variant: "register_participation",
        valoper,
        claimantValoper: null,
        amount: "0",
      },
    })
  ).json()) as { reasons: { code: string }[] };

  const codes = pf.reasons.map((r) => r.code);
  expect(codes).toContain("not-validator-operator");
  // Already enrolled, too — both true facts, both stated, neither invented.
  expect(codes).toContain("already-enrolled");
});

// ── Operator-gated legs: only with the validator's own operator key ────────

// The round trip below RESETS the validator's economics, BY DESIGN. `unregister`
// does `VALIDATORS.remove` (contracts/src/validators.rs), so re-enrolling
// creates a fresh record: `commission_paid`, `commission_accrued`, `tip_epoch`
// and `enrolled_at` all start at zero. A validator that leaves the program and
// returns does not pick up where it left off — and since paid commission is
// non-refundable, there is nothing owed back to carry over. This test asserts
// the round trip works; it does not assert continuity, because the contract
// offers none.
//
// The practical consequence for whoever runs this: a devnet carrying drill
// history (accumulated tip/commission from `p2p-drill.sh`) comes out of it
// zeroed. Re-establish whatever later steps depend on with
// infra/devnet/actions/pay-commission.sh and pay-tip.sh — that is re-seeding a
// fixture, not restoring an entitlement.
//
// Run 2026-07-27 did exactly that: tip_epoch 2751000000 / commission_paid
// 1501000000 re-seeded after the round trip.
test.describe("enroll / unregister (needs the validator's operator key)", () => {
  test.skip(
    OPERATOR_KEY === undefined,
    "E2E_LIVE_OPERATOR_KEY not set — enrolment is gated on the valoper's own " +
      "operator account (contract `is_operator`), which a throwaway funded key " +
      "is not. Set it to the validator operator's 32-hex private key to cover " +
      "these — and read the DESTRUCTIVE warning above first.",
  );

  test("unregister then re-enroll the operator's own validator", async ({ request }) => {
    const operator = new DevnetTestSigner(OPERATOR_KEY!);
    const { contract, valoper } = await programContext();
    test.skip(valoper === null, "no validator is enrolled on this devnet");
    await login(request, operator);

    const lcd = new LcdClient(LCD!);
    const contractClient = new NvhashContractClient(lcd, contract);

    // Withdraw: the program's stake unbonds at the next epoch (the serious-tier
    // consequence the confirm copy states).
    const off = await runOperatorFlow(request, operator, {
      variant: "unregister_participation",
      contractAddress: contract,
      valoper: valoper!,
      claimantValoper: null,
      amount: 0n,
      denom: "nhash",
    });
    expect(off.preflightReasons).toEqual([]);
    expect(off.code).toBe(0);
    expect((await awaitInclusion(request, off.txhash!)).code).toBe(0);
    expect((await contractClient.validators()).some((v) => v.valoper === valoper)).toBe(false);

    // Re-enroll, restoring the devnet to the state other specs assume.
    const on = await runOperatorFlow(request, operator, {
      variant: "register_participation",
      contractAddress: contract,
      valoper: valoper!,
      claimantValoper: null,
      amount: 0n,
      denom: "nhash",
    });
    expect(on.preflightReasons).toEqual([]);
    expect(on.code).toBe(0);
    expect((await awaitInclusion(request, on.txhash!)).code).toBe(0);
    expect((await contractClient.validators()).some((v) => v.valoper === valoper)).toBe(true);
  });
});
