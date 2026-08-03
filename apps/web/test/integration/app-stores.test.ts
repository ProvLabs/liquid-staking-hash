// Postgres-backed `app`-schema gate: the REAL Prisma stores for the two tables
// PR 7.5–7.6 introduced, run as `app_writer` against a migrated database.
//
// WHY THIS SUITE EXISTS. The unit suites drive the in-memory stand-ins, so
// `PrismaFunnelCounterStore` and `PrismaIncidentAckStore` shipped with no
// automated coverage of their own. That is not a coverage statistic — it is a
// gate sitting next to the defect it is meant to catch, because both classes
// implement CONCURRENCY remedies (plan §4b C3) whose entire point is behaviour
// the in-memory store CANNOT exhibit:
//
//   * the funnel increment is `ON CONFLICT DO UPDATE SET count = count + 1`,
//     one statement under the conflict's own row lock. In memory it is a Map
//     write, which cannot lose an update no matter how the SQL is written.
//   * the acknowledgment reversal is a CONDITIONAL `updateMany`. In memory the
//     find-then-set is atomic because JavaScript is single-threaded, so an
//     in-memory test passes against a read-then-write SQL implementation too.
//   * `AckConflict` is raised from a Postgres unique violation on a PARTIAL
//     index Prisma cannot express, so the mapping is only real here.
//
// Env (fail loudly — this suite is only ever invoked deliberately):
//   APP_WRITER_DATABASE_URL  postgresql://app_writer:…?schema=app

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import {
  AckConflict,
  PrismaIncidentAckStore,
  type IncidentAckStore,
} from "~/lib/models/incident-acks.server";
import { PrismaFunnelCounterStore } from "~/lib/models/funnel-counters.server";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the app-schema store gate`);
  return value;
}

/** An incident id past 2^31 — the reason the column is BIGINT rather than the
 * INTEGER it shipped as. A narrower column refuses this outright. */
const BIG_INCIDENT_ID = 3_000_000_000;

const ADMIN_A = "tp1l39wu7cht0zcycc5rkcd90sdd4ksjmxwdf388y";
const ADMIN_B = "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad";

describe("app-schema Prisma stores over app_writer", () => {
  let prisma: PrismaClient;
  let acks: IncidentAckStore;
  let funnel: PrismaFunnelCounterStore;

  beforeAll(() => {
    prisma = new PrismaClient({ datasourceUrl: requireEnv("APP_WRITER_DATABASE_URL") });
    acks = new PrismaIncidentAckStore(prisma as never);
    funnel = new PrismaFunnelCounterStore(prisma as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Idempotent re-run: clear exactly what this suite writes.
    await prisma.incidentAck.deleteMany();
    await prisma.$executeRawUnsafe('DELETE FROM "app"."funnel_counters"');
  });

  // ── funnel counters (§14.10) ─────────────────────────────────────────────

  it("loses no increment under real concurrency on ONE row", async () => {
    // The M6.3 P1 shape, at the layer where it can actually happen. A
    // read-then-write implementation drops all but a handful of these; the
    // single-statement upsert cannot, because the `DO UPDATE` reads the row
    // under the lock the conflict already took.
    const day = "2026-08-03";
    await Promise.all(
      Array.from({ length: 200 }, () => funnel.increment("visit_learn_index", day)),
    );
    const rows = await funnel.since(day);
    expect(rows).toEqual([{ stage: "visit_learn_index", day, count: 200 }]);
  });

  it("keeps (stage, day) separate and orders by day then stage", async () => {
    await funnel.increment("connect", "2026-08-01");
    await funnel.increment("visit_market", "2026-08-01");
    await funnel.increment("visit_market", "2026-08-02");
    // The SQL orders `day ASC, stage ASC`; the in-memory store mirrors it, and
    // this is the side that defines it.
    expect(await funnel.since("2026-08-01")).toEqual([
      { stage: "connect", day: "2026-08-01", count: 1 },
      { stage: "visit_market", day: "2026-08-01", count: 1 },
      { stage: "visit_market", day: "2026-08-02", count: 1 },
    ]);
    // `since` is inclusive of its lower bound and excludes earlier days.
    expect(await funnel.since("2026-08-02")).toHaveLength(1);
  });

  it("sweeps strictly-older day rows and reports the count deleted", async () => {
    await funnel.increment("connect", "2026-01-01");
    await funnel.increment("connect", "2026-08-03");
    expect(await funnel.sweep("2026-08-03")).toBe(1);
    expect((await funnel.since("2000-01-01")).map((r) => r.day)).toEqual(["2026-08-03"]);
  });

  it("writes every declared stage — the enum accepts the whole vocabulary", async () => {
    // A stage the code can produce but the enum rejects would be a 500 on a
    // page load, and only Postgres can refuse it.
    for (const stage of [
      "visit_learn_index",
      "visit_validators",
      "visit_market",
      "due_diligence_depth",
      "connect",
    ] as const) {
      await funnel.increment(stage, "2026-08-03");
    }
    expect(await funnel.since("2026-08-03")).toHaveLength(5);
  });

  // ── incident acknowledgments (§9.6) ──────────────────────────────────────

  it("admits an incident id past 2^31 (the BIGINT widening)", async () => {
    const record = await acks.acknowledge(BIG_INCIDENT_ID, ADMIN_A, null, new Date());
    expect(record.incidentId).toBe(BIG_INCIDENT_ID);
    const live = await acks.liveAcksFor([BIG_INCIDENT_ID]);
    expect(live.get(BIG_INCIDENT_ID)?.acknowledgedBy).toBe(ADMIN_A);
  });

  it("refuses a second LIVE ack by the same admin, via the partial index", async () => {
    await acks.acknowledge(1, ADMIN_A, null, new Date());
    // The constraint answers the race, not an application-level pre-check —
    // and `AckConflict` is the mapping from SQLSTATE 23505 / P2002.
    await expect(acks.acknowledge(1, ADMIN_A, null, new Date())).rejects.toBeInstanceOf(
      AckConflict,
    );
  });

  it("admits a DIFFERENT admin's ack on the same incident", async () => {
    await acks.acknowledge(1, ADMIN_A, null, new Date());
    await expect(acks.acknowledge(1, ADMIN_B, null, new Date())).resolves.toBeTruthy();
    // Both are live, and the map keys by incident — so the feed shows one of
    // them rather than fabricating a merge.
    const live = await acks.liveAcksFor([1]);
    expect(live.has(1)).toBe(true);
  });

  it("reverses conditionally: exactly one caller claims a live ack", async () => {
    await acks.acknowledge(1, ADMIN_A, null, new Date());
    // Two concurrent reversals. A find-then-update lets BOTH claim the row and
    // the later stamp silently overwrites the earlier — last-write-wins on a
    // nullable column, which C3 forbids by name. The conditional update means
    // exactly one wins and the other gets the honest "no live ack" answer.
    const [first, second] = await Promise.all([
      acks.unacknowledge(1, ADMIN_A, new Date()),
      acks.unacknowledge(1, ADMIN_A, new Date()),
    ]);
    expect([first, second].filter((r) => r !== null)).toHaveLength(1);
    expect(await acks.liveAcksFor([1])).toEqual(new Map());
  });

  it("never reverses another admin's acknowledgment", async () => {
    await acks.acknowledge(1, ADMIN_A, null, new Date());
    expect(await acks.unacknowledge(1, ADMIN_B, new Date())).toBeNull();
    // A's ack survives untouched.
    expect((await acks.liveAcksFor([1])).get(1)?.acknowledgedBy).toBe(ADMIN_A);
  });

  it("preserves history: reversal keeps the row and frees the pair", async () => {
    await acks.acknowledge(1, ADMIN_A, "first look", new Date());
    await acks.unacknowledge(1, ADMIN_A, new Date());
    // The partial index only covers live rows, so the pair is available again.
    await acks.acknowledge(1, ADMIN_A, "second look", new Date());
    const rows = await prisma.incidentAck.findMany({ where: { incidentId: BigInt(1) } });
    // Two rows, one live — the trail survived rather than being overwritten.
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.unacknowledgedAt === null)).toHaveLength(1);
  });

  it("stores a bounded note and returns it unchanged", async () => {
    const note = "x".repeat(500);
    await acks.acknowledge(1, ADMIN_A, note, new Date());
    expect((await acks.liveAcksFor([1])).get(1)?.note).toBe(note);
  });

  it("omits incidents with no live ack rather than fabricating one", async () => {
    await acks.acknowledge(1, ADMIN_A, null, new Date());
    const live = await acks.liveAcksFor([1, 2, 3]);
    expect([...live.keys()]).toEqual([1]);
  });
});
