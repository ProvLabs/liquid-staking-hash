// Operator-view loader degradation + honesty matrix (M6.4 §2.3; SECURITY.md
// "never lie about state", app-spec §12.1). Chain reads come from the fixture
// corpus via MSW; API envelopes from the @nvhash/api-types producers.
//
// What this suite is really guarding: this is the page an operator acts on. A
// fabricated "current" standing, a zero where a figure is unknown, or an
// estimate presented without its label all lead to a real decision made on a
// wrong number. Each case below is one of those failure modes made executable.

import { envelope } from "@nvhash/api-types";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "~/config/config.server";
import {
  FIXTURE_CHAIN_ID,
  FIXTURE_CONTRACT_ADDRESS,
  FIXTURE_VAULT_ADDRESS,
} from "~/mocks/handlers";
import { server } from "~/mocks/node";
import { loadOperatorViewData } from "~/validators/mine.server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const KEY = "operator-test-assertion-key-0123456789";
const BASE_ENV = {
  APP_ENV: "development",
  CHAIN_ID: FIXTURE_CHAIN_ID,
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: FIXTURE_CONTRACT_ADDRESS,
  VAULT_ADDRESS: FIXTURE_VAULT_ADDRESS,
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: FIXTURE_CHAIN_ID,
  API_URL: "http://api.mock:8787",
} as NodeJS.ProcessEnv;

const withKey = () => loadConfig({ ...BASE_ENV, API_SERVICE_ASSERTION_KEY: KEY });
const withoutKey = () => loadConfig(BASE_ENV);

const HASH = 10n ** 9n;
const VALOPER = "tpvaloper1l39wu7cht0zcycc5rkcd90sdd4ksjmxwjqvnjp";
const OPERATOR = "tp18kkn20p7dphkal2x84t30cv7z6v9rf9cvykjhk";
const SESSION = { address: OPERATOR };

/** A populated /operator/summary row (defaults are a clean, current validator). */
function summaryRow(overrides: Record<string, unknown> = {}) {
  return {
    valoper: VALOPER,
    moniker: "alpha",
    operator: OPERATOR,
    active: true,
    enrolled_at: "2026-01-01T00:00:00.000Z",
    unregistered_at: null,
    epoch_index: 2,
    uptime_bps: 9_900,
    eligible: true,
    failing_reasons: [],
    program_delegation: (1000n * HASH).toString(),
    tip: "0",
    commission_accrued: (10n * HASH).toString(),
    commission_paid: (10n * HASH).toString(),
    commission_due: "0",
    commission_paid_total: (10n * HASH).toString(),
    tip_paid_total: (2n * HASH).toString(),
    payment_count: 3,
    ...overrides,
  };
}

function summary(rows: Record<string, unknown>[] = [summaryRow()]) {
  return http.get("*/api/v1/operator/summary", () =>
    HttpResponse.json(envelope({ address: OPERATOR, validators: rows }, { source: "indexed" })),
  );
}

function epochRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    valoper: VALOPER,
    epoch_index: index,
    uptime_bps: 9_900,
    eligible: true,
    failing_reasons: [],
    tip: "0",
    commission_accrued: (10n * HASH).toString(),
    commission_paid: (10n * HASH).toString(),
    commission_due: "0",
    program_delegation: (1000n * HASH).toString(),
    height: index * 100,
    observed_at: `2026-0${index}-01T00:00:00.000Z`,
    ...overrides,
  };
}

const epochs = (rows: Record<string, unknown>[]) =>
  http.get("*/api/v1/operator/epochs", () => HttpResponse.json(envelope(rows, { source: "indexed" })));

const payments = (rows: Record<string, unknown>[]) =>
  http.get("*/api/v1/operator/payments", () =>
    HttpResponse.json(envelope(rows, { source: "indexed" })),
  );

