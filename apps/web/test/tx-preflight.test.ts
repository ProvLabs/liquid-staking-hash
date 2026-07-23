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
  preflightRequestSchema,
  runPreflight,
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
