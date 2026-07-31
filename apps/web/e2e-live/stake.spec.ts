// e2e-live: the Stake (§8.3) fund-moving drill on devnet (plan 5.3). Beyond
// the raw lifecycle pass (lifecycle.spec.ts), this cross-checks the NAV
// PREVIEW math against reality: it prices the deposit with `previewSharesOut`
// from the live vault, executes a real swap-in, and asserts the actual
// minted nvHASH (balance delta) matches the preview — the §10.3 "preview at
// execution-time rate" honesty, proven against `EventSwapIn` economics.
//
// Needs the devnet stack + E2E_LIVE_SIGNER_KEY, E2E_LIVE_VAULT_ADDRESS,
// E2E_LIVE_LCD_URL; skips cleanly otherwise.

import { expect, test } from "@playwright/test";

import { BankClient, LcdClient, VaultClient } from "@nvhash/chain-client";

import { buildTxPlan, encodeTxRaw, type TxIntent } from "../app/tx/build";
import { previewSharesOut } from "../app/stake/preview";
import { DevnetTestSigner } from "./signer";

const KEY = process.env.E2E_LIVE_SIGNER_KEY;
const VAULT = process.env.E2E_LIVE_VAULT_ADDRESS;
const LCD = process.env.E2E_LIVE_LCD_URL;
test.skip(
  KEY === undefined || VAULT === undefined || LCD === undefined,
  "e2e-live env not set (E2E_LIVE_SIGNER_KEY / _VAULT_ADDRESS / _LCD_URL)",
);

const DEPOSIT = 1_000_000n; // 0.001 HASH

test("stake preview matches the minted nvHASH (execution-time rate honesty)", async ({
  request,
}) => {
  const signer = new DevnetTestSigner(KEY!);
  const lcd = new LcdClient(LCD!);
  const vaultClient = new VaultClient(lcd);
  const bank = new BankClient(lcd);

  // Live NAV pair + share denom before the deposit → the previewed shares.
  const before = await vaultClient.getVault(VAULT!);
  const shareDenom = before.vault.totalShares.denom;
  const preview = previewSharesOut(
    DEPOSIT,
    before.vault.totalShares.amount,
    before.totalVaultValue.amount,
  );
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;

  const balanceBefore = (await bank.balance(signer.address, shareDenom)).amount;

  // Session + full lifecycle (same HTTP surface the /stake page drives).
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

  const pf = (await (
    await request.post("/tx/preflight", { data: { kind: "swap_in", amount: DEPOSIT.toString() } })
  ).json()) as { reasons: unknown[]; denom: string };
  expect(pf.reasons).toEqual([]);

  const sim = (await (
    await request.post("/tx/simulate", {
      data: {
        kind: "swap_in",
        amount: DEPOSIT.toString(),
        denom: pf.denom,
        pubkey: signer.pubkeyBase64,
      },
    })
  ).json()) as {
    fee: { gas_limit: string; amount: string; denom: string };
    signer: { account_number: string; sequence: string; chain_id: string };
  };

  const intent: TxIntent = {
    kind: "swap_in",
    owner: signer.address,
    vaultAddress: VAULT!,
    amount: DEPOSIT,
    denom: pf.denom,
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

  // Wait for inclusion, then compare the minted shares to the preview.
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

  const balanceAfter = (await bank.balance(signer.address, shareDenom)).amount;
  const minted = balanceAfter - balanceBefore;
  // The mint is at execution-time NAV; absent an epoch crank between preview
  // and execution the two match exactly. Allow a tiny relative tolerance for
  // a concurrent state change on a shared devnet.
  const diff = minted > preview.shares ? minted - preview.shares : preview.shares - minted;
  expect(diff * 10_000n <= preview.shares).toBe(true); // within 0.01%
});
