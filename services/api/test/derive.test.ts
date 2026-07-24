// Unit: the pure derivation layer (indexed facts → frozen API shapes).
// Covers the review resolutions of docs/plans/2026-07-22-app-m3-query-api.md:
// [R1] NAV via the shared scale-then-floor helper (corpus golden value),
// [R7a] loud safe-integer guards on every height/index crossing into JSON,
// and the honest-null rules (empty-vault NAV, unsampled validators,
// un-indexed metrics).

import { describe, expect, it } from "vitest";
import {
  deriveHeads,
  deriveMetrics,
  derivePayoutStats,
  derivePortfolio,
  deriveSetHealth,
  deriveValidatorsPayload,
  navPriceNhash,
  parseDepthBands,
  payoutDurationSeconds,
  PAYOUT_STATS_MIN_SAMPLE,
  percentileSeconds,
  premiumDiscountBps,
  REDEMPTION_BAND_CEILING_SECONDS,
  REDEMPTION_BAND_FLOOR_SECONDS,
  toEpochRow,
  toIncidentRow,
  toMarketSample,
  toSafeInt,
  toSafeSignedInt,
  toValidatorRow,
  type RedemptionFacts,
} from "../src/derive.ts";

// Corpus values (@nvhash/fixtures queries/vault/get.json) — the same goldens
// that pin the shared helper in packages/api-types/test/amounts.test.ts.
const FIXTURE_TVV = 315397882283n;
const FIXTURE_SHARES = 309963777029000000n;

describe("toSafeInt ([R7a] corrupt heights fail loudly)", () => {
  it("converts an in-range bigint", () => {
    expect(toSafeInt(4242n, "h")).toBe(4242);
  });

  it("throws on negative and on beyond-safe-integer values", () => {
    expect(() => toSafeInt(-1n, "h")).toThrow(RangeError);
    expect(() => toSafeInt(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "h")).toThrow(RangeError);
  });
});

describe("deriveHeads", () => {
  it("uses the latest reconciler run when present", () => {
    expect(deriveHeads({ chainHeight: 4242n, indexedHeight: 4200n }, 9999n)).toEqual({
      chainHeight: 4242,
      indexedHeight: 4200,
    });
  });

  it("falls back to the worker checkpoint with a null chain head", () => {
    expect(deriveHeads(null, 4100n)).toEqual({ chainHeight: null, indexedHeight: 4100 });
  });

  it("reports honest nulls on a cold store", () => {
    expect(deriveHeads(null, null)).toEqual({ chainHeight: null, indexedHeight: null });
  });
});

describe("deriveMetrics", () => {
  it("is all-null until a worker stream has committed", () => {
    expect(
      deriveMetrics({ indexed: false, participantCount: 7, firstActivityAt: new Date(), epochCount: 3 }),
    ).toEqual({ participant_count: null, program_started_at: null, epoch_count: null });
  });

  it("reports honest zeros once indexed (empty ≠ unknown)", () => {
    expect(deriveMetrics({ indexed: true, participantCount: 0, firstActivityAt: null, epochCount: 0 }))
      .toEqual({ participant_count: 0, program_started_at: null, epoch_count: 0 });
  });
});

describe("toEpochRow", () => {
  const base = {
    epochIndex: 12n,
    endedAtSeconds: 1_767_225_600n, // 2026-01-01T00:00:00Z
    tvvAfter: FIXTURE_TVV,
    totalShares: FIXTURE_SHARES,
    netAprBps: 431,
  };

  it("computes the corpus NAV through the shared helper ([R1])", () => {
    const row = toEpochRow(base);
    expect(row).toEqual({
      epoch_index: 12,
      ended_at: "2026-01-01T00:00:00.000Z",
      nav: "1.0175",
      tvv: FIXTURE_TVV.toString(),
      net_apr_bps: 431,
    });
  });

  it("reports a null NAV for a zero-share epoch instead of fabricating one", () => {
    expect(toEpochRow({ ...base, totalShares: 0n }).nav).toBeNull();
  });
});

describe("toIncidentRow", () => {
  it("maps heights and closure honestly", () => {
    const opened = new Date("2026-07-01T00:00:00Z");
    expect(
      toIncidentRow({ kind: "indexer_lag", severity: "warning", openedAt: opened, closedAt: null, openedHeight: 900n }),
    ).toEqual({ kind: "indexer_lag", severity: "warning", opened_at: opened.toISOString(), closed_at: null, height: 900 });
    expect(
      toIncidentRow({ kind: "contract_halted", severity: "critical", openedAt: opened, closedAt: opened, openedHeight: null }).height,
    ).toBeNull();
  });
});

