// e2e-live: one full §10.2 lifecycle pass on devnet —
// preflight → simulate → build → sign (test process) → guarded relay →
// track to inclusion → indexer fast-poll. A REAL fund-moving swap-in of a
// tiny amount from the throwaway devnet account; flow-level drill specs
// (stake/redeem pages, every redemption terminal state) arrive with
// 5.3/5.4.

import { expect, test } from "@playwright/test";

import { buildTxPlan, encodeTxRaw, type TxIntent } from "../app/tx/build";
import { DevnetTestSigner } from "./signer";

const KEY = process.env.E2E_LIVE_SIGNER_KEY;
test.skip(KEY === undefined, "E2E_LIVE_SIGNER_KEY not set (needs the devnet stack)");

/** 0.001 HASH — enough to move funds for real, small enough to not matter. */
const SWAP_IN_AMOUNT = 1_000_000n;

test("preflight → simulate → sign → relay → inclusion → reconcile", async ({ request }) => {
  const signer = new DevnetTestSigner(KEY!);

  // Session (the relay is session-gated).
  const { nonce, challenge } = (await (
    await request.post("/session/nonce", { data: { address: signer.address } })
  ).json()) as { nonce: string; challenge: string };
  const login = await request.post("/session/login", {
    data: {
      address: signer.address,
      nonce,
      pubkey: signer.pubkeyBase64,
      signature: signer.signChallenge(challenge),
    },
  });
  expect(login.ok()).toBe(true);

  // Preflight: reasons must be empty for the funded devnet account.
  const preflight = await request.post("/tx/preflight", {
    data: { kind: "swap_in", amount: SWAP_IN_AMOUNT.toString() },
  });
  expect(preflight.ok()).toBe(true);
  const guard = (await preflight.json()) as {
    reasons: unknown[];
    signer: { accountNumber: string; sequence: string; chainId: string } | null;
    denom: string;
  };
  expect(guard.reasons).toEqual([]);
  expect(guard.signer).not.toBeNull();

  // Simulate for the real fee.
  const simulate = await request.post("/tx/simulate", {
    data: {
      kind: "swap_in",
      amount: SWAP_IN_AMOUNT.toString(),
      denom: guard.denom,
      pubkey: signer.pubkeyBase64,
    },
  });
  expect(simulate.ok()).toBe(true);
  const sim = (await simulate.json()) as {
    fee: { gas_limit: string; amount: string; denom: string };
    signer: { account_number: string; sequence: string; chain_id: string };
  };

  // Build the plan EXACTLY as the flow will (shared construction site),
  // sign the sign-doc bytes in this process, assemble TxRaw.
  const intent: TxIntent = {
    kind: "swap_in",
    owner: signer.address,
    vaultAddress: process.env.E2E_LIVE_VAULT_ADDRESS ?? "",
    amount: SWAP_IN_AMOUNT,
    denom: guard.denom,
  };
  test.skip(intent.vaultAddress === "", "E2E_LIVE_VAULT_ADDRESS not set");
  const plan = buildTxPlan(
    intent,
    {
      gasLimit: BigInt(sim.fee.gas_limit),
      amount: BigInt(sim.fee.amount),
      denom: sim.fee.denom,
    },
    {
      chainId: sim.signer.chain_id,
      accountNumber: BigInt(sim.signer.account_number),
      sequence: BigInt(sim.signer.sequence),
      pubkeyBase64: signer.pubkeyBase64,
    },
  );
  const signature = signer.signDirect(plan.signDocBytes);
  const txRaw = encodeTxRaw(plan.bodyBytes, plan.authInfoBytes, [signature]);

  // Guarded relay.
  const broadcast = await request.post("/tx/broadcast", {
    data: { tx_raw: Buffer.from(txRaw).toString("base64") },
  });
  expect(broadcast.ok()).toBe(true);
  const { txhash, code } = (await broadcast.json()) as { txhash: string; code: number };
  expect(code).toBe(0);

  // Track to inclusion.
  let included: { included: boolean; code?: number } = { included: false };
  for (let attempt = 0; attempt < 30 && !included.included; attempt += 1) {
    included = (await (await request.get(`/tx/status?hash=${txhash}`)).json()) as {
      included: boolean;
      code?: number;
    };
    if (!included.included) await new Promise((r) => setTimeout(r, 2_000));
  }
  expect(included.included).toBe(true);
  expect(included.code).toBe(0);

  // Indexer fast-poll reconcile: the indexed row lands within the window.
  let reconciled = false;
  for (let attempt = 0; attempt < 15 && !reconciled; attempt += 1) {
    const recent = (await (await request.get("/tx/recent")).json()) as {
      available: boolean;
      txhashes: string[];
    };
    reconciled = recent.available && recent.txhashes.includes(txhash);
    if (!reconciled) await new Promise((r) => setTimeout(r, 2_000));
  }
  expect(reconciled).toBe(true);
});
