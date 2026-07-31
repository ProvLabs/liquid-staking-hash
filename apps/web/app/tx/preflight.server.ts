// §10.2 step-2 preflight: server-supplied guard
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
  NvhashContractClient,
  StakingClient,
  VaultClient,
  type FetchLike,
} from "@nvhash/chain-client";
import { z } from "zod";

import {
  MAX_BECH32_LENGTH,
  MAX_PROPOSAL_METADATA_LEN,
  MAX_PROPOSAL_SUMMARY_LEN,
  MAX_PROPOSAL_TITLE_LEN,
} from "@nvhash/api-types";

import { executableAtIso } from "~/governance/actions";
import { describeTemplateError, parseTemplateValues } from "~/governance/templates";
import {
  loadLiveGovernance,
  loadLiveProposal,
  loadLiveVotes,
} from "~/lib/services/governance.server";
import { VALOPER_RE } from "~/lib/bech32";
import { sameBech32Payload } from "~/lib/adr36-verify.server";
import type { WebConfig } from "~/config/config.server";
import {
  GOVERNANCE_VOTE_OPTION_NAMES,
  OPERATOR_VARIANTS,
  PROGRAM_UNDERLYING_DENOM,
} from "./build";
import type { PreflightReason } from "./lifecycle";

/**
 * Fee provision the balance check reserves before simulation exists. The
 * simulated fee replaces it at step 3; the provision exists only to prevent
 * "preflight passed, then the fee made it fail".
 *
 * Sized against the REAL fee basis (`simulate.server.ts`: 1 nhash/gas under
 * Provenance flat fees, so a fee in nhash is just the gas limit): the heaviest
 * transaction in this program's scripts runs ~4M gas, ≈ 0.004 HASH, so 0.05
 * HASH is better than 10× headroom. It is deliberately NOT larger — a
 * provision is subtracted from what the user may swap, so an inflated one
 * reports `insufficient-balance` for a transaction they can comfortably
 * afford. (This was 2 HASH while the gas price was wrongly 1905 nhash; both
 * numbers came from the pre-flat-fee model and both were wrong.)
 */
export const FEE_PROVISION_NHASH = 50_000_000n; // 0.05 HASH at exponent 9

/**
 * The contract's enrolment ceiling (`MAX_VALIDATORS`,
 * `contracts/src/validators.rs`) — mirrored here only so preflight can restate
 * the rejection `register` would produce. A change to the contract constant
 * changes this one in the same change.
 */
export const MAX_PROGRAM_VALIDATORS = 100;

export const preflightRequestSchema = z.object({
  kind: z.enum(["swap_in", "swap_out"]),
  /** base-unit amount as an integer decimal string — floats are a shape
   * error, not a rounding opportunity (reject, never clamp). */
  amount: z.string().regex(/^[0-9]{1,39}$/, "expected a base-unit integer string"),
});
export type PreflightRequest = z.infer<typeof preflightRequestSchema>;

/** Valoper shape, bounded at the route boundary like every other input. */
const valoperString = z.string().max(90).regex(VALOPER_RE);

/** M6.4 operator preflight (§2.4). `amount` is required only for payments. */
export const operatorPreflightRequestSchema = z.object({
  kind: z.literal("operator"),
  variant: z.enum(OPERATOR_VARIANTS),
  valoper: valoperString,
  claimantValoper: valoperString.nullable().default(null),
  amount: z.string().regex(/^[0-9]{1,39}$/, "expected a base-unit integer string").default("0"),
});
export type OperatorPreflightRequest = z.infer<typeof operatorPreflightRequestSchema>;

/**
 * M7.3–7.4 governance preflight (§2.5). A separate BOUNDED schema, never a
 * widened one — the M6.4 precedent, and the reason a governance request can
 * never be parsed as a swap or an operator action by accident.
 *
 * The proposal id stays a canonical DECIMAL STRING (`params.ts`'s rule): x/group
 * ids are u64 and the JSON number domain stops at 2^53, and one proposal must
 * not be addressable by two spellings.
 */
const proposalIdString = z.string().max(20).regex(/^(0|[1-9][0-9]*)$/);
const bech32String = z.string().max(MAX_BECH32_LENGTH);