describe("validators derivation", () => {
  const reg = { valoper: "pbvaloper1aaa", moniker: "alpha", unregisteredAt: null };
  const epoch = {
    valoper: "pbvaloper1aaa",
    epochIndex: 12n,
    uptimeBps: 9990,
    eligible: true,
    failingReasons: [],
    programDelegation: 1_000_000_000n,
    commissionDue: 5n,
  };

  it("joins a validator to its latest sample", () => {
    expect(toValidatorRow(reg, epoch)).toEqual({
      valoper: "pbvaloper1aaa",
      moniker: "alpha",
      active: true,
      epoch_index: 12,
      uptime_bps: 9990,
      eligible: true,
      failing_reasons: [],
      program_delegation: "1000000000",
      commission_due: "5",
    });
  });

  it("reports null per-epoch fields before any sample (never a fabricated 0)", () => {
    const row = toValidatorRow(reg, null);
    expect(row.epoch_index).toBeNull();
    expect(row.uptime_bps).toBeNull();
    expect(row.eligible).toBeNull();
    expect(row.program_delegation).toBeNull();
    expect(row.commission_due).toBeNull();
  });

  it("aggregates set health over active validators only", () => {
    const rows = [
      toValidatorRow(reg, epoch), // active, eligible, in arrears (due 5)
      toValidatorRow({ valoper: "pbvaloper1bbb", moniker: "bravo", unregisteredAt: null }, { ...epoch, valoper: "pbvaloper1bbb", eligible: false, commissionDue: 0n }),
      toValidatorRow({ valoper: "pbvaloper1ccc", moniker: "chuck", unregisteredAt: new Date() }, { ...epoch, valoper: "pbvaloper1ccc", commissionDue: 7n }), // unregistered: excluded from active counts
    ];
    expect(deriveSetHealth(rows)).toEqual({ total: 3, active: 2, eligible: 1, in_arrears: 1 });
  });

  it("assembles the payload with per-valoper latest samples", () => {
    const payload = deriveValidatorsPayload([reg], new Map([[reg.valoper, epoch]]));
    expect(payload.validators).toHaveLength(1);
    expect(payload.set_health.total).toBe(1);
  });
});

describe("portfolio derivation (PR 3.3, [R2] indexed facts only)", () => {
  const active = {
    requestId: "req-1",
    owner: "pb1walletaqq",
    shares: 500n,
    status: "enqueued" as const,
    enqueuedAt: new Date("2026-06-03T00:00:00Z"),
    expeditedAt: null,
    maturedAt: null,
    refundedAt: null,
    lastHeight: 300n,
    lastTxhash: "CC",
  };

  it("sums escrow over active redemptions with BigInt discipline", () => {
    const summary = derivePortfolio("pb1walletaqq", new Date("2026-06-01T00:00:00Z"), 2, [
      active,
      { ...active, requestId: "req-2", shares: 250n, status: "expedited" },
    ]);
    expect(summary.escrowed_shares).toBe("750");
    expect(summary.transaction_count).toBe(2);
    expect(summary.first_activity_at).toBe("2026-06-01T00:00:00.000Z");
    expect(summary.active_redemptions).toHaveLength(2);
    // [R2]: the frozen shape carries NO balance field to misstate.
    expect(Object.keys(summary).sort()).toEqual([
      "active_redemptions",
      "address",
      "escrowed_shares",
      "first_activity_at",
      "transaction_count",
    ]);
  });

  it("refuses a non-active redemption in the escrow set (defensive guard)", () => {
    expect(() =>
      derivePortfolio("pb1walletaqq", null, 0, [{ ...active, status: "matured" }]),
    ).toThrow(RangeError);
  });
});

