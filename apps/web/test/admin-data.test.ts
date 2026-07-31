// The §8.8 dashboard's HONESTY MATRIX (plan invariants 14, 15 and 17) — the
// `operator-data.test.ts` idiom applied to the admin panels.
//
//  14 — PANELS DEGRADE INDIVIDUALLY AND HONESTLY. A missing input renders a
//       stated reason, never 0 and never a blank, and one failed panel does not
//       affect the others.
//  15 — THE FUNNEL NEVER OVERSTATES ITS PRECISION. Stage totals are event
//       totals; the chain-derived terminal stage is exact; the view keeps them
//       structurally apart so it cannot imply uniform precision.
//  17 — `/admin` IS NOT REACHABLE BY A NON-ADMIN, and a degraded membership
//       read renders "we could not check" rather than granting or denying.
//
// Also C4: state × affordance for the incident feed, exhaustively.

import { describe, expect, it } from "vitest";

import {
  toFunnelVM,
  toHolderCohortsVM,
  toIncidentRowVMs,
  toProgramHealthVM,
  toUpkeepVM,
  toValidatorCohortsVM,
} from "~/admin/admin.server";

const ADMIN_A = "tp1l39wu7cht0zcycc5rkcd90sdd4ksjmxwdf388y";
const ADMIN_B = "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad";

const HEALTH = {
  depositor_count: 12,
  epochs: [
    {
      epoch_index: 0,
      ended_at: "2026-01-01T02:00:00.000Z",
      tvv: "1000000000",
      net_apr_bps: 512,
      net_deposits: "250000000",
    },
    {
      epoch_index: 1,
      ended_at: "2026-02-01T02:00:00.000Z",
      tvv: "900000000",
      net_apr_bps: -120,
      net_deposits: "-50000000",
    },
  ],
  epochs_truncated: false,
};

describe("invariant 14: panels degrade individually, with a stated reason", () => {
  it("distinguishes a FAILED read from a cold start", () => {
    // Two different messages for two different facts. Collapsing them would
    // tell an administrator "no history yet" when the truth is "we could not
    // read it", which is the §12.1 lie in miniature.
    expect(toProgramHealthVM(null)).toEqual({ kind: "unavailable", reason: "read-failed" });
    expect(
      toProgramHealthVM({ depositor_count: null, epochs: [], epochs_truncated: false }),
    ).toEqual({ kind: "unavailable", reason: "cold-start" });
  });

  it("never renders 0 for an unknown depositor count", () => {
    const vm = toProgramHealthVM({ ...HEALTH, depositor_count: null });
    expect(vm.kind).toBe("data");
    if (vm.kind === "data") expect(vm.data.depositorCount).toBeNull();
  });

  it("marks a net-outflow epoch with a flag, not a colour", () => {
    const vm = toProgramHealthVM(HEALTH);
    expect(vm.kind).toBe("data");
    if (vm.kind === "data") {
      expect(vm.data.points[0]!.netOutflow).toBe(false);
      // A negative net flow is a real state and survives as one — the sign is
      // not floored away and the flag rides beside it.
      expect(vm.data.points[1]!.netOutflow).toBe(true);
      expect(vm.data.points[1]!.netDepositsHash.startsWith("-")).toBe(true);
      // A negative APR survives too (a slash epoch).
      expect(vm.data.points[1]!.netAprPercent).toBe("-1.20");
    }
  });

  it("one failed panel leaves the others intact", () => {
    // The whole point of per-panel endpoints: health fails, validators do not.
    const health = toProgramHealthVM(null);
    const validators = toValidatorCohortsVM({
      enrolled_now: 3,
      churned_total: 1,
      timeline: [
        {
          epoch_index: 0,
          ended_at: "2026-01-01T00:00:00.000Z",
          sampled: 3,
          eligible: 3,
          in_arrears: 0,
          tip_paying: 2,
          purged: 0,
        },
      ],
      timeline_truncated: false,
    });
    expect(health.kind).toBe("unavailable");
    expect(validators.kind).toBe("data");
  });

  it("reports the capture-signal distribution as NOT COLLECTED, not as empty", () => {
    const upkeep = toUpkeepVM({
      epoch_lag: { sample_count: 4, median_seconds: 7200, p90_seconds: 7200, buckets: [] },
      redemption_latency: { sample_count: 0, median_seconds: null, p90_seconds: null, buckets: [] },
      capture_cadence: null,
    });
    expect(upkeep.epochLag.kind).toBe("data");
    // Zero samples is a cold start — the program has settled nothing yet.
    expect(upkeep.redemptionLatency).toEqual({ kind: "unavailable", reason: "cold-start" });
    // Null is a MISSING FEATURE, and says so. An empty histogram here would
    // read as "measured: no capture gaps", which is a different claim.
    expect(upkeep.captureCadence).toEqual({ kind: "unavailable", reason: "not-collected" });
  });

  it("degrades all three upkeep distributions together when the read fails", () => {
    const upkeep = toUpkeepVM(null);
    for (const state of [upkeep.epochLag, upkeep.redemptionLatency, upkeep.captureCadence]) {
      expect(state).toEqual({ kind: "unavailable", reason: "read-failed" });
    }
  });
});