/** Live `Validators {}` override — the plane the commission standing comes from. */
function liveValidators(entries: Record<string, unknown>[]) {
  return http.get("*/cosmwasm/wasm/v1/contract/:address/smart/:query", ({ params }) => {
    const decoded = Buffer.from(String(params["query"]), "base64").toString("utf8");
    const key = Object.keys(JSON.parse(decoded) as Record<string, unknown>)[0];
    if (key === "validators") return HttpResponse.json({ data: { validators: entries } });
    if (key === "config") {
      return HttpResponse.json({
        data: {
          admin: OPERATOR,
          vault_address: FIXTURE_VAULT_ADDRESS,
          underlying_denom: "nhash",
          receipt_denom: "nvhash.staked",
          max_delegations_per_run: 5,
          aum_fee_bps: 0,
          performance_threshold_bps: 9_500,
          min_capture_interval_secs: 0,
          max_concentration_multiple_bps: 55_000,
          min_bonded_cap_bps: 500,
          max_bonded_cap_bps: 3_300,
          concentration_safety_offset_bps: 500,
          commission_bps: 1_000,
          jail_unbond_delay_secs: 28_800,
        },
      });
    }
    if (key === "jail_reports") return HttpResponse.json({ data: { reports: [] } });
    return HttpResponse.json({ data: {} });
  });
}

function liveValidator(overrides: Record<string, unknown> = {}) {
  return {
    valoper: VALOPER,
    operator: OPERATOR,
    enrolled_at_seconds: 1_767_225_600,
    uptime_capture_count: 3,
    uptime_bps: 9_900,
    jailed: false,
    tombstoned: false,
    tip_epoch: "0",
    commission_accrued: (10n * HASH).toString(),
    commission_paid: (10n * HASH).toString(),
    commission_due: "0",
    in_arrears: false,
    eligible: true,
    headroom: (500n * HASH).toString(),
    ...overrides,
  };
}

describe("gating states before any figure is shown", () => {
  it("an operator with no indexed validators still gets an honest empty page", async () => {
    server.use(liveValidators([]));
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.owned).toEqual([]);
    expect(data.selectedValoper).toBeNull();
    expect(data.standing).toBeNull();
    expect(data.netBenefit).toBeNull();
  });

  it("no minting key leaves the live standing but no indexed history", async () => {
    server.use(liveValidators([liveValidator()]));
    const data = await loadOperatorViewData(withoutKey(), SESSION);
    expect(data.personalReadsAvailable).toBe(false);
    // The live plane still answers: the operator sees their own standing.
    expect(data.owned.map((v) => v.valoper)).toEqual([VALOPER]);
    expect(data.standing?.standing).toBe("current");
    expect(data.epochs).toEqual([]);
    expect(data.payments).toEqual([]);
  });

  it("API down leaves the same live-only posture", async () => {
    server.use(
      liveValidators([liveValidator()]),
      http.get("*/api/v1/operator/summary", () => HttpResponse.json({}, { status: 503 })),
    );
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.personalReadsAvailable).toBe(false);
    expect(data.standing?.standing).toBe("current");
  });

  it("live reads down leave the indexed history but NO guessed standing", async () => {
    server.use(
      summary(),
      http.get("*/cosmwasm/wasm/v1/contract/:address/smart/:query", () =>
        HttpResponse.json({ message: "down" }, { status: 503 }),
      ),
    );
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.liveAvailable).toBe(false);
    expect(data.personalReadsAvailable).toBe(true);
    // The standing block exists but every live figure is null — never "current".
    expect(data.standing?.standing).toBeNull();
    expect(data.standing?.commissionDueHash).toBeNull();
    expect(data.standing?.prepaidCreditHash).toBeNull();
  });
});