describe("market derivation (PR 3.2)", () => {
  it("toSafeSignedInt admits negatives but rejects beyond-safe magnitudes", () => {
    expect(toSafeSignedInt(-300n, "bps")).toBe(-300);
    expect(() => toSafeSignedInt(-(BigInt(Number.MAX_SAFE_INTEGER) + 1n), "bps")).toThrow(RangeError);
  });

  it("navPriceNhash floors tvv·10^15/shares and nulls a zero-share epoch", () => {
    expect(navPriceNhash(2n * 10n ** 9n, 2n * 10n ** 15n)).toBe(10n ** 9n);
    expect(navPriceNhash(FIXTURE_TVV, FIXTURE_SHARES)?.toString().startsWith("10175")).toBe(true); // cross-pins the display golden "1.0175"
    expect(navPriceNhash(FIXTURE_TVV, 0n)).toBeNull();
  });

  it("premiumDiscountBps is signed, truncated toward zero, null without a NAV", () => {
    const nav = 1_000_000_000n;
    expect(premiumDiscountBps(1_030_000_000n, nav)).toBe(300);
    expect(premiumDiscountBps(970_000_000n, nav)).toBe(-300);
    expect(premiumDiscountBps(1_000_000_100n, nav)).toBe(0); // sub-bps truncates, never rounds away from zero
    expect(premiumDiscountBps(1_030_000_000n, null)).toBeNull();
    expect(premiumDiscountBps(1_030_000_000n, 0n)).toBeNull();
  });

  it("parseDepthBands validates the stored JSON at the boundary", () => {
    const bands = [{ side: "buy", slippage_bps: 50, amount: "1000000000000000" }];
    expect(parseDepthBands(bands)).toEqual(bands);
    expect(parseDepthBands([])).toEqual([]);
    for (const bad of [
      "not an array",
      [{ side: "hold", slippage_bps: 50, amount: "1" }],
      [{ side: "buy", slippage_bps: -1, amount: "1" }],
      [{ side: "buy", slippage_bps: 50, amount: "1.5" }],
    ]) {
      expect(() => parseDepthBands(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });

  it("toMarketSample carries venue + sample time in the payload ([R6] labeled)", () => {
    const sample = toMarketSample(
      {
        venue: "uniswap-v3",
        pool: "0xpool",
        priceNhash: 1_030_000_000n,
        depthBands: [{ side: "sell", slippage_bps: 100, amount: "5" }],
        sampledAt: new Date("2026-07-10T12:00:00Z"),
      },
      1_000_000_000n,
    );
    expect(sample).toEqual({
      venue: "uniswap-v3",
      pool: "0xpool",
      price: "1030000000",
      premium_discount_bps: 300,
      depth_bands: [{ side: "sell", slippage_bps: 100, amount: "5" }],
      sampled_at: "2026-07-10T12:00:00.000Z",
    });
  });
});

describe("payout statistics (§9.5.3, §14.12)", () => {
  const DAY = 24 * 60 * 60;

  function terminal(enqueuedIso: string, expedited: string | null, matured: string | null): RedemptionFacts {
    return {
      requestId: "r",
      owner: "pb1owner",
      shares: 1_000n,
      status: matured !== null ? "matured" : "expedited",
      enqueuedAt: new Date(enqueuedIso),
      expeditedAt: expedited === null ? null : new Date(expedited),
      maturedAt: matured === null ? null : new Date(matured),
      refundedAt: null,
      lastHeight: 1n,
      lastTxhash: "tx",
    };
  }

  it("percentileSeconds interpolates linearly", () => {
    expect(percentileSeconds([10], 50)).toBe(10);
    expect(percentileSeconds([10, 20, 30, 40], 50)).toBe(25);
    expect(percentileSeconds([10, 20, 30, 40, 50], 90)).toBe(46);
  });

  it("payoutDurationSeconds uses expedited over matured; null when never paid", () => {
    expect(
      payoutDurationSeconds(terminal("2026-06-01T00:00:00Z", "2026-06-22T00:00:00Z", null)),
    ).toBe(21 * DAY);
    // expedited wins even when both are set.
    expect(
      payoutDurationSeconds(terminal("2026-06-01T00:00:00Z", "2026-06-25T00:00:00Z", "2026-07-30T00:00:00Z")),
    ).toBe(24 * DAY);
    // refund-only (no payout) → null, excluded from the cohort.
    const refundOnly: RedemptionFacts = {
      ...terminal("2026-06-01T00:00:00Z", null, null),
      status: "refunded",
      refundedAt: new Date("2026-08-01T00:00:00Z"),
    };
    expect(payoutDurationSeconds(refundOnly)).toBeNull();
  });

  it("exposes median/p90 only at/above the ≥10-terminal threshold", () => {
    const below = derivePayoutStats(
      Array.from({ length: PAYOUT_STATS_MIN_SAMPLE - 1 }, () => 30 * DAY),
      2,
    );
    expect(below.sample_count).toBe(9);
    expect(below.median_seconds).toBeNull();
    expect(below.p90_seconds).toBeNull();
    expect(below.cold_start).toBe(false);

    const durations = Array.from({ length: 12 }, (_, i) => (20 + i) * DAY); // 20..31d
    const ok = derivePayoutStats(durations, 2);
    expect(ok.sample_count).toBe(12);
    expect(ok.median_seconds).toBe(percentileSeconds([...durations].sort((a, b) => a - b), 50));
    expect(ok.p90_seconds).toBe(percentileSeconds([...durations].sort((a, b) => a - b), 90));
  });

  it("cold-start (no completed epoch) gates the stat regardless of sample size", () => {
    const stats = derivePayoutStats(Array.from({ length: 50 }, () => 30 * DAY), 0);
    expect(stats.cold_start).toBe(true);
    expect(stats.median_seconds).toBeNull();
    expect(stats.p90_seconds).toBeNull();
    expect(stats.sample_count).toBe(50);
  });

  it("always carries the 21–60-day band bounds as data", () => {
    const stats = derivePayoutStats([], 0);
    expect(stats.band_floor_seconds).toBe(REDEMPTION_BAND_FLOOR_SECONDS);
    expect(stats.band_ceiling_seconds).toBe(REDEMPTION_BAND_CEILING_SECONDS);
    expect(REDEMPTION_BAND_FLOOR_SECONDS).toBe(21 * DAY);
    expect(REDEMPTION_BAND_CEILING_SECONDS).toBe(60 * DAY);
  });
});
