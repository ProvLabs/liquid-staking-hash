// Preflight boundary-matrix gate (plan 5.2 §4.10): amount inputs validated
// and bounded at the boundary — 0, 1 base unit, min−1, max+1, > balance,
// non-numeric, float strings — rejected with machine-readable reasons,
// never clamped. Vault gates (paused / disabled), vesting honesty, and the
// chain-unavailable block are pinned alongside. MSW overrides the corpus
// defaults per case (the roles-test pattern); the default handlers stay
// corpus-honest.

import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import vaultGet from "@nvhash/fixtures/queries/vault/get";

import { loadConfig } from "~/config/config.server";
import {
  FEE_PROVISION_NHASH,
  MAX_PROGRAM_VALIDATORS,
  governancePreflightReasons,
  governancePreflightRequestSchema,
  operatorPreflightReasons,
  operatorPreflightRequestSchema,
  preflightRequestSchema,
  runPreflight,
  type GovernancePreflightFacts,
  type OperatorPreflightFacts,
  type OperatorPreflightRequest,
} from "~/tx/preflight.server";
import { MAX_PROPOSAL_METADATA_LEN } from "@nvhash/api-types";
import { FIXTURE_CHAIN_ID, FIXTURE_CONTRACT_ADDRESS, FIXTURE_VAULT_ADDRESS } from "~/mocks/handlers";
import { server } from "~/mocks/node";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const config = loadConfig({
  APP_ENV: "development",
  CHAIN_ID: FIXTURE_CHAIN_ID,
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: FIXTURE_CONTRACT_ADDRESS,
  VAULT_ADDRESS: FIXTURE_VAULT_ADDRESS,
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: FIXTURE_CHAIN_ID,
  API_URL: "http://api.mock:8787",
} as NodeJS.ProcessEnv);

const ADDRESS = "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0";

/** Wealthy, existing base account with the given spendable balances. */
function fundedHandlers(options: {
  nhash?: string;
  nvhash?: string;
  vesting?: boolean;
  totalNhash?: string;
  vault?: Record<string, unknown>;
}) {
  const vaultFixture = vaultGet as { vault: Record<string, unknown> };
  const vault = { ...vaultFixture, vault: { ...vaultFixture.vault, ...(options.vault ?? {}) } };
  const account = options.vesting
    ? {
        "@type": "/cosmos.vesting.v1beta1.ContinuousVestingAccount",
        base_vesting_account: {
          base_account: { address: ADDRESS, account_number: "12", sequence: "4" },
        },
      }
    : { "@type": "/cosmos.auth.v1beta1.BaseAccount", address: ADDRESS, account_number: "12", sequence: "4" };
  const balances = [
    { denom: "nhash", amount: options.nhash ?? "0" },
    { denom: "nvhash", amount: options.nvhash ?? "0" },
  ].filter((c) => c.amount !== "0");
  return [
    http.get("*/vault/v1/vaults/:id", () => HttpResponse.json(vault)),
    http.get("*/cosmos/auth/v1beta1/accounts/:address", () =>
      HttpResponse.json({ account }),
    ),
    http.get("*/cosmos/bank/v1beta1/spendable_balances/:address", () =>
      HttpResponse.json({ balances, pagination: { next_key: null, total: String(balances.length) } }),
    ),
    http.get("*/cosmos/bank/v1beta1/balances/:address/by_denom", ({ request }) => {
      const denom = new URL(request.url).searchParams.get("denom") ?? "nhash";
      return HttpResponse.json({
        balance: { denom, amount: denom === "nhash" ? (options.totalNhash ?? options.nhash ?? "0") : "0" },
      });
    }),
  ];
}

const AMPLE = (10_000_000_000_000n + FEE_PROVISION_NHASH).toString();

describe("schema boundary: reject, never clamp", () => {
  it.each([
    ["float string", "1.5"],
    ["negative", "-1"],
    ["non-numeric", "abc"],
    ["empty", ""],
    ["hex", "0x10"],
    ["overlong (40 digits)", "1".repeat(40)],
    ["scientific", "1e9"],
  ])("rejects %s", (_label, amount) => {
    expect(preflightRequestSchema.safeParse({ kind: "swap_in", amount }).success).toBe(false);
  });

  it("accepts a plain base-unit integer string", () => {
    expect(preflightRequestSchema.safeParse({ kind: "swap_in", amount: "1" }).success).toBe(true);
  });
});