describe("commission standing — all three states end to end", () => {
  it("renders in-arrears from the contract's own assessment", async () => {
    server.use(
      summary(),
      liveValidators([
        liveValidator({
          in_arrears: true,
          eligible: false,
          commission_accrued: (30n * HASH).toString(),
          commission_paid: (10n * HASH).toString(),
          commission_due: (20n * HASH).toString(),
        }),
      ]),
    );
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.standing?.standing).toBe("in-arrears");
    expect(data.standing?.commissionDueHash).toBe("20.0000");
    expect(data.standing?.prepaidCreditHash).toBeNull();
  });

  it("renders current when nothing is owed and nothing is ahead", async () => {
    server.use(summary(), liveValidators([liveValidator()]));
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.standing?.standing).toBe("current");
    expect(data.standing?.prepaidCreditHash).toBeNull();
  });

  it("renders PREPAID with its credit — the state the payment plane cannot see", async () => {
    // The contract's `outstanding` attribute saturates at 0 on an overpayment,
    // so anything derived from payment events would call this "current".
    server.use(
      summary(),
      liveValidators([
        liveValidator({
          commission_accrued: (10n * HASH).toString(),
          commission_paid: (25n * HASH).toString(),
          commission_due: "0",
        }),
      ]),
    );
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.standing?.standing).toBe("prepaid");
    expect(data.standing?.prepaidCreditHash).toBe("15.0000");
  });

  it("surfaces jailed state and an open jail report with its purge instant", async () => {
    server.use(
      summary(),
      http.get("*/cosmwasm/wasm/v1/contract/:address/smart/:query", ({ params }) => {
        const decoded = Buffer.from(String(params["query"]), "base64").toString("utf8");
        const key = Object.keys(JSON.parse(decoded) as Record<string, unknown>)[0];
        if (key === "validators") {
          return HttpResponse.json({
            data: { validators: [liveValidator({ jailed: true, eligible: false })] },
          });
        }
        if (key === "jail_reports") {
          return HttpResponse.json({
            data: {
              reports: [
                {
                  valoper: VALOPER,
                  reported_at_seconds: 1_767_225_600,
                  purge_ready_at_seconds: 1_767_254_400,
                },
              ],
            },
          });
        }
        return HttpResponse.json({
          data: {
            admin: OPERATOR,
            vault_address: FIXTURE_VAULT_ADDRESS,
            underlying_denom: "nhash",
            receipt_denom: "nvhash.staked",
            max_delegations_per_run: 5,
            aum_fee_bps: 0,
            performance_threshold_bps: 9_500,
            min_capture_interval_secs: 0,
            max_concentration_multiple_bps: 55_000,
            min_bonded_cap_bps: 500,
            max_bonded_cap_bps: 3_300,
            concentration_safety_offset_bps: 500,
            commission_bps: 1_000,
            jail_unbond_delay_secs: 28_800,
          },
        });
      }),
    );
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.standing?.jailed).toBe(true);
    expect(data.standing?.jailReport?.purgeReadyAt).toBe("2026-01-01T08:00:00.000Z");
  });
});

describe("uptime honesty", () => {
  it("reports headroom against the configured threshold", async () => {
    server.use(summary(), liveValidators([liveValidator({ uptime_bps: 9_900 })]));
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.standing?.uptimePercent).toBe("99.00");
    expect(data.standing?.thresholdPercent).toBe("95.00");
    expect(data.standing?.uptimeHeadroomPercent).toBe("4.00");
  });

  it("an unmeasured uptime is n/a, and its headroom is too — never 0", async () => {
    server.use(summary(), liveValidators([liveValidator({ uptime_bps: null })]));
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.standing?.uptimePercent).toBeNull();
    expect(data.standing?.uptimeHeadroomPercent).toBeNull();
  });
});

