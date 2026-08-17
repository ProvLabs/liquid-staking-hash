// Postgres-backed reader gate: the real Prisma queries and
// the Decimal → bigint → decimal-string serialization, exercised as the
// SELECT-only `api_reader` role against rows seeded as `indexer_writer` —
// the exact production read path, over the role split roles.sql establishes.
// Runs in the app-ci `db-grants` job (Postgres service, after roles.sql +
// migrate + the api_reader SELECT grant); never in the DB-free unit suite.
//
// Env (fail loudly — this suite is only ever invoked deliberately):
//   API_READER_DATABASE_URL     postgresql://api_reader:…?schema=indexed
//   INDEXER_WRITER_DATABASE_URL postgresql://indexer_writer:…?schema=indexed

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@nvhash/db-indexed";
import { createPrismaReader, type PrismaReader } from "../../src/reader-prisma.ts";
import { paymentEpochIndex } from "../../src/derive.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the DB-backed reader gate`);
  return value;
}

// Corpus NAV goldens (@nvhash/fixtures queries/vault/get.json) — the same
// values pinning the shared helper; here they must survive the full
// Postgres Decimal(39,0) round trip.
const FIXTURE_TVV = "315397882283";
const FIXTURE_SHARES = "309963777029000000";

const ZERO_DECIMALS = {
  tvvBefore: "0",
  rewardsClaimed: "0",
  commissionReceived: "0",
  tipsReceived: "0",
  rewardsDeposited: "0",
  settled: "0",
  writeDown: "0",
  deployed: "0",
  rebalanced: "0",
  unbondedForRedemptions: "0",
  aumFeeEstimate: "0",
  netDeposits: "0",
} as const;

