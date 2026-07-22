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
  deriveSetHealth,
  deriveValidatorsPayload,
  toEpochRow,
  toIncidentRow,
  toSafeInt,
  toValidatorRow,
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