describe("preflight matrix (live vault reads; reasons on every block)", () => {
  it("passes a funded swap_in and supplies signer facts", async () => {
    server.use(...fundedHandlers({ nhash: AMPLE }));
    const result = await runPreflight(config, ADDRESS, { kind: "swap_in", amount: "1000000000" });
    expect(result.reasons).toEqual([]);
    expect(result.signer).toEqual({ accountNumber: "12", sequence: "4", chainId: FIXTURE_CHAIN_ID });
  });

  it("amount 0 → amount-invalid", async () => {
    server.use(...fundedHandlers({ nhash: AMPLE }));
    const result = await runPreflight(config, ADDRESS, { kind: "swap_in", amount: "0" });
    expect(result.reasons).toContainEqual({ code: "amount-invalid" });
  });

  it("1 base unit passes when no minimum is set (fixture default)", async () => {
    server.use(...fundedHandlers({ nhash: AMPLE }));
    const result = await runPreflight(config, ADDRESS, { kind: "swap_in", amount: "1" });
    expect(result.reasons).toEqual([]);
  });

  it("min−1 → below-minimum; max+1 → above-maximum (vault bounds set)", async () => {
    const vault = { min_swap_in_value: "1000000", max_swap_in_value: "5000000" };
    server.use(...fundedHandlers({ nhash: AMPLE, vault }));
    const below = await runPreflight(config, ADDRESS, { kind: "swap_in", amount: "999999" });
    expect(below.reasons).toContainEqual({ code: "below-minimum", minimum: "1000000" });
    server.resetHandlers();
    server.use(...fundedHandlers({ nhash: AMPLE, vault }));
    const above = await runPreflight(config, ADDRESS, { kind: "swap_in", amount: "5000001" });
    expect(above.reasons).toContainEqual({ code: "above-maximum", maximum: "5000000" });
  });

  it("amount + fee > balance → insufficient-balance (fee included)", async () => {
    const amount = 1_000_000_000n;
    // Balance covers the amount exactly but not the fee provision.
    server.use(...fundedHandlers({ nhash: amount.toString() }));
    const result = await runPreflight(config, ADDRESS, {
      kind: "swap_in",
      amount: amount.toString(),
    });
    expect(result.reasons).toContainEqual({
      code: "insufficient-balance",
      balance: amount.toString(),
      required: (amount + FEE_PROVISION_NHASH).toString(),
    });
  });

  it("swap_out: shares balance short → insufficient-balance", async () => {
    server.use(...fundedHandlers({ nhash: AMPLE, nvhash: "100" }));
    const result = await runPreflight(config, ADDRESS, { kind: "swap_out", amount: "101" });
    expect(result.reasons).toContainEqual({
      code: "insufficient-balance",
      balance: "100",
      required: "101",
    });
  });

  it("paused vault → vault-paused with the on-chain reason", async () => {
    server.use(
      ...fundedHandlers({ nhash: AMPLE, vault: { paused: true, paused_reason: "maintenance" } }),
    );
    const result = await runPreflight(config, ADDRESS, { kind: "swap_in", amount: "1" });
    expect(result.reasons).toContainEqual({ code: "vault-paused", detail: "maintenance" });
  });

  it("swap-in disabled → swaps-disabled", async () => {
    server.use(...fundedHandlers({ nhash: AMPLE, vault: { swap_in_enabled: false } }));
    const result = await runPreflight(config, ADDRESS, { kind: "swap_in", amount: "1" });
    expect(result.reasons).toContainEqual({ code: "swaps-disabled" });
  });

  it("vesting account with locked funds → vesting-locked honesty", async () => {
    const amount = 5_000_000_000n;
    server.use(
      ...fundedHandlers({
        nhash: "1000", // spendable: almost nothing
        totalNhash: (amount + FEE_PROVISION_NHASH).toString(), // total: plenty, but locked
        vesting: true,
      }),
    );
    const result = await runPreflight(config, ADDRESS, {
      kind: "swap_in",
      amount: amount.toString(),
    });
    expect(result.reasons).toContainEqual({ code: "vesting-locked", spendable: "1000" });
  });

  it("unknown account → account-missing (and no signer facts)", async () => {
    // Default handlers: auth 404s, balances empty.
    const result = await runPreflight(config, ADDRESS, { kind: "swap_in", amount: "1" });
    expect(result.reasons).toContainEqual({ code: "account-missing" });
    expect(result.signer).toBeNull();
  });

  it("chain failure → chain-unavailable, never a guess", async () => {
    server.use(
      http.get("*/vault/v1/vaults/:id", () =>
        HttpResponse.json({ code: 2, message: "down", details: [] }, { status: 503 }),
      ),
    );
    const result = await runPreflight(config, ADDRESS, { kind: "swap_in", amount: "1" });
    expect(result.reasons).toEqual([{ code: "chain-unavailable" }]);
    expect(result.signer).toBeNull();
  });
});

