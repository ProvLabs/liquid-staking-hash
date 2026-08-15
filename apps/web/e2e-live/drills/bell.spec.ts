// The drill → notifier tick → bell chain, end to end (8.1 §2.9, CO-14 — the
// M6.2 deviation-2 chain, undischargeable until commit C made the stack
// whole). Every hop is the production implementation: a real SwapOut through
// the app's own HTTP surface → services/api's internal alert-facts read → the
// notifier service's tick → a Postgres notification row as app_writer → the
// bell's own data route. There is no in-memory double anywhere (§4b C7): stop
// the notifier service, or point web at the in-memory store, and this fails.
//
// Run by the driver's `bell` phase; standalone-skippable like its siblings.

import { expect, test } from "@playwright/test";

import { BankClient, LcdClient, VaultClient } from "@nvhash/chain-client";

import { buildTxPlan, encodeTxRaw, type TxIntent } from "../../app/tx/build";
import { DevnetTestSigner } from "../signer";
import { onlyInPhase } from "./phase";

const KEY = process.env.E2E_LIVE_SIGNER_KEY;
const VAULT = process.env.E2E_LIVE_VAULT_ADDRESS;
const LCD = process.env.E2E_LIVE_LCD_URL;

/** ≤ 2 ticks at the stack's NOTIFIER_TICK_SECONDS=10, plus indexing margin —
 * a bounded wait that FAILS, never an unbounded "eventually" (§4b C6). */
const BELL_WAIT_MS = 60_000;

test.describe("bell drill (CO-14)", () => {
  onlyInPhase("bell");
  test.skip(
    KEY === undefined || VAULT === undefined || LCD === undefined,
    "e2e-live env not set (E2E_LIVE_SIGNER_KEY / _VAULT_ADDRESS / _LCD_URL)",
  );

  test("a real redemption reaches the bell through the notifier within two ticks", async ({
    request,
  }) => {
    const signer = new DevnetTestSigner(KEY!);
    const lcd = new LcdClient(LCD!);
    const bank = new BankClient(lcd);
    const vaultClient = new VaultClient(lcd);

    // Session through the app's own login path (the alerts.spec pattern).
    const { nonce, challenge } = (await (
      await request.post("/session/nonce", { data: { address: signer.address } })
    ).json()) as { nonce: string; challenge: string };
    const loginRes = await request.post("/session/login", {
      data: {
        address: signer.address,
        nonce,
        pubkey: signer.pubkeyBase64,
        signature: signer.signChallenge(challenge),
      },
    });
    expect(loginRes.ok()).toBe(true);

    // The redemption drill leg (the redeem.spec machinery): a real SwapOut.
    const shareDenom = (await vaultClient.getVault(VAULT!)).vault.totalShares.denom;
    const shareBalance = (await bank.balance(signer.address, shareDenom)).amount;
    expect(
      shareBalance,
      "the drill signer holds no nvHASH — run the stake drill leg first",
    ).toBeGreaterThan(0n);
    const redeemShares = shareBalance < 1_000_000n ? shareBalance : 1_000_000n;

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
      await request.post("/tx/broadcast", {
        data: { tx_raw: Buffer.from(txRaw).toString("base64") },
      })
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

    // The chain: indexer ingests the lifecycle event → the notifier's next
    // tick reads it through the API's internal scope → a notification row →
    // the bell's own data route. redemption_update is DEFAULT-ON (spec R2),
    // so no opt-in step belongs here — that default is part of the claim.
    const deadline = Date.now() + BELL_WAIT_MS;
    let found = false;
    while (Date.now() < deadline) {
      const res = await request.get("/alerts/notifications");
      if (res.ok()) {
        const body = (await res.json()) as {
          notifications?: Array<{ kind: string }>;
          unread?: number;
        };
        if ((body.notifications ?? []).some((n) => n.kind === "redemption_update")) {
          found = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    expect(
      found,
      "no redemption_update notification reached the bell within two notifier ticks — " +
        "the notifier service is down, unkeyed, or web is on the in-memory store",
    ).toBe(true);
  });
});