describe("invariant 12 at the view layer: withheld is not missing", () => {
  const COHORTS = {
    min_cohort_size: 5,
    adoption: [{ epoch_index: 0, ended_at: "2026-01-01T00:00:00.000Z", new_depositors: 3 }],
    adoption_truncated: false,
    retention: [
      {
        cohort_epoch: 0,
        cohort_size: 2,
        below_minimum: true,
        points: [
          { horizon: 1, retained_bps: null },
          { horizon: 3, retained_bps: null },
        ],
      },
      {
        cohort_epoch: 1,
        cohort_size: 9,
        below_minimum: false,
        points: [
          { horizon: 1, retained_bps: 8_888 },
          { horizon: 3, retained_bps: null },
        ],
      },
    ],
    retention_truncated: false,
    redemption_mix: { enqueued: 1, expedited: 2, matured: 3, refunded: 0 },
    concentration: null,
  };

  it("renders a withheld concentration as `below-minimum`, not as absent data", () => {
    const vm = toHolderCohortsVM(COHORTS);
    expect(vm.kind).toBe("data");
    if (vm.kind === "data") {
      expect(vm.data.concentration).toEqual({ kind: "unavailable", reason: "below-minimum" });
      // The threshold rides through as data, so the panel states the rule
      // rather than the web tier re-deciding it.
      expect(vm.data.minCohortSize).toBe(5);
    }
  });

  it("keeps `below_minimum` distinguishable from an unelapsed horizon", () => {
    const vm = toHolderCohortsVM(COHORTS);
    expect(vm.kind).toBe("data");
    if (vm.kind === "data") {
      const small = vm.data.curves.find((c) => c.cohortEpoch === 0)!;
      const large = vm.data.curves.find((c) => c.cohortEpoch === 1)!;
      // Both have a null point at horizon 3, and they mean opposite things.
      expect(small.belowMinimum).toBe(true);
      expect(small.points.every((p) => p.retainedPercent === null)).toBe(true);
      expect(large.belowMinimum).toBe(false);
      expect(large.points.find((p) => p.horizon === 1)!.retainedPercent).toBe("88.88");
      expect(large.points.find((p) => p.horizon === 3)!.retainedPercent).toBeNull();
    }
  });

  it("shows a banded concentration with shares only when it is served", () => {
    const vm = toHolderCohortsVM({
      ...COHORTS,
      concentration: { top1_bps: 5_000, top5_bps: 9_500, top10_bps: 10_000, holder_count: 6 },
    });
    expect(vm.kind).toBe("data");
    if (vm.kind === "data" && vm.data.concentration.kind === "data") {
      expect(vm.data.concentration.data).toEqual({
        top1Percent: "50.00",
        top5Percent: "95.00",
        top10Percent: "100.00",
        holderCount: 6,
      });
      // No amount, no address — the VM has no field for either.
      expect(Object.keys(vm.data.concentration.data).sort()).toEqual([
        "holderCount",
        "top10Percent",
        "top1Percent",
        "top5Percent",
      ]);
    }
  });
});