// ── M6.4: the operator predicate matrix (§2.4) ───────────────────────────
//
// Pure over live facts, so every branch is drivable. Two properties matter
// beyond the individual rules:
//   * an unavailable read yields `chain-unavailable` and NOTHING else — a
//     reason derived from a missing fact would be a guess dressed as advice;
//   * payments carry no operator check, because paying is permissionless
//     ("anyone, nhash attached") and pretending otherwise would block a
//     co-op partner from doing something the contract allows.

describe("operator preflight predicates (M6.4 §2.4)", () => {
  const ADDRESS = "tp18kkn20p7dphkal2x84t30cv7z6v9rf9cvykjhk";
  const VALOPER = "tpvaloper1l39wu7cht0zcycc5rkcd90sdd4ksjmxwjqvnjp";
  /** The valoper ADDRESS actually operates: same bech32 payload, `valoper` HRP
   * — the pair the contract's `is_operator` accepts. */
  const VALOPER_OWNED = "tpvaloper18kkn20p7dphkal2x84t30cv7z6v9rf9cndtxzn";
  const NOW = 1_800_000_000;

  const enrolledEntry = {
    valoper: VALOPER,
    operator: ADDRESS,
    jailed: false,
    commissionDue: 0n,
    commissionPaid: 0n,
  };

  function facts(over: Partial<OperatorPreflightFacts> = {}): OperatorPreflightFacts {
    return {
      address: ADDRESS,
      validators: [enrolledEntry],
      jailReports: [],
      chainValidator: { exists: true, jailed: false },
      halted: false,
      spendableNhash: 1_000_000_000_000n,
      nowSeconds: NOW,
      ...over,
    };
  }

  function request(over: Partial<OperatorPreflightRequest> = {}): OperatorPreflightRequest {
    return {
      kind: "operator",
      variant: "pay_commission",
      valoper: VALOPER,
      claimantValoper: null,
      amount: "1000000000",
      ...over,
    };
  }

  const codes = (reasons: ReturnType<typeof operatorPreflightReasons>) =>
    reasons.map((r) => r.code);

  it("a failed chain read blocks with chain-unavailable ALONE", () => {
    for (const broken of [{ validators: null }, { chainValidator: null }] as const) {
      const reasons = operatorPreflightReasons(request(), facts(broken));
      expect(codes(reasons)).toEqual(["chain-unavailable"]);
    }
  });

  // Every nullable fact must block the variants that CONSUME it. A branch that
  // skipped its check on a null would return an empty (green) reason list for
  // an action the contract then rejects — the failure mode this asserts away.
  it("a fact a variant CONSUMES is missing → chain-unavailable, never silence", () => {
    // Payments weigh spendable balance.
    expect(codes(operatorPreflightReasons(request(), facts({ spendableNhash: null })))).toEqual([
      "chain-unavailable",
    ]);

    // Purge weighs the report list AND the halt flag.
    const purge = request({ variant: "purge_jailed_validator", amount: "0" });
    const jailed = { exists: true, jailed: true } as const;
    for (const broken of [{ jailReports: null }, { halted: null }] as const) {
      expect(
        codes(operatorPreflightReasons(purge, facts({ chainValidator: jailed, ...broken }))),
      ).toEqual(["chain-unavailable"]);
    }
  });

  it("a variant that does NOT consume a fact is unaffected by its absence", () => {
    // Enrolment weighs neither balance nor jail reports, so a failed read of
    // either must not block it — chain-unavailable is for consumed facts only.
    expect(
      codes(
        operatorPreflightReasons(
          request({ variant: "register_participation", valoper: VALOPER_OWNED, amount: "0" }),
          facts({ validators: [], spendableNhash: null, jailReports: null, halted: null }),
        ),
      ),
    ).toEqual([]);
  });

  it("a clean payment on an enrolled validator has no reasons", () => {
    expect(codes(operatorPreflightReasons(request(), facts()))).toEqual([]);
  });

  it("payments are PERMISSIONLESS — a non-operator payer is not blocked", () => {
    // The contract lets anyone pay; a UI guard saying otherwise would be wrong.
    const reasons = operatorPreflightReasons(
      request(),
      facts({ validators: [{ ...enrolledEntry, operator: "tp1someoneelse" }] }),
    );
    expect(codes(reasons)).not.toContain("not-validator-operator");
    expect(codes(reasons)).toEqual([]);
  });

  it("a payment on an unenrolled validator, or of zero, is blocked", () => {
    expect(codes(operatorPreflightReasons(request(), facts({ validators: [] })))).toContain(
      "not-enrolled",
    );
    expect(codes(operatorPreflightReasons(request({ amount: "0" }), facts()))).toContain(
      "amount-invalid",
    );
  });

  it("a payment beyond spendable (including the fee provision) is blocked", () => {
    // Spendable covers the payment itself but NOT the payment plus the fee
    // provision — the case that proves the provision is part of the check.
    const amount = 1_000_000_000n;
    const reasons = operatorPreflightReasons(
      request({ amount: amount.toString() }),
      facts({ spendableNhash: amount + FEE_PROVISION_NHASH - 1n }),
    );
    expect(codes(reasons)).toContain("insufficient-balance");

    // Exactly enough → clear. Pinned so a provision change cannot quietly
    // start rejecting payments a wallet can afford.
    expect(
      codes(
        operatorPreflightReasons(
          request({ amount: amount.toString() }),
          facts({ spendableNhash: amount + FEE_PROVISION_NHASH }),
        ),
      ),
    ).toEqual([]);
  });

  it("enrolment requires an existing, not-already-enrolled validator", () => {
    expect(
      codes(
        operatorPreflightReasons(
          request({ variant: "register_participation", valoper: VALOPER_OWNED, amount: "0" }),
          facts({ chainValidator: { exists: false, jailed: false }, validators: [] }),
        ),
      ),
    ).toContain("validator-not-found");
    expect(
      codes(
        operatorPreflightReasons(
          request({ variant: "register_participation", valoper: VALOPER_OWNED, amount: "0" }),
          facts({ validators: [{ ...enrolledEntry, valoper: VALOPER_OWNED }] }),
        ),
      ),
    ).toContain("already-enrolled");
  });

  // The contract's `register` checks is_operator BEFORE anything else: the
  // caller's account and the valoper must share one bech32 payload. That is a
  // LOCAL fact, so preflight restates it with no chain read at all.
  it("enrolment requires the caller to be the valoper's own operator account", () => {
    // A valoper whose payload is not this wallet's → blocked.
    expect(
      codes(
        operatorPreflightReasons(
          request({ variant: "register_participation", valoper: VALOPER, amount: "0" }),
          facts({ validators: [] }),
        ),
      ),
    ).toEqual(["not-validator-operator"]);

    // The wallet's OWN valoper, existing and unenrolled → clear.
    expect(
      codes(
        operatorPreflightReasons(
          request({ variant: "register_participation", valoper: VALOPER_OWNED, amount: "0" }),
          facts({ validators: [] }),
        ),
      ),
    ).toEqual([]);
  });

  it("enrolment is blocked at the contract's validator ceiling", () => {
    const full = Array.from({ length: MAX_PROGRAM_VALIDATORS }, (_, i) => ({
      ...enrolledEntry,
      valoper: `${VALOPER}${i}`,
    }));
    const reasons = operatorPreflightReasons(
      request({ variant: "register_participation", valoper: VALOPER_OWNED, amount: "0" }),
      facts({ validators: full }),
    );
    expect(codes(reasons)).toContain("too-many-validators");
    expect(reasons.find((r) => r.code === "too-many-validators")).toMatchObject({
      max: MAX_PROGRAM_VALIDATORS,
    });
  });

  it("unregistering requires enrolment AND the operator account", () => {
    expect(
      codes(
        operatorPreflightReasons(
          request({ variant: "unregister_participation", amount: "0" }),
          facts({ validators: [] }),
        ),
      ),
    ).toEqual(["not-enrolled"]);
    expect(
      codes(
        operatorPreflightReasons(
          request({ variant: "unregister_participation", amount: "0" }),
          facts({ validators: [{ ...enrolledEntry, operator: "tp1someoneelse" }] }),
        ),
      ),
    ).toEqual(["not-validator-operator"]);
  });

  it("reporting requires the validator to be jailed RIGHT NOW", () => {
    expect(
      codes(
        operatorPreflightReasons(
          request({ variant: "report_jailed_validator", amount: "0" }),
          facts(),
        ),
      ),
    ).toContain("validator-not-jailed");
    expect(
      codes(
        operatorPreflightReasons(
          request({ variant: "report_jailed_validator", amount: "0" }),
          facts({ chainValidator: { exists: true, jailed: true } }),
        ),
      ),
    ).toEqual([]);
  });

  it("purging walks the two-phase gate: jailed → reported → cooldown → halt", () => {
    const purge = request({ variant: "purge_jailed_validator", amount: "0" });
    const jailed = { exists: true, jailed: true } as const;

    // Not jailed at all.
    expect(codes(operatorPreflightReasons(purge, facts()))).toContain("validator-not-jailed");

    // Jailed, but never reported — phase 1 has not happened.
    expect(
      codes(operatorPreflightReasons(purge, facts({ chainValidator: jailed, jailReports: [] }))),
    ).toContain("no-jail-report");

    // Reported, cooldown still running — with the instant it ends.
    const cooling = operatorPreflightReasons(
      purge,
      facts({
        chainValidator: jailed,
        jailReports: [{ valoper: VALOPER, purgeReadyAtSeconds: NOW + 3_600 }],
      }),
    );
    expect(codes(cooling)).toContain("purge-cooldown");
    expect(cooling.find((r) => r.code === "purge-cooldown")).toMatchObject({
      readyAtIso: new Date((NOW + 3_600) * 1_000).toISOString(),
    });

    // Cooldown elapsed → clear.
    expect(
      codes(
        operatorPreflightReasons(
          purge,
          facts({
            chainValidator: jailed,
            jailReports: [{ valoper: VALOPER, purgeReadyAtSeconds: NOW - 1 }],
          }),
        ),
      ),
    ).toEqual([]);

    // …unless the program is halted: phase 2 moves funds and is halt-gated.
    expect(
      codes(
        operatorPreflightReasons(
          purge,
          facts({
            chainValidator: jailed,
            jailReports: [{ valoper: VALOPER, purgeReadyAtSeconds: NOW - 1 }],
            halted: true,
          }),
        ),
      ),
    ).toEqual(["program-halted"]);
  });

  it("bounds its inputs at the boundary (valoper shape, amount shape)", () => {
    expect(operatorPreflightRequestSchema.safeParse({ kind: "operator", variant: "pay_tip", valoper: VALOPER, amount: "1" }).success).toBe(true);
    for (const bad of [
      { kind: "operator", variant: "pay_tip", valoper: ADDRESS, amount: "1" }, // account, not valoper
      { kind: "operator", variant: "set_halted", valoper: VALOPER, amount: "1" }, // not a variant
      { kind: "operator", variant: "pay_tip", valoper: VALOPER, amount: "1.5" }, // float
      { kind: "operator", variant: "pay_tip", valoper: VALOPER, amount: "-1" }, // negative
    ]) {
      expect(operatorPreflightRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

// ── M7.3–7.4: the governance predicate matrix (§2.5) ─────────────────────
//
// Same contract as the operator matrix above, including its two-directional
// rule: a variant MUST short-circuit on every fact IT consumes, and is equally
// forbidden from blocking on a fact it does NOT consume. Skipping a check on a
// null returns an empty (green) reason list for an action the chain then
// rejects — the "silently hiding it" the module forbids.
//
// And the boundary these cases exist to keep visible: PREFLIGHT IS CONVENIENCE.
// A would-fail reason is never an authorization claim and a PASSING preflight
// never implies acceptance; the group module and the contract decide. The
// preflight-passes-chain-rejects case at the end of this block says so
// executably (invariant 11).

const GOV_POLICY = "tp1qgvqctd47dqe9ryqkzc0zpu3wkqjr3sndkldpwfjfcqz0f4tqzsq7wshjm";
const GOV_NOW = Date.parse("2026-07-30T12:00:00Z");

function govFacts(overrides: Partial<GovernancePreflightFacts> = {}): GovernancePreflightFacts {
  return {
    address: ADDRESS,
    proposal: {
      status: "SUBMITTED",
      executorResult: "NOT_RUN",
      submitTime: "2026-07-29T12:00:00Z",
      votingPeriodEnd: "2026-07-31T12:00:00Z",
    },
    governanceResolved: true,
    policyAddresses: [GOV_POLICY],
    memberAddresses: [ADDRESS],
    voters: [],
    minExecutionPeriod: "0s",
    currentConfig: {
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
    spendableNhash: FEE_PROVISION_NHASH * 10n,
    nowMs: GOV_NOW,
    ...overrides,
  };
}

const govCodes = (reasons: ReturnType<typeof governancePreflightReasons>) =>
  reasons.map((r) => r.code);

describe("governance preflight — vote", () => {
  const vote = { kind: "gov_vote", proposalId: "12", option: "yes" } as const;

  it("an open proposal, a member who has not voted → no reasons", () => {
    expect(govCodes(governancePreflightReasons(vote, govFacts()))).toEqual([]);
  });

  it("a closed proposal, or one whose voting period elapsed → proposal-not-open", () => {
    expect(
      govCodes(
        governancePreflightReasons(
          vote,
          govFacts({ proposal: { ...govFacts().proposal!, status: "ACCEPTED" } }),
        ),
      ),
    ).toContain("proposal-not-open");
    expect(
      govCodes(
        governancePreflightReasons(vote, govFacts({ nowMs: Date.parse("2026-08-02T00:00:00Z") })),
      ),
    ).toContain("proposal-not-open");
  });

  it("a non-member → not-group-member", () => {
    expect(
      govCodes(governancePreflightReasons(vote, govFacts({ memberAddresses: ["tp1other"] }))),
    ).toContain("not-group-member");
  });

  it("an existing vote → already-voted, carrying the recorded option", () => {
    const reasons = governancePreflightReasons(
      vote,
      govFacts({ voters: [{ voter: ADDRESS, option: "YES" }] }),
    );
    expect(reasons).toContainEqual({ code: "already-voted", option: "YES" });
  });

  it("an unreadable proposal → proposal-not-found, NEVER proposal-pruned", () => {
    // The LCD answers HTTP 500 byte-identically for a pruned id, an unknown id
    // and an outage, so "we could not read it" is the only sound claim. Only
    // the MIRROR's `pruned_at_height` can say pruned.
    const codes = govCodes(governancePreflightReasons(vote, govFacts({ proposal: null })));
    expect(codes).toContain("proposal-not-found");
    expect(codes).not.toContain("proposal-pruned");
  });

  it("BLOCKS on every fact it consumes, and on no other", () => {
    // Consumed by the vote branch: the member set and the vote list.
    for (const missing of [{ memberAddresses: null }, { voters: null }] as const) {
      expect(govCodes(governancePreflightReasons(vote, govFacts(missing))), JSON.stringify(missing)).toEqual([
        "governance-unavailable",
      ]);
    }
    // NOT consumed by the vote branch: the policy set. Blocking on it would be
    // the other half of the two-directional rule.
    expect(
      govCodes(governancePreflightReasons(vote, govFacts({ policyAddresses: null }))),
    ).toEqual([]);
  });
});

describe("governance preflight — exec", () => {
  const exec = { kind: "gov_exec", proposalId: "12" } as const;
  const accepted = { status: "ACCEPTED", executorResult: "NOT_RUN", submitTime: "2026-07-29T12:00:00Z", votingPeriodEnd: "2026-07-31T12:00:00Z" };

  it("an accepted, elapsed-window proposal → no reasons", () => {
    expect(govCodes(governancePreflightReasons(exec, govFacts({ proposal: accepted })))).toEqual([]);
  });

  it("still open → proposal-not-passed AND the voting-period-open detail", () => {
    const codes = govCodes(governancePreflightReasons(exec, govFacts()));
    expect(codes).toContain("proposal-not-passed");
    expect(codes).toContain("voting-period-open");
  });

  it("min_execution_period not yet elapsed → min-execution-pending with the time", () => {
    const reasons = governancePreflightReasons(
      exec,
      govFacts({ proposal: accepted, minExecutionPeriod: "172800s" }),
    );
    expect(reasons).toContainEqual({
      code: "min-execution-pending",
      readyAtIso: "2026-07-31T12:00:00.000Z",
    });
  });

  it("already executed — SUCCESS or FAILURE — → already-executed", () => {
    for (const executorResult of ["SUCCESS", "FAILURE"]) {
      expect(
        govCodes(
          governancePreflightReasons(
            exec,
            govFacts({ proposal: { ...accepted, executorResult } }),
          ),
        ),
        executorResult,
      ).toContain("already-executed");
    }
  });

  it("rejected / aborted / withdrawn → proposal-not-passed", () => {
    for (const status of ["REJECTED", "ABORTED", "WITHDRAWN"]) {
      expect(
        govCodes(governancePreflightReasons(exec, govFacts({ proposal: { ...accepted, status } }))),
        status,
      ).toContain("proposal-not-passed");
    }
  });

  it("does NOT require membership — execution is permissionless (§7 Q2)", () => {
    expect(
      govCodes(
        governancePreflightReasons(
          exec,
          govFacts({ proposal: accepted, memberAddresses: ["tp1someone-else"] }),
        ),
      ),
    ).toEqual([]);
  });
});

describe("governance preflight — submit", () => {
  const submit = {
    kind: "gov_submit",
    policyAddress: GOV_POLICY,
    templateId: "update_config",
    values: { aum_fee_bps: "25" },
    title: "Lower the AUM fee",
    summary: "Reduce aum_fee_bps to 25.",
    metadata: "",
  } as const;

  it("a member proposing to a discovered policy → no reasons", () => {
    expect(govCodes(governancePreflightReasons(submit, govFacts()))).toEqual([]);
  });

  it("a policy outside the discovered set → policy-not-found", () => {
    expect(
      govCodes(
        governancePreflightReasons(
          { ...submit, policyAddress: "tp1not-a-program-policy" },
          govFacts(),
        ),
      ),
    ).toContain("policy-not-found");
  });

  it("a non-member → not-group-member", () => {
    expect(
      govCodes(governancePreflightReasons(submit, govFacts({ memberAddresses: ["tp1other"] }))),
    ).toContain("not-group-member");
  });

  it("a template value outside its contract bound → template-invalid, never clamped", () => {
    const reasons = governancePreflightReasons(
      { ...submit, values: { aum_fee_bps: "10001" } },
      govFacts(),
    );
    const invalid = reasons.find((r) => r.code === "template-invalid");
    expect(invalid).toBeDefined();
    expect(invalid && "detail" in invalid ? invalid.detail : "").toContain("aum_fee_bps");
  });

  it("restates the CROSS-FIELD contract rule a per-field bound cannot express", () => {
    // `Config::validate` requires min <= max AFTER the merge, so it depends on
    // the CURRENT config for whichever side the proposal leaves unsupplied.
    // Current is min 500 / max 3300; proposing min 4000 alone would merge to
    // 4000 > 3300 and fail at EXECUTION — after the group spent its voting
    // period, which is the worst place to find out.
    const reasons = governancePreflightReasons(
      { ...submit, values: { min_bonded_cap_bps: "4000" } },
      govFacts(),
    );
    const invalid = reasons.find((r) => r.code === "template-invalid");
    expect(invalid).toBeDefined();
    expect(invalid && "detail" in invalid ? invalid.detail : "").toContain("min_bonded_cap_bps");

    // Raising BOTH in one proposal is fine, and must not be blocked.
    expect(
      govCodes(
        governancePreflightReasons(
          { ...submit, values: { min_bonded_cap_bps: "4000", max_bonded_cap_bps: "5000" } },
          govFacts(),
        ),
      ),
    ).toEqual([]);
  });

  it("BLOCKS on the live config ONLY when the cross-field rule is engaged", () => {
    // The two-directional rule again: consumed by a proposal that supplies
    // either bonded-cap field, and by no other.
    expect(
      govCodes(
        governancePreflightReasons(
          { ...submit, values: { min_bonded_cap_bps: "400" } },
          govFacts({ currentConfig: null }),
        ),
      ),
    ).toEqual(["chain-unavailable"]);
    // A proposal touching neither must not block on a read it does not use.
    expect(
      govCodes(governancePreflightReasons(submit, govFacts({ currentConfig: null }))),
    ).toEqual([]);
  });

  it("BLOCKS on the policy set and the member set — both consumed here", () => {
    for (const missing of [{ policyAddresses: null }, { memberAddresses: null }] as const) {
      expect(
        govCodes(governancePreflightReasons(submit, govFacts(missing))),
        JSON.stringify(missing),
      ).toEqual(["governance-unavailable"]);
    }
  });
});

describe("governance preflight — the shared rules", () => {
  it("an unresolved live plane blocks every action with ONE distinct reason", () => {
    // `governance-unavailable` is deliberately not `chain-unavailable`: "this
    // deployment has no group" and "the node did not answer" are different
    // things to tell someone (§3.4 R2), and the copy differs accordingly.
    for (const request of [
      { kind: "gov_vote", proposalId: "12", option: "yes" },
      { kind: "gov_exec", proposalId: "12" },
      {
        kind: "gov_submit",
        policyAddress: GOV_POLICY,
        templateId: "unpause_vault",
        values: {},
        title: "t",
        summary: "s",
        metadata: "",
      },
    ] as const) {
      expect(
        govCodes(governancePreflightReasons(request, govFacts({ governanceResolved: false }))),
        request.kind,
      ).toEqual(["governance-unavailable"]);
    }
  });

  it("the fee is checked on all three, and an unreadable balance blocks", () => {
    const request = { kind: "gov_exec", proposalId: "12" } as const;
    const accepted = { status: "ACCEPTED", executorResult: "NOT_RUN", submitTime: "2026-07-29T12:00:00Z", votingPeriodEnd: "2026-07-31T12:00:00Z" };
    expect(
      govCodes(
        governancePreflightReasons(request, govFacts({ proposal: accepted, spendableNhash: 0n })),
      ),
    ).toContain("insufficient-balance");
    expect(
      govCodes(
        governancePreflightReasons(request, govFacts({ proposal: accepted, spendableNhash: null })),
      ),
    ).toContain("chain-unavailable");
  });

  it("PASSING preflight is not acceptance — the chain still decides (invariant 11)", () => {
    // The executable form of the boundary. Preflight can only restate what it
    // could read a moment ago: a proposal that passes every predicate here can
    // still be rejected on chain because another member voted in the interim,
    // the voting period closed between the read and the broadcast, or the
    // contract refused the admin action on its own terms. Nothing in this
    // module may be read as permission.
    const passing = governancePreflightReasons(
      { kind: "gov_vote", proposalId: "12", option: "yes" },
      govFacts(),
    );
    expect(passing).toEqual([]);
    // …and the same facts one millisecond after the voting period closes now
    // block, which is the whole of what "convenience only" means: the answer is
    // a snapshot, and the module is the boundary.
    expect(
      govCodes(
        governancePreflightReasons(
          { kind: "gov_vote", proposalId: "12", option: "yes" },
          govFacts({ nowMs: Date.parse("2026-07-31T12:00:00.001Z") }),
        ),
      ),
    ).toContain("proposal-not-open");
  });

  it("bounds its inputs at the boundary (proposal id, option, text lengths)", () => {
    expect(
      governancePreflightRequestSchema.safeParse({
        kind: "gov_vote",
        proposalId: "12",
        option: "yes",
      }).success,
    ).toBe(true);
    for (const bad of [
      { kind: "gov_vote", proposalId: "012", option: "yes" }, // leading zero: one id, one spelling
      { kind: "gov_vote", proposalId: "1.5", option: "yes" },
      { kind: "gov_vote", proposalId: "12", option: "unspecified" }, // not one of the four
      { kind: "gov_vote", proposalId: "12", option: "YES" },
      { kind: "gov_vote", proposalId: "1".repeat(21), option: "yes" }, // wider than u64
      { kind: "gov_exec", proposalId: "-1" },
      {
        kind: "gov_submit",
        policyAddress: GOV_POLICY,
        templateId: "unpause_vault",
        values: {},
        title: "",
        summary: "s",
        metadata: "",
      }, // empty title
      {
        kind: "gov_submit",
        policyAddress: GOV_POLICY,
        templateId: "unpause_vault",
        values: {},
        title: "t",
        summary: "s",
        metadata: "x".repeat(MAX_PROPOSAL_METADATA_LEN + 1),
      },
    ]) {
      expect(governancePreflightRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });
});
