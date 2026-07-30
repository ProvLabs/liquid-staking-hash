// Preflight boundary-matrix gate: amount inputs validated
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
  operatorPreflightReasons,
  operatorPreflightRequestSchema,
  preflightRequestSchema,
  runPreflight,
  type OperatorPreflightFacts,
  type OperatorPreflightRequest,
} from "~/tx/preflight.server";
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

// ── The operator predicate matrix (§2.4) ───────────────────────────
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
