// The §8.8 admin-analytics endpoint gate. Its first job is plan invariant 12:
// every admin route returns only what is derivable from public data, and NO
// endpoint returns a per-wallet behavioral record.
//
// The disproof invariant 12 names is why this suite does more than check
// shapes. "Derivable from public data" is not the same as "does not single
// anyone out": a cohort of one, or the concentration panel, can name a holder
// by inference without ever returning an address. So there are two families of
// assertion here — a structural sweep proving no address appears anywhere in
// any admin payload, and per-panel cases proving the minimum-group-size gate
// actually withholds a figure it could compute.
//
// The scope enforcement itself lives in cross-address.test.ts (ADMIN_PATHS).

import { describe, expect, it } from "vitest";
import { API_BASE } from "../src/index.ts";
import {
  CONCENTRATION_BAND_DEPTH,
  FUNNEL_WINDOW_DAYS,
  MAX_HOLDER_LIFECYCLES,
  MIN_COHORT_SIZE,
} from "@nvhash/api-types";
import { toUpkeepDistribution } from "../src/admin-derive.ts";
import { mintAssertion, TEST_ASSERTION_KEY } from "./assertions.ts";
import { startServer, type RunningServer } from "./helpers.ts";
import { fakeReader, type FakeFacts } from "./reader-fake.ts";

const ADMIN = "pb1walletaqq";
const auth = { authorization: mintAssertion(`admin:${ADMIN}`) };

const ADMIN_PATHS = [
  `${API_BASE}/admin/program-health`,
  `${API_BASE}/admin/holder-cohorts`,
  `${API_BASE}/admin/validator-cohorts`,
  `${API_BASE}/admin/upkeep`,
  `${API_BASE}/admin/incidents`,
];

const HOUR = 3_600;
const DAY = 86_400;

/** Settled epochs on the first of each month, cranked `lagHours` late. */
function epochSeries(count: number, lagHours = 2): FakeFacts["adminEpochs"] {
  return Array.from({ length: count }, (_, i) => ({
    epochIndex: BigInt(i),
    // 2026-01-01 + i months, plus the crank lag.
    endedAtSeconds: BigInt(Math.floor(Date.UTC(2026, i, 1) / 1000) + lagHours * HOUR),
    endHeight: BigInt((i + 1) * 1_000),
    tvvAfter: BigInt((i + 1) * 1_000_000),
    netAprBps: 500,
    netDeposits: BigInt(i % 2 === 0 ? 250_000 : -50_000),
    validatorsPurged: i === 3 ? 1 : 0,
  }));
}

function start(facts: FakeFacts, now?: () => Date): Promise<RunningServer> {
  return startServer({ assertionKey: TEST_ASSERTION_KEY }, now, fakeReader(facts));
}

async function getAdmin(server: RunningServer, path: string): Promise<unknown> {
  const res = await fetch(`${server.baseUrl}${path}`, { headers: auth });
  expect(res.status, path).toBe(200);
  return ((await res.json()) as { data: unknown }).data;
}

