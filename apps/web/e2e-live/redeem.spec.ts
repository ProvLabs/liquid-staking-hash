// e2e-live: the Redeem & Exit (§8.4) fund-moving drill on devnet (plan 5.4).
// A real SwapOut through the same HTTP surface the /exit page drives, then
// asserts the redemption tracker renders it from the on-chain queue +
// /portfolio. The terminal states (expedited / matured-paid / unfunded
// refund) render from real drill history — run against a stack that has
// executed `contracts/drills/p2p-drill.sh` (expedite + maturity legs) and the
// 0.2 corpus refund leg; those assertions activate when that history is
// present (E2E_LIVE_DRILL_HISTORY=1).
//
// Needs the devnet stack + E2E_LIVE_SIGNER_KEY / _VAULT_ADDRESS / _LCD_URL;
// skips cleanly otherwise.

import { expect, test } from "@playwright/test";

import { BankClient, LcdClient, VaultClient } from "@nvhash/chain-client";

import { buildTxPlan, encodeTxRaw, type TxIntent } from "../app/tx/build";
import { DevnetTestSigner } from "./signer";

const KEY = process.env.E2E_LIVE_SIGNER_KEY;
const VAULT = process.env.E2E_LIVE_VAULT_ADDRESS;
const LCD = process.env.E2E_LIVE_LCD_URL;
test.skip(
  KEY === undefined || VAULT === undefined || LCD === undefined,
  "e2e-live env not set (E2E_LIVE_SIGNER_KEY / _VAULT_ADDRESS / _LCD_URL)",
);

async function login(
  request: import("@playwright/test").APIRequestContext,
  signer: DevnetTestSigner,
) {
  const { nonce, challenge } = (await (
    await request.post("/session/nonce", { data: { address: signer.address } })
  ).json()) as { nonce: string; challenge: string };
  await request.post("/session/login", {
    data: {
      address: signer.address,
      nonce,
      pubkey: signer.pubkeyBase64,
      signature: signer.signChallenge(challenge),
    },
  });
}

test("redeem enqueues a SwapOut and the tracker renders it from the chain queue", async ({
  request,
  browser,
}) => {
  const signer = new DevnetTestSigner(KEY!);
  const lcd = new LcdClient(LCD!);
  const bank = new BankClient(lcd);
  const vaultClient = new VaultClient(lcd);

  const shareDenom = (await vaultClient.getVault(VAULT!)).vault.totalShares.denom;
  const shareBalance = (await bank.balance(signer.address, shareDenom)).amount;
  test.skip(shareBalance <= 0n, "account holds no nvHASH to redeem (run the stake drill first)");
  const redeemShares = shareBalance < 1_000_000n ? shareBalance : 1_000_000n;

  await login(request, signer);

  const pf = (await (
    await request.post("/tx/preflight", {
      data: { kind: "swap_out", amount: redeemShares.toString() },
    })
  ).json()) as { reasons: unknown[]; denom: string };
  expect(pf.reasons).toEqual([]);

  const sim = (await (
    await request.post("/tx/simulate", {
      data: {
        kind: "swap_out",
        amount: redeemShares.toString(),
        denom: pf.denom,
        pubkey: signer.pubkeyBase64,
        redeemDenom: "",
      },
    })
  ).json()) as {
    fee: { gas_limit: string; amount: string; denom: string };
    signer: { account_number: string; sequence: string; chain_id: string };
  };

  const intent: TxIntent = {
    kind: "swap_out",
    owner: signer.address,
    vaultAddress: VAULT!,
    amount: redeemShares,
    denom: pf.denom,
    redeemDenom: "",
  };
  const plan = buildTxPlan(
    intent,
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
  const broadcast = (await (
    await request.post("/tx/broadcast", { data: { tx_raw: Buffer.from(txRaw).toString("base64") } })
  ).json()) as { txhash: string; code: number };
  expect(broadcast.code).toBe(0);

  for (let i = 0; i < 30; i += 1) {
    const status = (await (await request.get(`/tx/status?hash=${broadcast.txhash}`)).json()) as {
      included: boolean;
      code?: number;
    };
    if (status.included) {
      expect(status.code).toBe(0);
      break;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  // The redemption is now in the on-chain queue: the /exit tracker must show
  // it as enqueued for this session address.
  const cookie = (await request.storageState()).cookies.find((c) => c.name === "nvhash_session");
  const context = await browser.newContext();
  if (cookie) {
    await context.addCookies([
      {
        name: "nvhash_session",
        value: cookie.value,
        url: process.env.E2E_LIVE_BASE_URL ?? "http://localhost:3000",
      },
    ]);
  }
  const page = await context.newPage();
  await page.goto("/exit");
  await expect(page.getByText("Your redemptions", { exact: false })).toBeVisible();
  await expect(page.getByText(/In the redemption queue|Expedited/)).toBeVisible();

  if (process.env.E2E_LIVE_DRILL_HISTORY === "1") {
    // With p2p-drill history present, the tracker also renders terminal legs.
    await expect(page.getByText(/Paid out|Refunded/)).toBeVisible();
  }
  await context.close();
});