export const governancePreflightRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("gov_vote"),
    proposalId: proposalIdString,
    option: z.enum(GOVERNANCE_VOTE_OPTION_NAMES),
  }),
  z.object({ kind: z.literal("gov_exec"), proposalId: proposalIdString }),
  z.object({
    kind: z.literal("gov_submit"),
    policyAddress: bech32String,
    templateId: z.string().max(64),
    // Values are `string | boolean` on the wire and converted by the REGISTRY
    // (`parseTemplateValues`), not here: the boundary must not become a second
    // place that decides what a template's parameters are (invariant 6).
    values: z.record(z.string().max(64), z.union([z.string().max(1_024), z.boolean()])),
    title: z.string().min(1).max(MAX_PROPOSAL_TITLE_LEN),
    summary: z.string().min(1).max(MAX_PROPOSAL_SUMMARY_LEN),
    metadata: z.string().max(MAX_PROPOSAL_METADATA_LEN).default(""),
  }),
]);
export type GovernancePreflightRequest = z.infer<typeof governancePreflightRequestSchema>;

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

// ── Operator preflight (§2.4) ───────────────────────────────────────
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

/** The one honest answer when a fact this variant CONSUMES is missing. */
const chainUnavailable = (): PreflightReason[] => [{ code: "chain-unavailable" }];

/**
 * The operator predicate matrix — pure over live facts. Ordering is
 * deliberate: an unavailable read short-circuits everything, because a reason
 * derived from a missing fact would be a guess.
 *
 * `validators` and `chainValidator` are consumed by every variant, so they
 * short-circuit up front. `jailReports`, `halted`, and `spendableNhash` are
 * consumed by SOME variants, so each branch short-circuits on the facts IT
 * reads — a branch that instead skipped its check on a null would return an
 * empty (green) reason list for an action the contract then rejects, which is
 * exactly the "silently hiding it" this module's contract forbids.
 */