describe("net benefit — the estimate is labeled, and absent when unknowable", () => {
  it("shows exact paid totals even when earnings cannot be estimated", async () => {
    // No staking commission rate for this valoper in the corpus → no estimate.
    server.use(summary(), liveValidators([liveValidator()]), epochs([epochRow(1), epochRow(2)]));
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.netBenefit?.commissionPaidTotalHash).toBe("10.0000");
    expect(data.netBenefit?.tipPaidTotalHash).toBe("2.0000");
    expect(data.netBenefit?.estimatedEarningsHash).toBeNull();
    // The net is withheld too — a net built from a missing term is a fiction.
    expect(data.netBenefit?.netBenefitHash).toBeNull();
  });

  it("computes and labels the estimate when every input is available", async () => {
    // The loader's wiring, end to end: the valoper's own x/staking commission
    // rate × the program's per-epoch return × this validator's delegation.
    // 1000 HASH for one year at 10% program APR, 10% rate → 10 HASH.
    const YEAR = 365 * 24 * 60 * 60;
    server.use(
      summary(),
      liveValidators([liveValidator()]),
      epochs([
        epochRow(1, { program_delegation: (1000n * HASH).toString() }),
        epochRow(2, { program_delegation: (1000n * HASH).toString() }),
      ]),
      http.get("*/cosmos/staking/v1beta1/validators", () =>
        HttpResponse.json({
          validators: [
            {
              operator_address: VALOPER,
              description: { moniker: "alpha" },
              status: "BOND_STATUS_BONDED",
              jailed: false,
              tokens: "1",
              commission: { commission_rates: { rate: "0.100000000000000000" } },
            },
          ],
          pagination: { next_key: null, total: "1" },
        }),
      ),
      http.get("*/api/v1/epochs", () =>
        HttpResponse.json(
          envelope(
            [
              {
                epoch_index: 1,
                ended_at: new Date(0).toISOString(),
                nav: "1.0",
                tvv: "0",
                net_apr_bps: 1000,
              },
              {
                epoch_index: 2,
                ended_at: new Date(YEAR * 1000).toISOString(),
                nav: "1.0",
                tvv: "0",
                net_apr_bps: 1000,
              },
            ],
            { source: "indexed" },
          ),
        ),
      ),
    );
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.netBenefit?.estimatedEarningsHash).toBe("10.0000");
    expect(data.netBenefit?.commissionRatePercent).toBe("10.00");
    expect(data.netBenefit?.epochsCovered).toBe(1);
    // net = 10 estimated − 10 commission − 2 TIP = −2 HASH, shown as a loss
    // rather than clamped: the answer to "is this worth it?" may be no.
    expect(data.netBenefit?.netBenefitHash).toBe("-2.0000");
  });

  it("never reports a zero estimate in place of an unknown one", async () => {
    server.use(summary(), liveValidators([liveValidator()]), epochs([epochRow(1)]));
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.netBenefit?.estimatedEarningsHash).not.toBe("0.0000");
    expect(data.netBenefit?.estimatedEarningsHash).toBeNull();
  });
});