describe("PrismaReader over api_reader (role-split round trip)", () => {
  let writer: PrismaClient;
  let reader: PrismaReader;

  beforeAll(async () => {
    writer = new PrismaClient({ datasourceUrl: requireEnv("INDEXER_WRITER_DATABASE_URL") });
    reader = createPrismaReader(requireEnv("API_READER_DATABASE_URL"));

    // Idempotent re-run: clear exactly what this suite seeds.
    await writer.reconcilerRun.deleteMany();
    await writer.incident.deleteMany();
    await writer.validatorEpoch.deleteMany();
    await writer.validatorRegistry.deleteMany();
    await writer.transaction.deleteMany();
    await writer.holderLifecycle.deleteMany();
    await writer.redemptionRequest.deleteMany();
    await writer.epochSnapshot.deleteMany();
    await writer.marketSample.deleteMany();
    await writer.bridgeSupplySample.deleteMany();
    await writer.operatorPayment.deleteMany();
    await writer.govVote.deleteMany();
    await writer.govProposal.deleteMany();
    await writer.indexerCheckpoint.deleteMany();

    await writer.indexerCheckpoint.createMany({
      data: [
        { stream: "chain-events", cursorHeight: 4200n },
        // Reserved marker row with a deliberately HIGHER height: the reader
        // must exclude `meta:` rows from the checkpoint fallback.
        { stream: "meta:provenance", cursorHeight: 999_999n, cursorPage: "test-chain|contract" },
      ],
    });
    await writer.reconcilerRun.create({
      data: {
        ranAt: new Date("2026-07-22T00:00:00Z"),
        chainHeight: 4242n,
        indexedHeight: 4200n,
        deltas: {},
        withinTolerance: true,
      },
    });
    // Materialized lifecycles: writer-side equality is gated in the
    // indexer's suite; this suite seeds fixtures and tests the reader.
    await writer.holderLifecycle.createMany({
      data: [
        { address: "pb1alice", firstDepositHeight: 100n, exitHeight: null },
        { address: "pb1bob", firstDepositHeight: 200n, exitHeight: null },
      ],
    });
    await writer.transaction.createMany({
      data: [
        {
          txhash: "AA",
          msgIndex: 0,
          address: "pb1alice",
          kind: "swap_in",
          shares: "1000",
          nhash: "1017",
          navAtHeight: "10175",
          height: 100n,
          blockTime: new Date("2026-06-01T00:00:00Z"),
        },
        {
          txhash: "BB",
          msgIndex: 0,
          address: "pb1bob",
          kind: "swap_in",
          shares: "2000",
          nhash: "2035",
          navAtHeight: "10175",
          height: 200n,
          blockTime: new Date("2026-06-02T00:00:00Z"),
        },
        {
          txhash: "CC",
          msgIndex: 0,
          address: "pb1alice",
          kind: "swap_out_request",
          shares: "500",
          nhash: "0",
          navAtHeight: "10175",
          height: 300n,
          blockTime: new Date("2026-06-03T00:00:00Z"),
        },
      ],
    });
    await writer.epochSnapshot.create({
      data: {
        epochIndex: 12n,
        startedAtSeconds: 1_764_547_200n,
        endedAtSeconds: 1_767_225_600n,
        endHeight: 4100n,
        tvvAfter: FIXTURE_TVV,
        totalShares: FIXTURE_SHARES,
        ...ZERO_DECIMALS,
        redemptionsExpedited: 0,
        validatorsPurged: 0,
        eligibleCount: 1,
        grossAprBps: 500,
        netAprBps: 431,
        txhash: "EPOCH12",
        height: 4100n,
        observedAt: new Date("2026-07-01T00:00:00Z"),
      },
    });
    await writer.incident.create({
      data: {
        kind: "indexer_lag",
        severity: "warning",
        dedupeKey: "test",
        openedAt: new Date("2026-07-01T00:00:00Z"),
        openedHeight: 900n,
        payload: {},
      },
    });
    await writer.validatorRegistry.createMany({
      data: [
        {
          valoper: "pbvaloper1aaa",
          operator: "pb1aaa",
          moniker: "alpha",
          enrolledAt: new Date("2026-05-01T00:00:00Z"),
        },
        {
          valoper: "pbvaloper1bbb",
          operator: "pb1bbb",
          moniker: "bravo",
          enrolledAt: new Date("2026-05-01T00:00:00Z"),
        },
      ],
    });
    await writer.validatorEpoch.createMany({
      data: [
        {
          valoper: "pbvaloper1aaa",
          epochIndex: 11n,
          uptimeBps: 9000,
          eligible: false,
          failingReasons: ["uptime"],
          tip: "0",
          commissionAccrued: "0",
          commissionPaid: "0",
          commissionDue: "9",
          programDelegation: "1",
          height: 3000n,
          observedAt: new Date("2026-06-01T00:00:00Z"),
        },
        {
          valoper: "pbvaloper1aaa",
          epochIndex: 12n,
          uptimeBps: 9990,
          eligible: true,
          failingReasons: [],
          tip: "0",
          commissionAccrued: "0",
          commissionPaid: "0",
          commissionDue: "5",
          programDelegation: "1000000000",
          height: 4100n,
          observedAt: new Date("2026-07-01T00:00:00Z"),
        },
      ],
    });
    // Address plane: one active (enqueued) and one terminal
    // (matured) redemption — the portfolio read must escrow only the former.
    // 11 recent terminal (matured) requests dated RELATIVE TO NOW so the
    // payout-stats recent-window filter always captures them (the reader's
    // cutoff is real wall-clock; fixed dates would age out of the window and
    // make the test flaky). Durations 20..30 days → cohort ≥ 10, so the
    // median/p90 gate opens; epochCount is 1 (seeded above), so not cold-start.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const recentTerminal = Array.from({ length: 11 }, (_, i) => {
      const maturedAt = new Date(Date.now() - 5 * DAY_MS);
      return {
        requestId: `payout-${i}`,
        owner: `pb1holder${i}`,
        shares: "1000",
        status: "matured" as const,
        enqueuedAt: new Date(maturedAt.getTime() - (20 + i) * DAY_MS),
        maturedAt,
        lastHeight: 400n,
        lastTxhash: `PAYOUT${i}`,
      };
    });
    await writer.redemptionRequest.createMany({
      data: [
        {
          requestId: "req-1",
          owner: "pb1alice",
          shares: "500",
          status: "enqueued",
          enqueuedAt: new Date("2026-06-03T00:00:00Z"),
          lastHeight: 300n,
          lastTxhash: "CC",
        },
        {
          requestId: "req-0",
          owner: "pb1alice",
          shares: "100",
          status: "matured",
          enqueuedAt: new Date("2026-05-01T00:00:00Z"),
          maturedAt: new Date("2026-05-20T00:00:00Z"),
          lastHeight: 50n,
          lastTxhash: "OLD",
        },
        ...recentTerminal,
      ],
    });
    // Operator plane: payments for alpha spanning the epoch-12 boundary
    // (endHeight 4100) — one before it, one after — plus one for bravo, so the
    // per-valoper scoping and the derived epoch are both observable. Amounts at
    // Uint128 scale so the Decimal(39,0) → bigint sum is a real round trip.
    await writer.operatorPayment.createMany({
      data: [
        {
          txhash: "PAY1",
          msgIndex: 0,
          valoper: "pbvaloper1aaa",
          payer: "pb1aaa",
          paymentType: "commission",
          amount: "170141183460469231731687303715884105727",
          height: 3000n,
          occurredAt: new Date("2026-06-15T00:00:00Z"),
        },
        {
          txhash: "PAY2",
          msgIndex: 1,
          valoper: "pbvaloper1aaa",
          payer: "pb1someoneelse",
          paymentType: "tip",
          amount: "25",
          height: 3000n,
          occurredAt: new Date("2026-06-15T00:00:00Z"),
        },
        {
          txhash: "PAY3",
          msgIndex: 0,
          valoper: "pbvaloper1aaa",
          payer: "pb1aaa",
          paymentType: "commission",
          amount: "3",
          height: 5000n,
          occurredAt: new Date("2026-07-20T00:00:00Z"),
        },
        {
          txhash: "PAYB",
          msgIndex: 0,
          valoper: "pbvaloper1bbb",
          payer: "pb1bbb",
          paymentType: "tip",
          amount: "7",
          height: 3000n,
          occurredAt: new Date("2026-06-16T00:00:00Z"),
        },
      ],
    });
    // Market plane: the sample predates every settled epoch, so the
    // [R6] NAV-at-sample-time lookup finds none and the premium is honestly
    // null; depth bands round-trip through JSONB shape validation.
    await writer.marketSample.create({
      data: {
        venue: "uniswap-v3",
        pool: "0xpool",
        price: "1030000000",
        depthBands: [{ side: "buy", slippage_bps: 50, amount: "1000000000000000" }],
        sampledAt: new Date("2025-12-01T00:00:00Z"),
      },
    });
    await writer.bridgeSupplySample.createMany({
      data: [
        { chain: "base", remoteSupply: "1000", sampledAt: new Date("2026-07-01T00:00:00Z") },
        { chain: "base", remoteSupply: "2000", sampledAt: new Date("2026-07-10T00:00:00Z") },
        { chain: "ethereum", remoteSupply: "500", sampledAt: new Date("2026-07-05T00:00:00Z") },
      ],
    });
  });

  afterAll(async () => {
    await reader.close();
    await writer.$disconnect();
  });

  it("reads heads from the latest reconciler run, carrying the run's ranAt", async () => {
    expect(await reader.heads()).toEqual({
      chainHeight: 4242,
      indexedHeight: 4200,
      reconciledAt: new Date("2026-07-22T00:00:00Z"),
    });
  });

  it("derives metrics with COUNT(DISTINCT address) across all kinds ([R5])", async () => {
    expect(await reader.programMetrics()).toEqual({
      participant_count: 2, // alice + bob; alice's second tx must not double-count
      program_started_at: "2026-06-01T00:00:00.000Z",
      epoch_count: 1,
    });
  });

  it("serves the corpus NAV golden through the full Decimal round trip ([R1])", async () => {
    const rows = await reader.listEpochs({ limit: 50, offset: 0 });
    expect(rows).toEqual([
      {
        epoch_index: 12,
        ended_at: "2026-01-01T00:00:00.000Z",
        nav: "1.0175",
        tvv: FIXTURE_TVV,
        net_apr_bps: 431,
      },
    ]);
  });

  it("lists incidents", async () => {
    expect(await reader.listIncidents({ limit: 50, offset: 0 })).toEqual([
      {
        kind: "indexer_lag",
        severity: "warning",
        opened_at: "2026-07-01T00:00:00.000Z",
        closed_at: null,
        height: 900,
      },
    ]);
  });

  it("joins validators to their latest sample and aggregates set health", async () => {
    const payload = await reader.listValidators();
    expect(payload.validators).toEqual([
      {
        valoper: "pbvaloper1aaa",
        moniker: "alpha",
        active: true,
        epoch_index: 12,
        uptime_bps: 9990,
        eligible: true,
        failing_reasons: [],
        failing_reasons_truncated: false,
        program_delegation: "1000000000",
        commission_due: "5",
      },
      {
        valoper: "pbvaloper1bbb",
        moniker: "bravo",
        active: true,
        epoch_index: null,
        uptime_bps: null,
        eligible: null,
        failing_reasons: [],
        failing_reasons_truncated: false,
        program_delegation: null,
        commission_due: null,
      },
    ]);
    expect(payload.set_health).toEqual({ total: 2, active: 2, eligible: 1, in_arrears: 1 });
  });

  it("serves the market summary: JSONB bands round-trip, null premium pre-NAV, latest per chain", async () => {
    const summary = await reader.latestMarket();
    expect(summary.sample).toEqual({
      venue: "uniswap-v3",
      pool: "0xpool",
      price: "1030000000",
      premium_discount_bps: null, // no epoch had settled by the sample's time
      depth_bands: [{ side: "buy", slippage_bps: 50, amount: "1000000000000000" }],
      sampled_at: "2025-12-01T00:00:00.000Z",
    });
    expect(summary.bridged_supply).toEqual([
      { chain: "base", supply: "2000", sampled_at: "2026-07-10T00:00:00.000Z" },
      { chain: "ethereum", supply: "500", sampled_at: "2026-07-05T00:00:00.000Z" },
    ]);
  });

  it("serves address-scoped transactions newest first, only for that address", async () => {
    const rows = await reader.transactionsFor("pb1alice", { limit: 50, offset: 0 });
    expect(rows.map((r) => r.txhash)).toEqual(["CC", "AA"]); // pb1bob's BB absent
    expect(rows[0]).toEqual({
      txhash: "CC",
      msg_index: 0,
      kind: "swap_out_request",
      shares: "500",
      nhash: "0",
      nav_at_height: "10175",
      height: 300,
      block_time: "2026-06-03T00:00:00.000Z",
    });
  });

  it("reads the FULL history ascending (height, msgIndex) as fold facts, Decimal round trip", async () => {
    const facts = await reader.transactionsAscFor("pb1alice");
    // Ascending, pb1bob's BB absent; the reverse of the newest-first view.
    expect(facts.map((f) => f.txhash)).toEqual(["AA", "CC"]);
    // Amounts survive as bigint (Decimal(39,0) → bigint), heights as bigint.
    expect(facts[0]).toMatchObject({
      txhash: "AA",
      kind: "swap_in",
      shares: 1000n,
      nhash: 1017n,
      navAtHeight: 10175n,
      height: 100n,
    });
    expect(facts[1]!.kind).toBe("swap_out_request");
    expect(facts[1]!.shares).toBe(500n);
  });

  it("lists epoch step facts ascending with endHeight and null-capable APR", async () => {
    const steps = await reader.listEpochsAsc();
    expect(steps).toEqual([
      {
        epochIndex: 12n,
        endedAtSeconds: 1_767_225_600n,
        tvvAfter: BigInt(FIXTURE_TVV),
        totalShares: BigInt(FIXTURE_SHARES),
        netAprBps: 431,
        endHeight: 4100n,
      },
    ]);
  });

  it("derives the portfolio facts: first activity, count, active-only escrow", async () => {
    const portfolio = await reader.portfolioFor("pb1alice");
    expect(portfolio.address).toBe("pb1alice");
    expect(portfolio.first_activity_at).toBe("2026-06-01T00:00:00.000Z");
    expect(portfolio.transaction_count).toBe(2);
    expect(portfolio.escrowed_shares).toBe("500"); // matured req-0 does not escrow
    expect(portfolio.active_redemptions.map((r) => r.request_id)).toEqual(["req-1"]);
  });

  it("derives payout stats: terminal cohort in-window, median/p90 gate, band bounds", async () => {
    const stats = await reader.payoutStats();
    // ≥ 11 recent matured requests → cohort clears the ≥10 gate; the old
    // req-0 may or may not fall in the window, so assert a lower bound.
    expect(stats.sample_count).toBeGreaterThanOrEqual(11);
    expect(stats.cold_start).toBe(false); // one epoch is seeded
    expect(stats.median_seconds).not.toBeNull();
    expect(stats.p90_seconds).not.toBeNull();
    expect((stats.p90_seconds as number) >= (stats.median_seconds as number)).toBe(true);
    expect(stats.band_floor_seconds).toBe(21 * 24 * 60 * 60);
    expect(stats.band_ceiling_seconds).toBe(60 * 24 * 60 * 60);
  });

  // --- internal alert-facts reads (the notifier's cross-address reads) ---

  it("reads redemptions changed since a height cursor, ascending, owner + no amount", async () => {
    // Past cursor 300: only the payout-N cohort (lastHeight 400) — req-1 (300)
    // and req-0 (50) excluded. Confirms the `@@index([lastHeight])` range read.
    // Empty after_id INCLUDES the boundary height (a legacy height-only
    // cursor re-scans its boundary row; dedupe absorbs): req-1 at 300 rides
    // ahead of the 11-row lastHeight-400 cohort.
    const all = await reader.redemptionsChangedSince(300, "", 500);
    expect(all.length).toBe(12);
    expect(all[0]!.last_height).toBe(300);
    const rows = all.slice(1);
    expect(rows.length).toBe(11);
    for (const r of rows) {
      expect(r.last_height).toBe(400);
      expect(r.owner.startsWith("pb1holder")).toBe(true);
      expect(r.status).toBe("matured");
      // No amount field crosses the boundary.
      expect(Object.keys(r)).not.toContain("shares");
    }
    // Cursor 0 sees every changed redemption (all lastHeight > 0).
    expect((await reader.redemptionsChangedSince(0, "", 500)).length).toBeGreaterThanOrEqual(13);
  });

  it("pages through a same-height burst via the after_id tie-break", async () => {
    // The 11-row lastHeight-400 cohort stands in for a mass-maturation burst:
    // with the compound cursor `(height, requestId)`, a page boundary inside
    // the cohort resumes exactly after the last row served — no row skipped.
    const first = await reader.redemptionsChangedSince(300, "req-1", 5); // past the 300 boundary, into the burst
    expect(first.length).toBe(5);
    expect(first.every((r) => r.last_height === 400)).toBe(true);
    const rest = await reader.redemptionsChangedSince(400, first[4]!.request_id, 500);
    expect(rest.length).toBe(6);
    const seen = [...first, ...rest].map((r) => r.request_id);
    expect(new Set(seen).size).toBe(11); // complete, no overlap, no loss
  });

  it("reads incidents since an id cursor with identity only (no payload)", async () => {
    const all = await reader.incidentsSince(0, 500);
    expect(all.length).toBeGreaterThanOrEqual(1);
    const seeded = all.find((i) => i.dedupe_key === "test");
    expect(seeded).toMatchObject({
      kind: "indexer_lag",
      severity: "warning",
      dedupe_key: "test",
      opened_at: "2026-07-01T00:00:00.000Z",
      opened_height: 900,
    });
    expect(seeded && "payload" in seeded).toBe(false);
    // The id cursor excludes rows at or below it (gt).
    const past = await reader.incidentsSince(seeded!.id, 500);
    expect(past.map((i) => i.id)).not.toContain(seeded!.id);
  });

  it("reads latest-epoch arrears joined to the active operator", async () => {
    // Latest epoch is 12: alpha owes 5 (active) → surfaces with its operator.
    // bravo has no epoch-12 sample → not in arrears.
    const arrears = await reader.latestArrears();
    expect(arrears).toEqual([
      { valoper: "pbvaloper1aaa", operator: "pb1aaa", epoch_index: 12, commission_due: "5" },
    ]);
  });

  it("excludes an unregistered validator's arrears from the join", async () => {
    // Unregister alpha, add a fresh owing validator: alpha (now unregistered)
    // must drop out even though it still owes in epoch 12.
    await writer.validatorRegistry.update({
      where: { valoper: "pbvaloper1aaa" },
      data: { unregisteredAt: new Date("2026-07-15T00:00:00Z") },
    });
    try {
      expect(await reader.latestArrears()).toEqual([]);
    } finally {
      await writer.validatorRegistry.update({
        where: { valoper: "pbvaloper1aaa" },
        data: { unregisteredAt: null },
      });
    }
  });

  // --- operator surface (the address→valoper mapping, over real SQL) ---

  it("maps an address to only the validators it operates", async () => {
    const mine = await reader.operatorValopers("pb1aaa");
    expect(mine.map((r) => r.valoper)).toEqual(["pbvaloper1aaa"]); // never bravo
    expect(mine[0]).toMatchObject({
      operator: "pb1aaa",
      moniker: "alpha",
      unregisteredAt: null,
    });
    // An address that operates nothing gets an empty set — the honest-empty
    // answer every operator route then serves, never an error that would say
    // whether those valopers exist.
    expect(await reader.operatorValopers("pb1nobody")).toEqual([]);
  });

  it("reads the LATEST epoch per owned valoper with the full economics", async () => {
    const latest = await reader.latestOperatorEpochs(["pbvaloper1aaa", "pbvaloper1bbb"]);
    expect(latest.map((e) => e.valoper)).toEqual(["pbvaloper1aaa"]); // bravo has no sample
    expect(latest[0]).toMatchObject({
      epochIndex: 12n, // the latest, not the epoch-11 row
      uptimeBps: 9990,
      eligible: true,
      commissionDue: 5n,
      commissionAccrued: 0n,
      commissionPaid: 0n,
      tip: 0n,
      programDelegation: 1_000_000_000n,
      height: 4100n,
    });
    expect(await reader.latestOperatorEpochs([])).toEqual([]);
  });

  it("pages a validator's epoch history newest first", async () => {
    const page1 = await reader.validatorEpochsFor("pbvaloper1aaa", { limit: 1, offset: 0 });
    expect(page1.map((e) => e.epochIndex)).toEqual([12n]);
    const page2 = await reader.validatorEpochsFor("pbvaloper1aaa", { limit: 1, offset: 1 });
    expect(page2.map((e) => e.epochIndex)).toEqual([11n]);
    expect(await reader.validatorEpochsFor("pbvaloper1bbb", { limit: 50, offset: 0 })).toEqual([]);
  });

  it("sums lifetime payment totals per valoper in SQL, at Uint128 scale", async () => {
    const totals = await reader.operatorPaymentTotalsFor(["pbvaloper1aaa", "pbvaloper1bbb"]);
    const alpha = totals.find((t) => t.valoper === "pbvaloper1aaa");
    // A 39-digit commission plus a small one: a sum that went through a double
    // could not come back exact.
    expect(alpha).toEqual({
      valoper: "pbvaloper1aaa",
      commissionPaidTotal: 170141183460469231731687303715884105727n + 3n,
      tipPaidTotal: 25n,
      paymentCount: 3,
    });
    expect(totals.find((t) => t.valoper === "pbvaloper1bbb")).toEqual({
      valoper: "pbvaloper1bbb",
      commissionPaidTotal: 0n,
      tipPaidTotal: 7n,
      paymentCount: 1,
    });
    expect(await reader.operatorPaymentTotalsFor([])).toEqual([]);
  });

  /** Drain the export stream the way the CSV route does. */
  async function drain(valoper: string) {
    const out = [];
    for await (const chunk of reader.operatorPaymentsAscStream(valoper)) out.push(...chunk);
    return out;
  }

  it("reads the COMPLETE payment history ascending, scoped to one valoper", async () => {
    const facts = await drain("pbvaloper1aaa");
    // Ascending by (height, msgIndex); bravo's PAYB is absent.
    expect(facts.map((f) => f.txhash)).toEqual(["PAY1", "PAY2", "PAY3"]);
    expect(facts[1]).toMatchObject({
      txhash: "PAY2",
      msgIndex: 1,
      paymentType: "tip",
      amount: 25n,
      // The permissionless-payment case: the payer is NOT the operator.
      payer: "pb1someoneelse",
      height: 3000n,
    });
    // The paginated JSON view is the same rows, newest first.
    const page = await reader.operatorPaymentsFor("pbvaloper1aaa", { limit: 2, offset: 0 });
    expect(page.map((f) => f.txhash)).toEqual(["PAY3", "PAY2"]);
  });

  it("keyset export stays complete across chunk boundaries and same-height bursts", async () => {
    // THE gate on the 2026-07-28 keyset conversion. The export walks by
    // `(height, msgIndex) > cursor` in 1000-row chunks, so the two ways a
    // cursor can silently lose rows are seeded deliberately:
    //   - a burst at ONE height LARGER than a chunk (1200 rows). A
    //     height-only cursor either loops forever here or skips the
    //     remainder; only the compound tie-break pages through it.
    //   - rows straddling the chunk boundary in both directions.
    // Completeness of the §14.11 export is the property under test — it is a
    // statement of fact, so a missing row is a wrong statement.
    const BURST = 1200;
    await writer.operatorPayment.createMany({
      data: Array.from({ length: BURST }, (_, i) => ({
        txhash: `BURST${String(i).padStart(6, "0")}`,
        msgIndex: i,
        valoper: "pbvaloper1keyset",
        payer: "pb1payer",
        paymentType: (i % 2 === 0 ? "commission" : "tip") as "commission" | "tip",
        amount: "1",
        height: 9000n, // every row at the SAME height
        occurredAt: new Date("2026-07-01T00:00:00Z"),
      })).concat([
        {
          txhash: "BEFORE0",
          msgIndex: 0,
          valoper: "pbvaloper1keyset",
          payer: "pb1payer",
          paymentType: "commission" as const,
          amount: "1",
          height: 8999n,
          occurredAt: new Date("2026-06-30T00:00:00Z"),
        },
        {
          txhash: "AFTER00",
          msgIndex: 0,
          valoper: "pbvaloper1keyset",
          payer: "pb1payer",
          paymentType: "tip" as const,
          amount: "1",
          height: 9001n,
          occurredAt: new Date("2026-07-02T00:00:00Z"),
        },
      ]),
    });

    const facts = await drain("pbvaloper1keyset");

    expect(facts).toHaveLength(BURST + 2);
    // No row seen twice — a cursor that re-includes its boundary duplicates.
    expect(new Set(facts.map((f) => `${f.txhash}:${f.msgIndex}`)).size).toBe(BURST + 2);
    // Strictly ascending by (height, msgIndex) across every chunk seam.
    for (let i = 1; i < facts.length; i++) {
      const prev = facts[i - 1]!;
      const cur = facts[i]!;
      expect(
        cur.height > prev.height || (cur.height === prev.height && cur.msgIndex > prev.msgIndex),
      ).toBe(true);
    }
    expect(facts[0]!.txhash).toBe("BEFORE0");
    expect(facts.at(-1)!.txhash).toBe("AFTER00");

    await writer.operatorPayment.deleteMany({ where: { valoper: "pbvaloper1keyset" } });
  });

  it("serves epoch boundaries ascending — the payment→epoch derivation input", async () => {
    // With only epoch 12 (endHeight 4100) indexed: a payment at 3000 credits
    // epoch 12, and one at 5000 has no closed epoch yet (null, never a guess).
    const boundaries = await reader.epochBoundariesAsc();
    expect(boundaries).toEqual([{ epochIndex: 12n, endHeight: 4100n }]);
    expect(paymentEpochIndex(3000n, boundaries)).toBe(12n);
    expect(paymentEpochIndex(5000n, boundaries)).toBeNull();
  });

  // --- governance -----------------------------------------
  //
  // The route suite exercises these payloads over an in-memory fake. What only
  // real Postgres can prove is that the SELECTs themselves are right as
  // `api_reader`: the group-by aggregate, the newest-first id order, the
  // Decimal(39,0) tally counts surviving as bigints, and the read-one-past-the-cap
  // trick the truncation flag depends on.

  it("lists mirrored proposals newest-first with filters, as api_reader", async () => {
    const base = {
      groupId: 1n,
      proposers: ["pb1proposer"],
      status: "SUBMITTED",
      executorResult: "NOT_RUN",
      title: "t",
      summary: "s",
      messages: [{ "@type": "/cosmos.bank.v1beta1.MsgSend" }],
      submitTime: new Date("2026-07-29T00:00:00Z"),
      votingPeriodEnd: new Date("2026-07-29T00:05:00Z"),
      yesCount: "0",
      noCount: "0",
      abstainCount: "0",
      noWithVetoCount: "0",
      groupVersion: 1n,
      groupPolicyVersion: 1n,
      decisionPolicy: {
        "@type": "/cosmos.group.v1.ThresholdDecisionPolicy",
        threshold: "2",
        windows: { voting_period: "300s", min_execution_period: "0s" },
      },
      observedAt: new Date("2026-07-29T00:06:00Z"),
    };
    await writer.govProposal.createMany({
      data: [
        {
          ...base,
          proposalId: 71n,
          groupPolicyAddress: "pb1policya",
          observedHeight: 500n,
          status: "ACCEPTED",
        },
        { ...base, proposalId: 72n, groupPolicyAddress: "pb1policya", observedHeight: 510n },
        {
          ...base,
          proposalId: 73n,
          groupPolicyAddress: "pb1policyb",
          observedHeight: 520n,
          status: "REJECTED",
        },
      ],
    });
    await writer.indexerCheckpoint.create({ data: { stream: "governance", cursorHeight: 520n } });

    const all = await reader.listGovProposals({ limit: 50, offset: 0 }, {});
    // Newest first by id — x/group ids are monotonic chain-global, so id order IS
    // submission order and no tie-break column is needed.
    expect(all.proposals.map((p) => p.proposalId)).toEqual([73n, 72n, 71n]);
    // Invariant 5: the window the mirror can vouch for.
    expect(all.indexedFromHeight).toBe(1);

    const byPolicy = await reader.listGovProposals(
      { limit: 50, offset: 0 },
      { policy: "pb1policyb" },
    );
    expect(byPolicy.proposals.map((p) => p.proposalId)).toEqual([73n]);

    // The wire union is lower-case; the column stores SCREAMING. The reader owns
    // that translation, so a caller never has to know.
    const byStatus = await reader.listGovProposals(
      { limit: 50, offset: 0 },
      { status: "accepted" },
    );
    expect(byStatus.proposals.map((p) => p.proposalId)).toEqual([71n]);

    const paged = await reader.listGovProposals({ limit: 1, offset: 1 }, {});
    expect(paged.proposals.map((p) => p.proposalId)).toEqual([72n]);
  });

  it("reads tally counts and vote weights back as BIGINTS at full precision", async () => {
    // 39 digits is the column's full precision. x/group weights are unbounded
    // sums with no protocol ceiling, so a value that survives this cannot have
    // passed through a double.
    const big = (10n ** 38n - 1n).toString();
    await writer.govProposal.update({
      where: { proposalId: 72n },
      data: { yesCount: big, noWithVetoCount: "1" },
    });
    await writer.govVote.create({
      data: {
        proposalId: 72n,
        voter: "pb1voterbig",
        option: "YES",
        weight: big,
        submitTime: new Date("2026-07-29T00:01:00Z"),
        height: 495n,
        txhash: "VOTEBIG",
      },
    });
    const found = await reader.govProposal(72n);
    expect(found).not.toBeNull();
    expect(found!.proposal.yesCount).toBe(BigInt(big));
    expect(found!.proposal.noWithVetoCount).toBe(1n);
    expect(found!.votes[0]!.weight).toBe(BigInt(big));
  });

  it("keeps a state-recovered vote's NULL weight and provenance null", async () => {
    await writer.govVote.create({
      data: {
        proposalId: 72n,
        voter: "pb1voternull",
        option: "ABSTAIN",
        submitTime: new Date("2026-07-29T00:02:00Z"),
      },
    });
    const found = await reader.govProposal(72n);
    const recovered = found!.votes.find((v) => v.voter === "pb1voternull")!;
    // The module's Vote payload has no weight field, and votes are deleted at the
    // tally — so null is the common case, and a 0 would misstate the tally line.
    expect(recovered.weight).toBeNull();
    expect(recovered.height).toBeNull();
    expect(recovered.txhash).toBeNull();
  });

  it("returns null for a proposal id the mirror has never seen", async () => {
    // Null, not an empty shell: the route turns this into a 404, which is a
    // different statement from "exists and is blank".
    expect(await reader.govProposal(999_999n)).toBeNull();
  });

  it("aggregates the historical policy set, newest activity first", async () => {
    const policies = await reader.listGovPolicies();
    expect(policies.map((p) => p.address)).toEqual(["pb1policyb", "pb1policya"]);
    const a = policies.find((p) => p.address === "pb1policya")!;
    expect(a.proposalCount).toBe(2);
    // Highest observedHeight across that policy's proposals.
    expect(a.lastSeenHeight).toBe(510n);
    expect(a.groupId).toBe(1n);
  });

  it("serves honest-empty governance once the mirror is cleared", async () => {
    await writer.govVote.deleteMany();
    await writer.govProposal.deleteMany();
    expect(await reader.listGovPolicies()).toEqual([]);
    const empty = await reader.listGovProposals({ limit: 50, offset: 0 }, {});
    expect(empty.proposals).toEqual([]);
    // The coverage window still holds: the stream committed, so the mirror can
    // still say WHERE its knowledge starts even with nothing in it.
    expect(empty.indexedFromHeight).toBe(1);
  });

  it("reports a null coverage window when the governance stream never committed", async () => {
    await writer.indexerCheckpoint.deleteMany({ where: { stream: "governance" } });
    const empty = await reader.listGovProposals({ limit: 50, offset: 0 }, {});
    // Null, never 0 — a 0 would claim the mirror covers everything from genesis.
    expect(empty.indexedFromHeight).toBeNull();
  });

  // ── §8.8 admin analytics ────────────────────────────────────────────────
  //
  // These exist because the admin reads are the reader's most SQL-heavy: four
  // of the five are hand-written `$queryRaw` (a window function, two grouped
  // aggregates, a CTE with a CROSS JOIN), and the DB-free suites drive the fake
  // reader, so nothing else in CI ever executes them. A round-2 review shipped a
  // backtick inside a SQL comment that silently terminated a template literal —
  // typecheck and 735 unit tests stayed green. Any SQL error here is a 500 on
  // /admin in production, so the gate is "does this query run and mean what the
  // panel thinks", not the arithmetic (that is admin-derive's pure-fold suite).
  //
  // Seeded above: alice swap_in 1000 @100 then swap_out_request 500 @300 (net
  // zero on the TOTAL position, so she still holds 1000), bob swap_in 2000 @200.

  it("judges latency truncation on ROWS READ, against the real query", async () => {
    // The unit case for this pins the FAKE. This pins the Prisma reader, which
    // is a second implementation of the same rule — and the one that ships.
    //
    // A `matured` request with no payout timestamp yields no duration and
    // disappears from `seconds`, so `seconds.length` is smaller than the rows
    // the cap actually bound. A reader judging truncation on the filtered array
    // reports `false` here and the panel then claims all history.
    await writer.redemptionRequest.create({
      data: {
        requestId: "no-payout-time",
        owner: "pb1alice",
        shares: "1",
        status: "matured",
        enqueuedAt: new Date("2026-06-01T00:00:00Z"),
        maturedAt: null,
        // Highest lastHeight, so the newest-first read takes it FIRST.
        lastHeight: 99_999n,
        lastTxhash: "NOPAYOUT",
      },
    });
    try {
      const one = await reader.redemptionLatencySeconds(1);
      // The single row read produced no duration...
      expect(one.seconds).toHaveLength(0);
      // ...and the read was still truncated.
      expect(one.truncated).toBe(true);
    } finally {
      await writer.redemptionRequest.delete({ where: { requestId: "no-payout-time" } });
    }
  });

  it("serves materialized holder lifecycles, ascending and capped, with no address", async () => {
    const lifecycles = await reader.holderLifecycles(100);
    expect(lifecycles).toHaveLength(2);
    // ASC by first-deposit height: alice (100) before bob (200).
    expect(lifecycles.map((l) => Number(l.firstDepositHeight))).toEqual([100, 200]);
    // Neither has exited (the materialized rows mirror the transactions:
    // `swap_out_request` moves value to escrow and is net zero on the total
    // position, the derivePortfolioMetrics rule).
    expect(lifecycles.every((l) => l.exitHeight === null)).toBe(true);
    // The shape carries no identity, asserted against the REAL query.
    expect(Object.keys(lifecycles[0]!).sort()).toEqual(["exitHeight", "firstDepositHeight"]);
    // The cap is applied by the database, not by the caller.
    expect(await reader.holderLifecycles(1)).toHaveLength(1);
  });

  it("returns bands AND whole-set aggregates from one statement", async () => {
    const positions = await reader.holderPositions(10);
    // Descending, values only.
    expect(positions.topDesc).toEqual([2000n, 1000n]);
    expect(positions.holderCount).toBe(2);
    expect(positions.totalPosition).toBe(3000n);

    // THE regression this pins: the band cap must not move the aggregates. With
    // a depth of 1 only one position crosses the wire, and the count and
    // denominator must still describe both holders — otherwise every
    // concentration share is a share of the banded slice.
    const banded = await reader.holderPositions(1);
    expect(banded.topDesc).toEqual([2000n]);
    expect(banded.holderCount).toBe(2);
    expect(banded.totalPosition).toBe(3000n);
  });

  it("counts first depositors inside a window, min-then-filter", async () => {
    // Both first deposits are in June 2026.
    expect(await reader.firstDepositorsSince(new Date("2026-01-01T00:00:00Z"))).toBe(2);
    expect(await reader.firstDepositorsSince(new Date("2026-06-02T00:00:00Z"))).toBe(1);
    expect(await reader.firstDepositorsSince(new Date("2027-01-01T00:00:00Z"))).toBe(0);
    // Alice's LAST activity is 2026-06-03, but her first deposit is 06-01 — a
    // filter-then-min would count her as new in a window starting 06-03.
    expect(await reader.firstDepositorsSince(new Date("2026-06-03T00:00:00Z"))).toBe(0);
  });

  it("reads the remaining admin aggregates without error", async () => {
    // Shape-and-runs, deliberately: the point is that the SQL executes as
    // `api_reader` against the real schema.
    expect(await reader.depositorCount()).toBe(2);
    const epochs = await reader.adminEpochsAsc(600);
    expect(epochs.map((e) => Number(e.epochIndex))).toEqual([12]);
    expect(epochs[0]!.tvvAfter).toBe(BigInt(FIXTURE_TVV));
    const aggregates = await reader.validatorEpochAggregates(600);
    expect(aggregates.length).toBeGreaterThan(0);
    expect(await reader.validatorRegistryCounts()).toEqual({
      enrolledNow: expect.any(Number),
      churnedTotal: expect.any(Number),
    });
    const latencies = await reader.redemptionLatencySeconds(50_000);
    expect(Array.isArray(latencies.seconds)).toBe(true);
    // Nothing seeded reaches the cap, so an honest read reports untruncated.
    expect(latencies.truncated).toBe(false);
    expect(await reader.redemptionMix()).toEqual({
      enqueued: expect.any(Number),
      expedited: expect.any(Number),
      matured: expect.any(Number),
      refunded: expect.any(Number),
    });
    const incidents = await reader.adminIncidents({ limit: 50, offset: 0 });
    // The id is the only difference from the public row, and it is the point.
    expect(incidents[0]!.id).toEqual(expect.any(BigInt));
  });

  it("falls back to worker checkpoints for heads, excluding meta: markers", async () => {
    await writer.reconcilerRun.deleteMany();
    // 4200 from chain-events — NOT 999999 from the meta:provenance marker.
    expect(await reader.heads()).toEqual({
      chainHeight: null,
      indexedHeight: 4200,
      reconciledAt: null,
    });
  });
});
