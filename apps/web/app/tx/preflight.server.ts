// §10.2 step-2 preflight (app plan PR 5.2 §3): server-supplied guard
// context from LIVE reads — vault swap gates, min/max bounds, balance
// including fee, vesting lock, and the signer facts (account number /
// sequence / chain id) the sign doc needs. Every disabled control carries a
// machine-readable reason (the console R1 rule); UI preflight is
// convenience only — the CONTRACT remains the enforcement boundary
// (SECURITY.md), which is why a chain-read failure blocks with
// `chain-unavailable` rather than guessing.
//
// Amount inputs are validated and bounded HERE at the route boundary
// (zod + BigInt, reject-never-clamp; test/tx-preflight.test.ts drives the
// boundary matrix: 0, 1, min−1, max+1, > balance, non-numeric, floats).

import {
  AuthClient,
  BankClient,
  LcdClient,
  VaultClient,
  type FetchLike,
} from "@nvhash/chain-client";
import { z } from "zod";

import type { WebConfig } from "~/config/config.server";
import type { PreflightReason } from "./lifecycle";

/**
 * Fee provision the balance check reserves before simulation exists — a
 * deliberate over-estimate (2 HASH; a typical swap simulates to ~0.4 HASH
 * at 1905 nhash/gas × 1.3). The simulated fee replaces this at step 3; the
 * provision only prevents "preflight passed, then the fee made it fail".
 */
export const FEE_PROVISION_NHASH = 2_000_000_000n; // 2 HASH at exponent 9

export const preflightRequestSchema = z.object({
  kind: z.enum(["swap_in", "swap_out"]),
  /** base-unit amount as an integer decimal string — floats are a shape
   * error, not a rounding opportunity (reject, never clamp). */
  amount: z.string().regex(/^[0-9]{1,39}$/, "expected a base-unit integer string"),
});
export type PreflightRequest = z.infer<typeof preflightRequestSchema>;

export interface PreflightContext {
  reasons: PreflightReason[];
  /** Signer facts for buildTxPlan; null when the account does not exist. */
  signer: { accountNumber: string; sequence: string; chainId: string } | null;
  balance: string;
  denom: string;
}

export interface PreflightDeps {
  fetchImpl?: FetchLike;
}

/**
 * Run the preflight for a session-scoped intent. `address` comes from the
 * SESSION (the route passes requireSession's address — never client input).
 */
export async function runPreflight(
  config: WebConfig,
  address: string,
  request: PreflightRequest,
  deps: PreflightDeps = {},
): Promise<PreflightContext> {
  const lcd = new LcdClient(config.lcdUrl, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  const vaultClient = new VaultClient(lcd);
  const bank = new BankClient(lcd);
  const auth = new AuthClient(lcd);

  const reasons: PreflightReason[] = [];
  const amount = BigInt(request.amount);

  let vault, account, spendable;
  try {
    [vault, account, spendable] = await Promise.all([
      vaultClient.getVault(config.vaultAddress),
      auth.account(address),
      bank.spendableBalances(address),
    ]);
  } catch {
    // A failed live read blocks honestly: the App never renders a guess.
    return {
      reasons: [{ code: "chain-unavailable" }],
      signer: null,
      balance: "0",
      denom: "",
    };
  }

  const record = vault.vault;
  const denom = request.kind === "swap_in" ? record.underlyingAsset : record.totalShares.denom;

  // Vault gates (§10.3: never enabled while paused, with the reason).
  if (record.paused) reasons.push({ code: "vault-paused", detail: record.pausedReason });
  const enabled = request.kind === "swap_in" ? record.swapInEnabled : record.swapOutEnabled;
  if (!enabled && !record.paused) reasons.push({ code: "swaps-disabled" });

  // Amount bounds. Zero is invalid everywhere; vault min/max apply when set
  // (empty string = no bound, the client's parsing convention).
  if (amount <= 0n) reasons.push({ code: "amount-invalid" });
  const min = request.kind === "swap_in" ? record.minSwapInValue : record.minSwapOutValue;
  const max = request.kind === "swap_in" ? record.maxSwapInValue : record.maxSwapOutValue;
  if (min !== "" && amount < BigInt(min) && amount > 0n)
    reasons.push({ code: "below-minimum", minimum: min });
  if (max !== "" && amount > BigInt(max)) reasons.push({ code: "above-maximum", maximum: max });

  // Balance including fee (§10.2 step 2). Spendable subtracts vesting locks;
  // the fee always needs the underlying (nhash) side.
  const spend = (d: string): bigint =>
    spendable.balances.find((c) => c.denom === d)?.amount ?? 0n;
  const total = (d: string): bigint => spend(d); // spendable is the honest bound
  if (request.kind === "swap_in") {
    const required = amount + FEE_PROVISION_NHASH;
    const balance = total(denom);
    if (balance < required)
      reasons.push({
        code: "insufficient-balance",
        balance: balance.toString(),
        required: required.toString(),
      });
    // Vesting honesty (§8.3): a vesting account whose spendable balance is
    // short while a total balance exists is locked, and the UI says so.
    if (account?.isVesting === true && balance < required) {
      try {
        const totalBalance = await bank.balance(address, denom);
        if (totalBalance.amount >= required)
          reasons.push({ code: "vesting-locked", spendable: balance.toString() });
      } catch {
        // The primary insufficient-balance reason already stands.
      }
    }
  } else {
    const shares = total(denom);
    if (shares < amount)
      reasons.push({
        code: "insufficient-balance",
        balance: shares.toString(),
        required: amount.toString(),
      });
    const feeBalance = total(record.underlyingAsset);
    if (feeBalance < FEE_PROVISION_NHASH)
      reasons.push({
        code: "insufficient-balance",
        balance: feeBalance.toString(),
        required: FEE_PROVISION_NHASH.toString(),
      });
  }

  if (account === null) reasons.push({ code: "account-missing" });

  return {
    reasons,
    signer:
      account === null
        ? null
        : {
            accountNumber: account.accountNumber.toString(),
            sequence: account.sequence.toString(),
            chainId: config.chainId,
          },
    balance: total(denom).toString(),
    denom,
  };
}