export function operatorPreflightReasons(
  request: OperatorPreflightRequest,
  facts: OperatorPreflightFacts,
): PreflightReason[] {
  if (facts.validators === null || facts.chainValidator === null) {
    return chainUnavailable();
  }
  const reasons: PreflightReason[] = [];
  const enrolled = facts.validators.find((v) => v.valoper === request.valoper) ?? null;
  const amount = BigInt(request.amount);

  switch (request.variant) {
    case "register_participation": {
      // The contract requires the caller to BE the valoper's operator account,
      // the validator to exist on chain, not to be enrolled already, and the
      // enrolled set to be under its ceiling. All four are restated.
      //
      // The operator check needs NO chain read: `is_operator` compares the
      // decoded bech32 payloads of caller and valoper, which is a local fact.
      if (!sameBech32Payload(facts.address, request.valoper)) {
        reasons.push({ code: "not-validator-operator" });
      }
      if (!facts.chainValidator.exists) reasons.push({ code: "validator-not-found" });
      if (enrolled !== null) reasons.push({ code: "already-enrolled" });
      if (facts.validators.length >= MAX_PROGRAM_VALIDATORS) {
        reasons.push({ code: "too-many-validators", max: MAX_PROGRAM_VALIDATORS });
      }
      break;
    }
    case "unregister_participation": {
      // The contract also accepts the program ADMIN here, which this predicate
      // deliberately does not model: /validators/mine is an operator surface
      // and has no admin persona, so an admin sees a reason that does not apply
      // to them rather than the App growing an admin path it does not serve.
      if (enrolled === null) reasons.push({ code: "not-enrolled" });
      else if (enrolled.operator !== facts.address) reasons.push({ code: "not-validator-operator" });
      break;
    }
    case "pay_commission":
    case "pay_tip": {
      // Payment is permissionless — anyone may pay — so there is deliberately
      // NO operator check here; only enrollment and the amount bounds.
      if (enrolled === null) reasons.push({ code: "not-enrolled" });
      if (amount <= 0n) {
        // A zero payment is invalid on its own terms; no balance to weigh.
        reasons.push({ code: "amount-invalid" });
        break;
      }
      // The balance fact is CONSUMED from here on, so its absence blocks.
      if (facts.spendableNhash === null) return chainUnavailable();
      const required = amount + FEE_PROVISION_NHASH;
      if (facts.spendableNhash < required) {
        reasons.push({
          code: "insufficient-balance",
          balance: facts.spendableNhash.toString(),
          required: required.toString(),
        });
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
      // This branch alone consumes the report list AND the halt flag, so both
      // block when missing: without them there is no honest answer to "is
      // phase 1 done, has the cooldown run, is the program halted".
      if (facts.jailReports === null || facts.halted === null) return chainUnavailable();
      if (!facts.chainValidator.jailed) reasons.push({ code: "validator-not-jailed" });
      const report = facts.jailReports.find((r) => r.valoper === request.valoper) ?? null;
      if (report === null) {
        reasons.push({ code: "no-jail-report" });
      } else if (facts.nowSeconds < report.purgeReadyAtSeconds) {
        reasons.push({
          code: "purge-cooldown",
          readyAtIso: new Date(report.purgeReadyAtSeconds * 1_000).toISOString(),
        });
      }
      // Phase 2 moves funds and is halt-gated (contract msg.rs).
      if (facts.halted) reasons.push({ code: "program-halted" });
      break;
    }
  }
  return reasons;
}

/**
 * Run the operator preflight for a session-scoped action. Same contract as
 * `runPreflight`: the acting address comes from the SESSION, every read is
 * live, and a failed read blocks with `chain-unavailable` rather than a guess.
 */
export async function runOperatorPreflight(
  config: WebConfig,
  address: string,
  request: OperatorPreflightRequest,
  deps: PreflightDeps = {},
): Promise<PreflightContext> {
  const lcd = new LcdClient(config.lcdUrl, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  const contract = new NvhashContractClient(lcd, config.contractAddress);
  const staking = new StakingClient(lcd);
  const bank = new BankClient(lcd);
  const auth = new AuthClient(lcd);

  const [validators, jailReports, epochStatus, stakingSet, account, spendable] = await Promise.all([
    contract.validators().catch(() => null),
    contract.jailReports().catch(() => null),
    contract.epochStatus().catch(() => null),
    staking.validators().catch(() => null),
    auth.account(address).catch(() => null),
    bank.spendableBalances(address).catch(() => null),
  ]);

  const chainValidator =
    stakingSet === null
      ? null
      : (() => {
          const found = stakingSet.validators.find((v) => v.operatorAddress === request.valoper);
          return { exists: found !== undefined, jailed: found?.jailed ?? false };
        })();

  const reasons = operatorPreflightReasons(request, {
    address,
    validators:
      validators === null
        ? null
        : validators.map((v) => ({
            valoper: v.valoper,
            operator: v.operator,
            jailed: v.jailed,
            commissionDue: v.commissionDue,
            commissionPaid: v.commissionPaid,
          })),
    jailReports:
      jailReports === null
        ? null
        : jailReports.map((r) => ({
            valoper: r.valoper,
            purgeReadyAtSeconds: r.purgeReadyAtSeconds,
          })),
    chainValidator,
    halted: epochStatus?.halted ?? null,
    spendableNhash:
      spendable === null
        ? null
        : (spendable.balances.find((c) => c.denom === PROGRAM_UNDERLYING_DENOM)?.amount ?? 0n),
    nowSeconds: Math.floor(Date.now() / 1000),
  });

  if (account === null && !reasons.some((r) => r.code === "chain-unavailable")) {
    reasons.push({ code: "account-missing" });
  }

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
    balance: (
      spendable?.balances.find((c) => c.denom === PROGRAM_UNDERLYING_DENOM)?.amount ?? 0n
    ).toString(),
    denom: PROGRAM_UNDERLYING_DENOM,
  };
}

// ── M7.3–7.4 governance preflight (§2.5) ─────────────────────────────────
//
// Same contract as the operator matrix above, and the same limit. Every
// predicate RESTATES one the x/group module or the contract already enforces,
// so preflight is convenience (§12.1, SECURITY.md "UI guards are convenience,
// the contract is the enforcement boundary"): it explains, in advance, why an
// action would fail. It never gates safety, a would-fail reason is never an
// authorization claim, and a PASSING preflight never implies acceptance — the
// module decides, and `test/tx-preflight.test.ts` holds a
// preflight-passes-chain-rejects case saying so.
//
// A failed read of a fact this branch CONSUMES blocks, rather than returning an
// empty (green) reason list for an action the chain then rejects.

/** The live facts the governance predicates read. Separated from the I/O so the
 * matrix is a pure function the tests drive directly. */
export interface GovernancePreflightFacts {
  /** The acting address, from the SESSION (never client input). */
  address: string;
  /**
   * The live proposal, or null when the chain could not serve it.
   *
   * Null is DELIBERATELY AMBIGUOUS and treated as "we could not read it": the
   * LCD answers a missing proposal with HTTP 500, byte-identical for a pruned
   * id, a never-existing id and a node outage (7.2's pinned fact). So the reason
   * is `proposal-not-found` — "we could not read this proposal" — and never
   * `proposal-pruned`, which is a claim only the mirror can make.
   */
  proposal: {
    status: string;
    executorResult: string;
    submitTime: string;
    votingPeriodEnd: string;
  } | null;
  /** Whether the live plane resolved at all. False → `governance-unavailable`. */
  governanceResolved: boolean;
  /** The DISCOVERED program policies; null when the sweep failed. */
  policyAddresses: readonly string[] | null;
  /** The live member set, or null when that read failed. */
  memberAddresses: readonly string[] | null;
  /** Voters with a recorded vote on this proposal, or null when unread. */
  voters: readonly { voter: string; option: string }[] | null;
  /** The proposal's policy `min_execution_period`, as x/group serializes it. */
  minExecutionPeriod: string | null;
  /**
   * The program's live `Config {}`, keyed by parameter name; null when the read
   * failed. Consumed ONLY by the `update_config` cross-field rule below, so its
   * absence blocks only there.
   */
  currentConfig: Readonly<Record<string, bigint>> | null;
  /** Spendable nhash for the fee check. */
  spendableNhash: bigint | null;
  nowMs: number;
}

const governanceUnavailable = (): PreflightReason[] => [{ code: "governance-unavailable" }];

/**
 * The governance predicate matrix — pure over live facts.
 *
 * Ordering is deliberate, exactly as the operator matrix's is: an unavailable
 * read short-circuits before any reason derived from a missing fact could be
 * produced.
 */
export function governancePreflightReasons(
  request: GovernancePreflightRequest,
  facts: GovernancePreflightFacts,
): PreflightReason[] {
  if (!facts.governanceResolved) return governanceUnavailable();
  const reasons: PreflightReason[] = [];

  // The fee is owed on every one of the three, and none of them moves value
  // otherwise — so the balance check is shared and the amount is the provision.
  const feeReasons = (): PreflightReason[] => {
    if (facts.spendableNhash === null) return [{ code: "chain-unavailable" }];
    return facts.spendableNhash < FEE_PROVISION_NHASH
      ? [
          {
            code: "insufficient-balance" as const,
            balance: facts.spendableNhash.toString(),
            required: FEE_PROVISION_NHASH.toString(),
          },
        ]
      : [];
  };

  if (request.kind === "gov_submit") {
    // Submission consumes the policy set and the member set; both block.
    if (facts.policyAddresses === null || facts.memberAddresses === null) {
      return governanceUnavailable();
    }
    // CONVENIENCE ONLY, and this is the one place worth saying so twice: the
    // RELAY does not check this (§12.3 amendment, revised 2026-07-30 — a
    // proposal to another group's policy grants its proposer nothing and still
    // needs that group to pass it). Telling a composer that they picked an
    // address this program does not govern is a courtesy that costs nothing,
    // because the member read below already loaded the policy set.
    if (!facts.policyAddresses.includes(request.policyAddress)) {
      reasons.push({ code: "policy-not-found" });
    }
    if (!facts.memberAddresses.includes(facts.address)) {
      reasons.push({ code: "not-group-member" });
    }
    // The template's own bounds, restated from the registry rather than
    // re-declared here. A failure is a shape error the user must fix.
    const parsed = parseTemplateValues(request.templateId, request.values);
    if (!parsed.ok) {
      reasons.push({
        code: "template-invalid",
        detail: parsed.errors.map(describeTemplateError).join("; "),
      });
      return [...reasons, ...feeReasons()];
    }
    // THE ONE CONTRACT RULE A PER-FIELD BOUND CANNOT EXPRESS.
    // `Config::validate` requires `min_bonded_cap_bps <= max_bonded_cap_bps`
    // AFTER the merge, so it depends on the CURRENT config for whichever of the
    // two the proposal leaves unsupplied. The template registry therefore
    // cannot carry it (a template bound is per-field and config-free), and it is
    // restated here — the one place with a live `Config {}` read.
    //
    // A proposal violating it would pass every template bound, pass the relay
    // guard (which checks form, not merged semantics), reach a vote, and fail at
    // EXECUTION — the worst place to discover it, since the group has already
    // spent its voting period. Surfacing it before signing is exactly what §2.5
    // means by a would-fail reason.
    if (request.templateId === "update_config") {
      const supplied = parsed.values;
      const minKey = "min_bonded_cap_bps";
      const maxKey = "max_bonded_cap_bps";
      const suppliesEither = minKey in supplied || maxKey in supplied;
      if (suppliesEither) {
        if (facts.currentConfig === null) {
          // The fact is CONSUMED from here on, so its absence blocks rather
          // than returning a green list for a proposal that may be invalid.
          return [{ code: "chain-unavailable" }];
        }
        const merged = (key: string): bigint =>
          (supplied[key] as bigint | undefined) ?? facts.currentConfig![key] ?? 0n;
        if (merged(minKey) > merged(maxKey)) {
          reasons.push({
            code: "template-invalid",
            detail: `"${minKey}" must be <= "${maxKey}" after the change (${merged(minKey)} > ${merged(maxKey)})`,
          });
        }
      }
    }
    return [...reasons, ...feeReasons()];
  }

  // Both vote and exec consume the live proposal.
  if (facts.proposal === null) {
    reasons.push({ code: "proposal-not-found" });
    return reasons;
  }
  const { status, executorResult, submitTime, votingPeriodEnd } = facts.proposal;

  if (request.kind === "gov_vote") {
    // The module rejects a vote outside the voting period and from a non-member,
    // and records ONE vote per member with no change permitted (7.1's measured
    // fact, not an assumption from the proto).
    if (status !== "SUBMITTED") {
      reasons.push({ code: "proposal-not-open" });
    } else {
      const endMs = Date.parse(votingPeriodEnd);
      if (Number.isFinite(endMs) && facts.nowMs >= endMs) {
        reasons.push({ code: "proposal-not-open" });
      }
    }
    if (facts.memberAddresses === null || facts.voters === null) return governanceUnavailable();
    if (!facts.memberAddresses.includes(facts.address)) {
      reasons.push({ code: "not-group-member" });
    }
    const existing = facts.voters.find((v) => v.voter === facts.address) ?? null;
    if (existing !== null) {
      reasons.push({ code: "already-voted", option: existing.option });
    }
    return [...reasons, ...feeReasons()];
  }

  // gov_exec.
  if (status === "SUBMITTED") {
    reasons.push({ code: "proposal-not-passed" });
    const endMs = Date.parse(votingPeriodEnd);
    if (Number.isFinite(endMs) && facts.nowMs < endMs) {
      reasons.push({ code: "voting-period-open", endsAtIso: new Date(endMs).toISOString() });
    }
  } else if (status !== "ACCEPTED") {
    reasons.push({ code: "proposal-not-passed" });
  } else if (executorResult === "SUCCESS" || executorResult === "FAILURE") {
    // FAILURE is terminal too: x/group does not permit a second attempt.
    reasons.push({ code: "already-executed" });
  } else {
    // AN UNRESOLVED WINDOW IS NOT A ZERO WINDOW (PR #25 review, 2026-07-30).
    // `minExecutionPeriod` is null ONLY when it could not be determined — the
    // proposal's policy is outside the discovered set, or its decision rule is a
    // kind this build does not model. x/group serializes a Duration for both
    // recognized kinds, so a policy with no waiting period yields `"0s"`, never
    // null. Passing null through as "nothing to wait for" returned a green
    // reason list for an action the chain would reject with "must wait until …"
    // — the exact "silently hiding it" this module's contract forbids, and the
    // `min_execution_period` is a fact THIS branch consumes.
    const readyAtIso = executableAtIso(submitTime, facts.minExecutionPeriod);
    if (readyAtIso === null) {
      reasons.push({ code: "min-execution-pending", readyAtIso: null });
    } else if (facts.nowMs < Date.parse(readyAtIso)) {
      reasons.push({ code: "min-execution-pending", readyAtIso });
    }
  }
  return [...reasons, ...feeReasons()];
}

/**
 * Run the governance preflight for a session-scoped action. Same contract as
 * `runPreflight` and `runOperatorPreflight`: the acting address comes from the
 * SESSION, every read is live, and a failed read blocks rather than guessing.
 */
export async function runGovernancePreflight(
  config: WebConfig,
  address: string,
  request: GovernancePreflightRequest,
  deps: PreflightDeps = {},
): Promise<PreflightContext> {
  const lcdDeps = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  const lcd = new LcdClient(config.lcdUrl, lcdDeps);
  const bank = new BankClient(lcd);
  const auth = new AuthClient(lcd);

  const proposalId = request.kind === "gov_submit" ? null : request.proposalId;
  const [governance, proposal, votes, currentConfig, account, spendable] = await Promise.all([
    loadLiveGovernance(config, lcdDeps),
    proposalId === null ? Promise.resolve(null) : loadLiveProposal(config, proposalId, lcdDeps),
    request.kind === "gov_vote"
      ? loadLiveVotes(config, request.proposalId, lcdDeps)
      : Promise.resolve(null),
    // Read only where it is consumed: the `update_config` cross-field rule.
    request.kind === "gov_submit" && request.templateId === "update_config"
      ? new NvhashContractClient(lcd, config.contractAddress).config().catch(() => null)
      : Promise.resolve(null),
    auth.account(address).catch(() => null),
    bank.spendableBalances(address).catch(() => null),
  ]);

  const governed = governance.state === "governed";
  // The proposal's own policy decides the execution window. Falling back to
  // "the first policy" would read another policy's window onto this proposal,
  // which is the topology assumption D1 forbids in miniature.
  const policy =
    governance.state === "governed" && proposal !== null
      ? (governance.policies.find((p) => p.address === proposal.groupPolicyAddress) ?? null)
      : null;
  const minExecutionPeriod =
    policy === null || policy.decisionPolicy.kind === "unknown"
      ? null
      : policy.decisionPolicy.minExecutionPeriod;

  const reasons = governancePreflightReasons(request, {
    address,
    proposal:
      proposal === null
        ? null
        : {
            status: proposal.status,
            executorResult: proposal.executorResult,
            submitTime: proposal.submitTime,
            votingPeriodEnd: proposal.votingPeriodEnd,
          },
    governanceResolved: governed,
    policyAddresses:
      governance.state === "governed" ? governance.policies.map((p) => p.address) : null,
    memberAddresses:
      governance.state === "governed" && governance.members !== null
        ? governance.members.map((m) => m.address)
        : null,
    voters: votes === null ? null : votes.map((v) => ({ voter: v.voter, option: v.option })),
    minExecutionPeriod,
    currentConfig:
      currentConfig === null
        ? null
        : {
            max_delegations_per_run: BigInt(currentConfig.maxDelegationsPerRun),
            aum_fee_bps: BigInt(currentConfig.aumFeeBps),
            performance_threshold_bps: BigInt(currentConfig.performanceThresholdBps),
            min_capture_interval_secs: BigInt(currentConfig.minCaptureIntervalSecs),
            max_concentration_multiple_bps: BigInt(currentConfig.maxConcentrationMultipleBps),
            min_bonded_cap_bps: BigInt(currentConfig.minBondedCapBps),
            max_bonded_cap_bps: BigInt(currentConfig.maxBondedCapBps),
            concentration_safety_offset_bps: BigInt(currentConfig.concentrationSafetyOffsetBps),
            commission_bps: BigInt(currentConfig.commissionBps),
            jail_unbond_delay_secs: BigInt(currentConfig.jailUnbondDelaySecs),
          },
    spendableNhash:
      spendable === null
        ? null
        : (spendable.balances.find((c) => c.denom === PROGRAM_UNDERLYING_DENOM)?.amount ?? 0n),
    nowMs: Date.now(),
  });

  if (account === null && !reasons.some((r) => r.code === "chain-unavailable")) {
    reasons.push({ code: "account-missing" });
  }

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
    balance: (
      spendable?.balances.find((c) => c.denom === PROGRAM_UNDERLYING_DENOM)?.amount ?? 0n
    ).toString(),
    denom: PROGRAM_UNDERLYING_DENOM,
  };
}