describe("history composition", () => {
  it("orders the epoch table newest first and the chart oldest first", async () => {
    server.use(
      summary(),
      liveValidators([liveValidator()]),
      epochs([
        epochRow(3, { program_delegation: (3000n * HASH).toString() }),
        epochRow(2, { program_delegation: (2000n * HASH).toString() }),
        epochRow(1, { program_delegation: (1000n * HASH).toString() }),
      ]),
    );
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.epochs.map((e) => e.epochIndex)).toEqual([3, 2, 1]);
    expect(data.delegationHistory?.epochLabels).toEqual(["1", "2", "3"]);
    expect(data.delegationHistory?.points).toEqual([1000, 2000, 3000]);
    // The table mirrors the chart — the series is never chart-only.
    expect(data.delegationHistory?.rows).toEqual([
      ["1", "1000.0000"],
      ["2", "2000.0000"],
      ["3", "3000.0000"],
    ]);
  });

  it("flags a payment whose crediting epoch is still open, never guessing one", async () => {
    server.use(
      summary(),
      liveValidators([liveValidator()]),
      payments([
        {
          txhash: "PAY1",
          msg_index: 0,
          valoper: VALOPER,
          payer: OPERATOR,
          payment_type: "commission",
          amount: (5n * HASH).toString(),
          epoch_index: 2,
          height: 100,
          occurred_at: "2026-03-01T00:00:00.000Z",
        },
        {
          txhash: "PAY2",
          msg_index: 0,
          valoper: VALOPER,
          payer: "tp1cooppartner",
          payment_type: "tip",
          amount: (1n * HASH).toString(),
          epoch_index: null,
          height: 900,
          occurred_at: "2026-06-01T00:00:00.000Z",
        },
      ]),
    );
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.payments[0]).toMatchObject({ txhash: "PAY1", epochIndex: 2, paidByOther: false });
    expect(data.payments[1]).toMatchObject({ txhash: "PAY2", epochIndex: null, paidByOther: true });
  });

  it("marks a payer that is not the operator's own account", async () => {
    // Payment is permissionless, so this is a normal fact worth labeling.
    server.use(
      summary(),
      liveValidators([liveValidator()]),
      payments([
        {
          txhash: "PAYX",
          msg_index: 0,
          valoper: VALOPER,
          payer: "tp1someoneelse",
          payment_type: "commission",
          amount: (1n * HASH).toString(),
          epoch_index: 1,
          height: 10,
          occurred_at: "2026-02-01T00:00:00.000Z",
        },
      ]),
    );
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.payments[0]?.paidByOther).toBe(true);
  });

  it("a single settled epoch is not a series (chart cold state)", async () => {
    server.use(summary(), liveValidators([liveValidator()]), epochs([epochRow(1)]));
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.delegationHistory?.points).toHaveLength(1);
  });
});

describe("validator selection", () => {
  const OTHER_VALOPER = "tpvaloper1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

  it("defaults to the first owned validator", async () => {
    server.use(
      summary([summaryRow(), summaryRow({ valoper: OTHER_VALOPER, moniker: "beta" })]),
      liveValidators([liveValidator()]),
    );
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.owned).toHaveLength(2);
    expect(data.selectedValoper).toBe(VALOPER);
  });

  it("honors a requested valoper the operator owns", async () => {
    server.use(
      summary([summaryRow(), summaryRow({ valoper: OTHER_VALOPER, moniker: "beta" })]),
      liveValidators([liveValidator()]),
    );
    const data = await loadOperatorViewData(withKey(), SESSION, { valoper: OTHER_VALOPER });
    expect(data.selectedValoper).toBe(OTHER_VALOPER);
  });

  it("falls back to an owned validator when asked for one it does not operate", async () => {
    // Defense in depth: services/api would answer empty anyway, but the view
    // must not present another operator's valoper as the selection either.
    server.use(summary(), liveValidators([liveValidator()]));
    const data = await loadOperatorViewData(withKey(), SESSION, {
      valoper: "tpvaloper1notmineqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    });
    expect(data.selectedValoper).toBe(VALOPER);
  });
});

describe("boundary validation", () => {
  it("a malformed summary payload degrades to unavailable, never partial", async () => {
    server.use(
      liveValidators([liveValidator()]),
      http.get("*/api/v1/operator/summary", () =>
        HttpResponse.json(
          envelope({ address: OPERATOR, validators: [{ valoper: VALOPER }] }, { source: "indexed" }),
        ),
      ),
    );
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.personalReadsAvailable).toBe(false);
  });

  it("a payment amount that is not a base-unit integer fails the boundary", async () => {
    server.use(
      summary(),
      liveValidators([liveValidator()]),
      payments([
        {
          txhash: "BAD",
          msg_index: 0,
          valoper: VALOPER,
          payer: OPERATOR,
          payment_type: "commission",
          amount: "1.5",
          epoch_index: 1,
          height: 10,
          occurred_at: "2026-02-01T00:00:00.000Z",
        },
      ]),
    );
    const data = await loadOperatorViewData(withKey(), SESSION);
    expect(data.payments).toEqual([]);
  });
});