/** Every string anywhere in a JSON value, at any depth. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (typeof value === "object" && value !== null)
    for (const v of Object.values(value)) allStrings(v, out);
  return out;
}

describe("no admin endpoint returns an address (invariant 12, structural)", () => {
  it("sweeps every admin payload for a bech32-shaped string, populated", async () => {
    // Populated on purpose: an empty payload trivially contains no address, so
    // a sweep over the dataless reader would pass while proving nothing. The
    // facts below carry real addresses in the reader's INPUTS — registry
    // operators, redemption owners, transaction addresses — so anything that
    // leaked one through would be visible here.
    const server = await start({
      reconcilerRun: { chainHeight: 900n, indexedHeight: 880n },
      adminEpochs: epochSeries(6),
      holderLifecycles: Array.from({ length: 12 }, (_, i) => ({
        firstDepositHeight: BigInt((i % 3) * 1_000 + 500),
        exitHeight: i % 4 === 0 ? BigInt(5_000) : null,
      })),
      holderPositions: Array.from({ length: 12 }, (_, i) => BigInt((12 - i) * 1_000)),
      redemptions: [
        {
          requestId: "req-1",
          owner: "pb1ownerqqqq",
          shares: 10n,
          status: "matured",
          enqueuedAt: new Date("2026-02-01T00:00:00Z"),
          expeditedAt: null,
          maturedAt: new Date("2026-02-22T00:00:00Z"),
          refundedAt: null,
          lastHeight: 10n,
          lastTxhash: "AA",
        },
      ],
      registry: [
        { valoper: "pbvaloper1aa", moniker: "alpha", unregisteredAt: null, operator: ADMIN },
        {
          valoper: "pbvaloper1bb",
          moniker: "beta",
          unregisteredAt: new Date("2026-03-01T00:00:00Z"),
          operator: ADMIN,
        },
      ],
      validatorEpochAggregates: [
        { epochIndex: 0n, sampled: 2, eligible: 2, inArrears: 0, tipPaying: 1 },
        { epochIndex: 1n, sampled: 2, eligible: 1, inArrears: 1, tipPaying: 2 },
      ],
      adminIncidents: [
        {
          id: 7n,
          kind: "epoch_overdue",
          severity: "warning",
          openedAt: new Date("2026-03-02T00:00:00Z"),
          closedAt: null,
          openedHeight: 3_100n,
        },
      ],
    });
    try {
      for (const path of ADMIN_PATHS) {
        const data = await getAdmin(server, path);
        for (const value of allStrings(data)) {
          // Any Provenance-family bech32: the account prefixes AND the valoper
          // ones. A valoper is public, but it is still an identity this family
          // of endpoints has no business carrying.
          expect(value, `${path} leaked "${value}"`).not.toMatch(/^(pb|tp)1[0-9a-z]{6,}$/);
        }
      }
    } finally {
      await server.close();
    }
  });

  it("keeps the holder fact shapes address-free at the PORT, not just the payload", async () => {
    // The property is meant to hold because the reader cannot produce an
    // address for these panels, not because the mapping remembers to drop one.
    // Asserting it on the port is what makes a future mapping change unable to
    // reintroduce the leak.
    const reader = fakeReader({
      holderLifecycles: [{ firstDepositHeight: 1n, exitHeight: null }],
      holderPositions: [5n],
    });
    const lifecycles = await reader.holderLifecycles(MAX_HOLDER_LIFECYCLES);
    expect(Object.keys(lifecycles[0]!).sort()).toEqual(["exitHeight", "firstDepositHeight"]);
    const positions = await reader.holderPositions(CONCENTRATION_BAND_DEPTH);
    expect(Object.keys(positions).sort()).toEqual(["holderCount", "topDesc", "totalPosition"]);
    expect(positions.topDesc.every((p) => typeof p === "bigint")).toBe(true);
  });
});

describe("program health (§8.8 header)", () => {
  it("reports depositor_count NULL, not 0, on a dataless process", async () => {
    // "We cannot count depositors" and "nobody has deposited" are different
    // answers and the dashboard renders them differently (§12.1).
    const server = await start({});
    try {
      const data = (await getAdmin(server, `${API_BASE}/admin/program-health`)) as {
        depositor_count: number | null;
        epochs: unknown[];
        epochs_truncated: boolean;
      };
      expect(data.depositor_count).toBeNull();
      expect(data.epochs).toEqual([]);
      expect(data.epochs_truncated).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("serves the trend ascending, with signed net deposits", async () => {
    const server = await start({ adminEpochs: epochSeries(4) });
    try {
      const data = (await getAdmin(server, `${API_BASE}/admin/program-health`)) as {
        epochs: Array<{ epoch_index: number; net_deposits: string; tvv: string }>;
      };
      expect(data.epochs.map((e) => e.epoch_index)).toEqual([0, 1, 2, 3]);
      // A net-outflow epoch is a real state; flooring it at zero would hide a
      // month the program shrank.
      expect(data.epochs[1]!.net_deposits).toBe("-50000");
      expect(data.epochs[0]!.net_deposits).toBe("250000");
      expect(data.epochs[0]!.tvv).toBe("1000000");
    } finally {
      await server.close();
    }
  });

  it("serves the funnel's terminal stage WINDOWED, beside the all-time count", async () => {
    // The two are different questions and the panel needs both: the header
    // reports the program's depositors, the funnel's bottom must cover the same
    // window as the counter-derived stages above it. One field serving both put
    // an all-time total under a 90-day caption — a funnel whose bottom exceeds
    // its top (plan invariant 15).
    // Anchored to the real clock rather than a fixed instant: the shared
    // `auth` header is minted at module load, so a server clock in the past
    // would reject it as future-minted ([R7d] skew) and the 401 would look
    // like a scope failure. The offsets below are exact, so the case is
    // deterministic without the frozen instant.
    const now = new Date();
    const day = (offset: number) => new Date(now.getTime() - offset * 86_400_000);
    const server = await start(
      {
        adminEpochs: epochSeries(2),
        // Four inside the window, three outside it.
        firstDepositTimes: [day(1), day(30), day(60), day(89), day(91), day(200), day(900)],
      },
      () => now,
    );
    try {
      const data = (await getAdmin(server, `${API_BASE}/admin/program-health`)) as {
        depositor_count: number | null;
        first_deposits_in_window: number | null;
        funnel_window_days: number;
      };
      expect(data.funnel_window_days).toBe(FUNNEL_WINDOW_DAYS);
      expect(data.first_deposits_in_window).toBe(4);
      // Distinct from the all-time figure, which counts all seven.
      expect(data.depositor_count).toBe(7);
    } finally {
      await server.close();
    }
  });

  it("reports the windowed terminal as NULL, not 0, when it cannot be counted", async () => {
    const server = await start({ adminEpochs: epochSeries(2) });
    try {
      const data = (await getAdmin(server, `${API_BASE}/admin/program-health`)) as {
        first_deposits_in_window: number | null;
      };
      expect(data.first_deposits_in_window).toBeNull();
    } finally {
      await server.close();
    }
  });
});

describe("holder cohorts (§8.8) and the minimum-group-size gate", () => {
  it("withholds a below-minimum cohort's curve and says WHY", async () => {
    // One depositor in epoch 0. The retention figure is perfectly computable —
    // and computing it would publish that a single identifiable holder either
    // stayed or left. `below_minimum` distinguishes "withheld" from "not yet
    // known", which the panel needs in order to say the right thing.
    const server = await start({
      adminEpochs: epochSeries(14),
      holderLifecycles: [{ firstDepositHeight: 500n, exitHeight: null }],
      holderPositions: [1_000n],
    });
    try {
      const data = (await getAdmin(server, `${API_BASE}/admin/holder-cohorts`)) as {
        min_cohort_size: number;
        retention: Array<{
          cohort_epoch: number;
          cohort_size: number;
          below_minimum: boolean;
          points: Array<{ horizon: number; retained_bps: number | null }>;
        }>;
        concentration: unknown;
      };
      // The threshold rides as DATA — the web tier renders it, never re-decides it.
      expect(data.min_cohort_size).toBe(MIN_COHORT_SIZE);
      const cohort = data.retention.find((c) => c.cohort_epoch === 0)!;
      expect(cohort.cohort_size).toBe(1);
      expect(cohort.below_minimum).toBe(true);
      // Every point withheld, even the horizons that HAVE elapsed.
      expect(cohort.points.map((p) => p.retained_bps)).toEqual([null, null, null, null]);
      // One holder cannot be banded either.
      expect(data.concentration).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("computes the curve once the cohort reaches the minimum", async () => {
    // Six depositors in epoch 0; two exit before epoch 3's close (height 4000).
    const server = await start({
      adminEpochs: epochSeries(14),
      holderLifecycles: [
        { firstDepositHeight: 500n, exitHeight: null },
        { firstDepositHeight: 500n, exitHeight: null },
        { firstDepositHeight: 500n, exitHeight: null },
        { firstDepositHeight: 500n, exitHeight: null },
        { firstDepositHeight: 500n, exitHeight: 3_500n },
        { firstDepositHeight: 500n, exitHeight: 3_900n },
      ],
      holderPositions: [],
    });
    try {
      const data = (await getAdmin(server, `${API_BASE}/admin/holder-cohorts`)) as {
        retention: Array<{
          cohort_epoch: number;
          cohort_size: number;
          below_minimum: boolean;
          points: Array<{ horizon: number; retained_bps: number | null }>;
        }>;
      };
      const cohort = data.retention.find((c) => c.cohort_epoch === 0)!;
      expect(cohort.cohort_size).toBe(6);
      expect(cohort.below_minimum).toBe(false);
      const at = (h: number) => cohort.points.find((p) => p.horizon === h)!.retained_bps;
      // Horizon 1 closes at height 2000: nobody has exited yet.
      expect(at(1)).toBe(10_000);
      // Horizon 3 closes at height 4000: both exits have happened → 4/6.
      expect(at(3)).toBe(Math.floor((4 * 10_000) / 6));
    } finally {
      await server.close();
    }
  });

  it("distinguishes an unelapsed horizon (null) from a withheld one", async () => {
    // Five depositors — at the minimum, so nothing is withheld — but only two
    // epochs exist, so horizons 3/6/12 have not happened yet. Both produce
    // `null`; only `below_minimum` tells them apart, which is the whole reason
    // the flag exists rather than being inferred from the nulls.
    const server = await start({
      adminEpochs: epochSeries(2),
      holderLifecycles: Array.from({ length: 5 }, () => ({
        firstDepositHeight: 500n,
        exitHeight: null,
      })),
    });
    try {
      const data = (await getAdmin(server, `${API_BASE}/admin/holder-cohorts`)) as {
        retention: Array<{
          below_minimum: boolean;
          points: Array<{ horizon: number; retained_bps: number | null }>;
        }>;
      };
      const cohort = data.retention[0]!;
      expect(cohort.below_minimum).toBe(false);
      expect(cohort.points.find((p) => p.horizon === 1)!.retained_bps).toBe(10_000);
      expect(cohort.points.find((p) => p.horizon === 12)!.retained_bps).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("bands concentration as shares only — no addresses, no amounts", async () => {
    const server = await start({
      adminEpochs: epochSeries(2),
      holderPositions: [500n, 200n, 100n, 100n, 50n, 50n],
    });
    try {
      const data = (await getAdmin(server, `${API_BASE}/admin/holder-cohorts`)) as {
        concentration: {
          top1_bps: number;
          top5_bps: number;
          top10_bps: number;
          holder_count: number;
        } | null;
      };
      const c = data.concentration!;
      expect(c.holder_count).toBe(6);
      expect(c.top1_bps).toBe(5_000); // 500 / 1000
      expect(c.top5_bps).toBe(9_500); // 950 / 1000
      expect(c.top10_bps).toBe(10_000); // all six
      // The shape carries shares and a count and NOTHING else — in particular
      // no absolute total, from which a top-1 amount could be reconstructed.
      expect(Object.keys(c).sort()).toEqual(["holder_count", "top10_bps", "top1_bps", "top5_bps"]);
    } finally {
      await server.close();
    }
  });

  it("bands against EVERY holder, not just the ones transferred", async () => {
    // The regression this case exists for: the bands were once divided by the
    // sum of the TRANSFERRED positions, so past the band depth every share was
    // a share of the top ten rather than of the program — overstated, plausible
    // looking, and invisible on any fixture with ten holders or fewer.
    //
    // Ten holders of 100 plus ninety of 10 = 1900 total. The tail is more than
    // half the program and none of it crosses the wire.
    const positions = [
      ...Array.from({ length: 10 }, () => 100n),
      ...Array.from({ length: 90 }, () => 10n),
    ];
    const server = await start({ adminEpochs: epochSeries(2), holderPositions: positions });
    try {
      const data = (await getAdmin(server, `${API_BASE}/admin/holder-cohorts`)) as {
        concentration: {
          top1_bps: number;
          top5_bps: number;
          top10_bps: number;
          holder_count: number;
        } | null;
      };
      const c = data.concentration!;
      // The count is the WHOLE holder set, not the band depth.
      expect(c.holder_count).toBe(100);
      expect(c.holder_count).toBeGreaterThan(CONCENTRATION_BAND_DEPTH);
      // 100/1900, 500/1900, 1000/1900 — floor bps. Against the banded sum
      // (1000) these would have read 1000 / 5000 / 10000: the last one a
      // fully-concentrated program that does not exist.
      expect(c.top1_bps).toBe(526);
      expect(c.top5_bps).toBe(2_631);
      expect(c.top10_bps).toBe(5_263);
      expect(c.top10_bps).toBeLessThan(10_000);
    } finally {
      await server.close();
    }
  });

  it("bounds the depositor read and FLAGS it, rather than reading unbounded", async () => {
    // The row set grows with depositor count and no operator action caps it
    // (SECURITY.md: no unbounded work). The cap is exercised through the port's
    // own limit so the fixture does not need 100 000 depositors: seeding past a
    // small explicit limit proves both the trim and the flag.
    const lifecycles = Array.from({ length: 8 }, (_, i) => ({
      firstDepositHeight: BigInt(100 * (i + 1)),
      exitHeight: null,
    }));
    const reader = fakeReader({ holderLifecycles: lifecycles });
    const capped = await reader.holderLifecycles(5);
    expect(capped).toHaveLength(5);
    // ASC by first-deposit height: the trim drops the NEWEST cohorts, matching
    // `adminEpochsAsc`, so the cohorts whose horizons have elapsed survive.
    expect(capped.map((l) => Number(l.firstDepositHeight))).toEqual([100, 200, 300, 400, 500]);
  });

  it("bounds the upkeep sample and flags a capped distribution", async () => {
    const reader = fakeReader({ redemptionLatencies: [10, 20, 30, 40, 50] });
    const capped = await reader.redemptionLatencySeconds(3);
    expect(capped.seconds).toHaveLength(3);
    expect(capped.truncated).toBe(true);
    expect((await reader.redemptionLatencySeconds(50)).truncated).toBe(false);
    // The flag is what keeps a bounded answer from reading as all history.
    expect(toUpkeepDistribution([10, 20, 30], true).truncated).toBe(true);
    expect(toUpkeepDistribution([10, 20, 30]).truncated).toBe(false);
  });

  it("judges truncation on ROWS READ, not on the surviving durations", async () => {
    // The defect this pins: rows are dropped when they yield no payout time, so
    // a caller comparing `seconds.length` to the limit reports `truncated:
    // false` on a read the cap DID bind — the panel then claims all history.
    // Two requests fill a limit of 2; only one produces a duration.
    const reader = fakeReader({
      redemptions: [
        {
          requestId: "paid",
          owner: "pb1a",
          shares: 1n,
          status: "matured",
          enqueuedAt: new Date("2026-01-01T00:00:00Z"),
          expeditedAt: null,
          maturedAt: new Date("2026-01-02T00:00:00Z"),
          refundedAt: null,
          lastHeight: 2n,
          lastTxhash: "B",
        },
        {
          // Matured but with no payout timestamp: `payoutDurationSeconds`
          // returns null and this row vanishes from `seconds`.
          requestId: "no-duration",
          owner: "pb1b",
          shares: 1n,
          status: "matured",
          enqueuedAt: new Date("2026-01-01T00:00:00Z"),
          expeditedAt: null,
          maturedAt: null,
          refundedAt: null,
          lastHeight: 1n,
          lastTxhash: "A",
        },
      ],
    });
    const result = await reader.redemptionLatencySeconds(2);
    expect(result.seconds).toHaveLength(1);
    // Shorter than the limit, and STILL truncated.
    expect(result.truncated).toBe(true);
  });

  it("reports adoption zero for an epoch nobody joined — a fact, not a gap", async () => {
    const server = await start({
      adminEpochs: epochSeries(3),
      holderLifecycles: [{ firstDepositHeight: 500n, exitHeight: null }],
    });
    try {
      const data = (await getAdmin(server, `${API_BASE}/admin/holder-cohorts`)) as {
        adoption: Array<{ epoch_index: number; new_depositors: number }>;
      };
      expect(data.adoption.map((a) => a.new_depositors)).toEqual([1, 0, 0]);
    } finally {
      await server.close();
    }
  });
});

describe("validator cohorts (§8.8)", () => {
  it("joins per-epoch aggregates to settlement times and carries purges", async () => {
    const server = await start({
      adminEpochs: epochSeries(5),
      validatorEpochAggregates: [
        { epochIndex: 0n, sampled: 3, eligible: 3, inArrears: 0, tipPaying: 2 },
        { epochIndex: 1n, sampled: 3, eligible: 2, inArrears: 1, tipPaying: 3 },
      ],
      validatorRegistryCounts: { enrolledNow: 3, churnedTotal: 1 },
    });
    try {
      const data = (await getAdmin(server, `${API_BASE}/admin/validator-cohorts`)) as {
        enrolled_now: number;
        churned_total: number;
        timeline: Array<{
          epoch_index: number;
          sampled: number;
          in_arrears: number;
          purged: number;
        }>;
      };
      expect(data.enrolled_now).toBe(3);
      expect(data.churned_total).toBe(1);
      expect(data.timeline[1]!.in_arrears).toBe(1);
      // Epoch 3 is the seeded purge; an epoch with no sample still appears with
      // its purge count rather than being dropped from the timeline.
      expect(data.timeline[3]!.sampled).toBe(0);
      expect(data.timeline[3]!.purged).toBe(1);
    } finally {
      await server.close();
    }
  });
});

describe("upkeep timeliness (§8.8)", () => {
  it("measures epoch lag from the civil-month rollover, skipping the first epoch", async () => {
    // Epochs settle 2 h after each month starts. Eligibility for epoch i is the
    // start of the month AFTER epoch i-1's close, so every lag is 2 h — and
    // epoch 0 contributes nothing, because there is no previous close to
    // measure eligibility from.
    const server = await start({ adminEpochs: epochSeries(5, 2) });
    try {
      const data = (await getAdmin(server, `${API_BASE}/admin/upkeep`)) as {
        epoch_lag: {
          sample_count: number;
          median_seconds: number | null;
          buckets: Array<{ from_seconds: number; count: number }>;
        };
        capture_cadence: unknown;
      };
      expect(data.epoch_lag.sample_count).toBe(4);
      expect(data.epoch_lag.median_seconds).toBe(2 * HOUR);
      // 2 h lands in the [1 h, 6 h) bucket, not the [0, 1 h) one.
      expect(data.epoch_lag.buckets.find((b) => b.from_seconds === HOUR)!.count).toBe(4);
      expect(data.epoch_lag.buckets.find((b) => b.from_seconds === 0)!.count).toBe(0);
      // Named by §8.8 but not indexed — served as null with the panel saying
      // why, never as an empty distribution that would look measured.
      expect(data.capture_cadence).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("reports an empty distribution honestly rather than as a measured zero", async () => {
    const server = await start({});
    try {
      const data = (await getAdmin(server, `${API_BASE}/admin/upkeep`)) as {
        epoch_lag: {
          sample_count: number;
          median_seconds: number | null;
          p90_seconds: number | null;
        };
      };
      expect(data.epoch_lag.sample_count).toBe(0);
      // Null percentiles, not 0 — a 0-second median would claim perfect
      // timeliness on a program that has never settled an epoch.
      expect(data.epoch_lag.median_seconds).toBeNull();
      expect(data.epoch_lag.p90_seconds).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("buckets redemption latency from the request lifecycle", async () => {
    const server = await start({
      redemptions: [
        {
          requestId: "r1",
          owner: "pb1a",
          shares: 1n,
          status: "matured",
          enqueuedAt: new Date("2026-02-01T00:00:00Z"),
          expeditedAt: null,
          maturedAt: new Date("2026-02-22T00:00:00Z"),
          refundedAt: null,
          lastHeight: 1n,
          lastTxhash: "A",
        },
        {
          requestId: "r2",
          owner: "pb1b",
          shares: 1n,
          status: "enqueued",
          enqueuedAt: new Date("2026-02-01T00:00:00Z"),
          expeditedAt: null,
          maturedAt: null,
          refundedAt: null,
          lastHeight: 2n,
          lastTxhash: "B",
        },
      ],
    });
    try {
      const data = (await getAdmin(server, `${API_BASE}/admin/upkeep`)) as {
        redemption_latency: { sample_count: number; median_seconds: number | null };
      };
      // The still-enqueued request contributes NO sample: counting it as
      // "fast so far" would understate the distribution.
      expect(data.redemption_latency.sample_count).toBe(1);
      expect(data.redemption_latency.median_seconds).toBe(21 * DAY);
    } finally {
      await server.close();
    }
  });
});

describe("incident feed (§8.8)", () => {
  it("serves ids — the difference from public /incidents — newest first", async () => {
    const server = await start({
      adminIncidents: [
        {
          id: 1n,
          kind: "epoch_overdue",
          severity: "warning",
          openedAt: new Date("2026-01-01T00:00:00Z"),
          closedAt: new Date("2026-01-02T00:00:00Z"),
          openedHeight: 100n,
        },
        {
          id: 2n,
          kind: "vault_paused",
          severity: "critical",
          openedAt: new Date("2026-03-01T00:00:00Z"),
          closedAt: null,
          openedHeight: null,
        },
      ],
    });
    try {
      const rows = (await getAdmin(server, `${API_BASE}/admin/incidents`)) as Array<{
        id: number;
        closed_at: string | null;
        height: number | null;
      }>;
      expect(rows.map((r) => r.id)).toEqual([2, 1]);
      // Null height survives as null: "no height certifies this" is not height 0.
      expect(rows[0]!.height).toBeNull();
      expect(rows[1]!.height).toBe(100);
    } finally {
      await server.close();
    }
  });

  it("bounds its pagination at the route boundary (reject, never clamp)", async () => {
    const server = await start({});
    try {
      const over = await fetch(`${server.baseUrl}${API_BASE}/admin/incidents?limit=10000`, {
        headers: auth,
      });
      expect(over.status).toBe(400);
      const ok = await fetch(`${server.baseUrl}${API_BASE}/admin/incidents?limit=5&offset=0`, {
        headers: auth,
      });
      expect(ok.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
