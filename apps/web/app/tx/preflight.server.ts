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
import { OPERATOR_VARIANTS } from "./build";
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

/** Valoper shape, bounded at the route boundary like every other input. */
const valoperString = z
  .string()
  .max(90)
  .regex(/^[a-z]{1,10}valoper1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,83}$/);

/** M6.4 operator preflight (§2.4). `amount` is required only for payments. */
export const operatorPreflightRequestSchema = z.object({
  kind: z.literal("operator"),
  variant: z.enum(OPERATOR_VARIANTS),
  valoper: valoperString,
  claimantValoper: valoperString.nullable().default(null),
  amount: z.string().regex(/^[0-9]{1,39}$/, "expected a base-unit integer string").default("0"),
});
export type OperatorPreflightRequest = z.infer<typeof operatorPreflightRequestSchema>;

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

// ── M6.4 operator preflight (§2.4) ───────────────────────────────────────
//
// Every predicate below RESTATES one the contract already enforces. That is
// the point and the limit: preflight is convenience (§12.1, SECURITY.md "UI
// guards are convenience, the contract is the enforcement boundary"), so it
// never gates safety — it explains, in advance, why an action would fail. A
// failed chain read therefore blocks with `chain-unavailable` instead of
// optimistically letting the action through OR silently hiding it.

/** The live facts the operator predicates read. Separated from the I/O so the
 * predicate matrix is a pure function the tests drive directly. */
export interface OperatorPreflightFacts {
  /** The acting address, from the SESSION (never client input). */
  address: string;
  /** The contract's enrolled set, or null when the read failed. */
  validators:
    | readonly {
        valoper: string;
        operator: string;
        jailed: boolean;
        commissionDue: bigint;
        commissionPaid: bigint;
      }[]
    | null;
  /** Open jail reports, or null when the read failed. */
  jailReports: readonly { valoper: string; purgeReadyAtSeconds: number }[] | null;
  /** Whether the target valoper exists in x/staking, and its jailed flag. */
  chainValidator: { exists: boolean; jailed: boolean } | null;
  /** The program's halt state (the purge leg is halt-gated). */
  halted: boolean | null;
  /** Spendable nhash for the payment + fee check. */
  spendableNhash: bigint | null;
  nowSeconds: number;
}

/**
 * The operator predicate matrix — pure over live facts. Ordering is
 * deliberate: an unavailable read short-circuits everything, because a reason
 * derived from a missing fact would be a guess.
 */
export function operatorPreflightReasons(
  request: OperatorPreflightRequest,
  facts: OperatorPreflightFacts,
): PreflightReason[] {
  if (facts.validators === null || facts.chainValidator === null) {
    return [{ code: "chain-unavailable" }];
  }
  const reasons: PreflightReason[] = [];
  const enrolled = facts.validators.find((v) => v.valoper === request.valoper) ?? null;
  const amount = BigInt(request.amount);

  switch (request.variant) {
    case "register_participation": {
      // The contract requires the caller to BE the valoper's operator account
      // and the validator to exist on chain.
      if (!facts.chainValidator.exists) reasons.push({ code: "validator-not-found" });
      if (enrolled !== null) reasons.push({ code: "already-enrolled" });
      break;
    }
    case "unregister_participation": {
      if (enrolled === null) reasons.push({ code: "not-enrolled" });
      else if (enrolled.operator !== facts.address) reasons.push({ code: "not-validator-operator" });
      break;
    }
    case "pay_commission":
    case "pay_tip": {
      // Payment is permissionless — anyone may pay — so there is deliberately
      // NO operator check here; only enrollment and the amount bounds.
      if (enrolled === null) reasons.push({ code: "not-enrolled" });
      if (amount <= 0n) reasons.push({ code: "amount-invalid" });
      if (facts.spendableNhash !== null && amount > 0n) {
        const required = amount + FEE_PROVISION_NHASH;
        if (facts.spendableNhash < required) {
          reasons.push({
            code: "insufficient-balance",
            balance: facts.spendableNhash.toString(),
            required: required.toString(),
          });
        }
      }
      break;
    }
    case "report_jailed_validator": {
      // Permissionless, but pointless unless the validator is actually jailed
      // — and the contract CLEARS an existing report when it is not.
      if (!facts.chainValidator.jailed) reasons.push({ code: "validator-not-jailed" });
      if (enrolled === null) reasons.push({ code: "not-enrolled" });
      break;
    }
    case "purge_jailed_validator": {
      if (!facts.chainValidator.jailed) reasons.push({ code: "validator-not-jailed" });
      const report = (facts.jailReports ?? []).find((r) => r.valoper === request.valoper) ?? null;
      if (facts.jailReports !== null && report === null) {
        reasons.push({ code: "no-jail-report" });
      } else if (report !== null && facts.nowSeconds < report.purgeReadyAtSeconds) {
        reasons.push({
          code: "purge-cooldown",
          readyAtIso: new Date(report.purgeReadyAtSeconds * 1_000).toISOString(),
        });
      }
      // Phase 2 moves funds and is halt-gated (contract msg.rs).
      if (facts.halted === true) reasons.push({ code: "program-halted" });
      break;
    }
  }
  return reasons;
}