describe("invariant 15: the funnel never overstates its precision", () => {
  const ROWS = [
    { stage: "visit_learn_index", day: "2026-07-30", count: 40 },
    { stage: "visit_learn_index", day: "2026-07-31", count: 60 },
    { stage: "due_diligence_depth", day: "2026-07-31", count: 25 },
    { stage: "connect", day: "2026-07-31", count: 4 },
  ];

  it("keeps the chain-derived terminal stage OUT of the counter series", () => {
    const vm = toFunnelVM(ROWS, 3, 90);
    expect(vm.kind).toBe("data");
    if (vm.kind === "data") {
      // `first_deposit` is not a stage in the series — it is its own field,
      // because it is exact while the stages are unduplicated event totals.
      expect(vm.data.stages.map((s) => s.stage)).not.toContain("first_deposit");
      expect(vm.data.firstDeposits).toBe(3);
    }
  });

  it("sums per-day rows into per-stage event totals", () => {
    const vm = toFunnelVM(ROWS, 3, 90);
    if (vm.kind === "data") {
      const total = (stage: string) => vm.data.stages.find((s) => s.stage === stage)!.total;
      expect(total("visit_learn_index")).toBe(100);
      expect(total("due_diligence_depth")).toBe(25);
      expect(total("connect")).toBe(4);
      // A stage with no events in the window is 0, which is a MEASURED zero:
      // the counters are exhaustive over the window by construction, so
      // "nobody visited /market" is a fact, not an unknown.
      expect(total("visit_market")).toBe(0);
    }
  });

  it("reports every declared stage, so a missing row cannot read as a gap", () => {
    const vm = toFunnelVM([], 0, 90);
    // Cold start only when there is NOTHING at all — no rows and no
    // chain-derived figure either.
    expect(toFunnelVM([], null, 90)).toEqual({ kind: "unavailable", reason: "cold-start" });
    if (vm.kind === "data") expect(vm.data.stages).toHaveLength(5);
  });

  it("degrades to read-failed when the counter store is unreachable", () => {
    expect(toFunnelVM(null, 3, 90)).toEqual({ kind: "unavailable", reason: "read-failed" });
  });
});

describe("C4: incident state × affordance", () => {
  type Row = Parameters<typeof toIncidentRowVMs>[0] extends Array<infer R> | null ? R : never;
  const open: Row = {
    id: 1,
    kind: "epoch_overdue",
    severity: "warning",
    opened_at: "2026-07-30T00:00:00.000Z",
    closed_at: null,
    height: 100,
  };
  const closed: Row = { ...open, id: 2, closed_at: "2026-07-31T00:00:00.000Z" };
  const ackBy = (by: string) => ({
    acknowledgedBy: by,
    acknowledgedAt: new Date("2026-07-30T12:00:00.000Z"),
    note: null,
  });

  function affordanceOf(rows: Row[], acks: Map<number, ReturnType<typeof ackBy>>): string[] {
    const vm = toIncidentRowVMs(rows, acks, ADMIN_A);
    return vm.kind === "data" ? vm.data.map((r) => r.affordance) : ["unavailable"];
  }

  it("open + unacknowledged → acknowledge", () => {
    expect(affordanceOf([open], new Map())).toEqual(["acknowledge"]);
  });

  it("open + acknowledged by the SESSION admin → unacknowledge", () => {
    expect(affordanceOf([open], new Map([[1, ackBy(ADMIN_A)]]))).toEqual(["unacknowledge"]);
  });

  it("open + acknowledged by ANOTHER admin → no affordance, and the ack shows", () => {
    // Never re-offered as if unacknowledged: that would invite a write the
    // constraint permits but which would read on screen as though the first
    // ack had not happened.
    const vm = toIncidentRowVMs([open], new Map([[1, ackBy(ADMIN_B)]]), ADMIN_A);
    expect(vm.kind).toBe("data");
    if (vm.kind === "data") {
      expect(vm.data[0]!.affordance).toBe("none");
      expect(vm.data[0]!.ack).toMatchObject({ by: ADMIN_B, bySessionAdmin: false });
    }
  });

  it("closed → read only, whether acknowledged or not", () => {
    expect(affordanceOf([closed], new Map())).toEqual(["none"]);
    expect(affordanceOf([closed], new Map([[2, ackBy(ADMIN_A)]]))).toEqual(["none"]);
  });

  it("indexed read down → the feed degrades and offers NO ack control", () => {
    // Acknowledging an incident you cannot see is not a coherent action, so the
    // degraded feed has no rows at all rather than rows without controls.
    expect(toIncidentRowVMs(null, new Map(), ADMIN_A)).toEqual({
      kind: "unavailable",
      reason: "read-failed",
    });
  });
});
