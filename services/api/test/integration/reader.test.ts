// Postgres-backed reader gate (PR 3.1, plan §5): the real Prisma queries and
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
    await writer.redemptionRequest.deleteMany();
    await writer.epochSnapshot.deleteMany();
    await writer.marketSample.deleteMany();
    await writer.bridgeSupplySample.deleteMany();
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
      data: { ranAt: new Date("2026-07-22T00:00:00Z"), chainHeight: 4242n, indexedHeight: 4200n, deltas: {}, withinTolerance: true },
    });
    await writer.transaction.createMany({
      data: [
        { txhash: "AA", msgIndex: 0, address: "pb1alice", kind: "swap_in", shares: "1000", nhash: "1017", navAtHeight: "10175", height: 100n, blockTime: new Date("2026-06-01T00:00:00Z") },
        { txhash: "BB", msgIndex: 0, address: "pb1bob", kind: "swap_in", shares: "2000", nhash: "2035", navAtHeight: "10175", height: 200n, blockTime: new Date("2026-06-02T00:00:00Z") },
        { txhash: "CC", msgIndex: 0, address: "pb1alice", kind: "swap_out_request", shares: "500", nhash: "0", navAtHeight: "10175", height: 300n, blockTime: new Date("2026-06-03T00:00:00Z") },
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
      data: { kind: "indexer_lag", severity: "warning", dedupeKey: "test", openedAt: new Date("2026-07-01T00:00:00Z"), openedHeight: 900n, payload: {} },
    });
    await writer.validatorRegistry.createMany({
      data: [
        { valoper: "pbvaloper1aaa", operator: "pb1aaa", moniker: "alpha", enrolledAt: new Date("2026-05-01T00:00:00Z") },
        { valoper: "pbvaloper1bbb", operator: "pb1bbb", moniker: "bravo", enrolledAt: new Date("2026-05-01T00:00:00Z") },
      ],
    });
    await writer.validatorEpoch.createMany({
      data: [
        { valoper: "pbvaloper1aaa", epochIndex: 11n, uptimeBps: 9000, eligible: false, failingReasons: ["uptime"], tip: "0", commissionAccrued: "0", commissionPaid: "0", commissionDue: "9", programDelegation: "1", height: 3000n, observedAt: new Date("2026-06-01T00:00:00Z") },
        { valoper: "pbvaloper1aaa", epochIndex: 12n, uptimeBps: 9990, eligible: true, failingReasons: [], tip: "0", commissionAccrued: "0", commissionPaid: "0", commissionDue: "5", programDelegation: "1000000000", height: 4100n, observedAt: new Date("2026-07-01T00:00:00Z") },
      ],
    });
    // Address plane (PR 3.3): one active (enqueued) and one terminal
    // (matured) redemption — the portfolio read must escrow only the former.
    await writer.redemptionRequest.createMany({
      data: [
        { requestId: "req-1", owner: "pb1alice", shares: "500", status: "enqueued", enqueuedAt: new Date("2026-06-03T00:00:00Z"), lastHeight: 300n, lastTxhash: "CC" },
        { requestId: "req-0", owner: "pb1alice", shares: "100", status: "matured", enqueuedAt: new Date("2026-05-01T00:00:00Z"), maturedAt: new Date("2026-05-20T00:00:00Z"), lastHeight: 50n, lastTxhash: "OLD" },
      ],
    });
    // Market plane (PR 3.2): the sample predates every settled epoch, so the
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

  it("reads heads from the latest reconciler run", async () => {
    expect(await reader.heads()).toEqual({ chainHeight: 4242, indexedHeight: 4200 });
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
      { epoch_index: 12, ended_at: "2026-01-01T00:00:00.000Z", nav: "1.0175", tvv: FIXTURE_TVV, net_apr_bps: 431 },
    ]);
  });

  it("lists incidents", async () => {
    expect(await reader.listIncidents({ limit: 50, offset: 0 })).toEqual([
      { kind: "indexer_lag", severity: "warning", opened_at: "2026-07-01T00:00:00.000Z", closed_at: null, height: 900 },
    ]);
  });

  it("joins validators to their latest sample and aggregates set health", async () => {
    const payload = await reader.listValidators();
    expect(payload.validators).toEqual([
      { valoper: "pbvaloper1aaa", moniker: "alpha", active: true, epoch_index: 12, uptime_bps: 9990, eligible: true, failing_reasons: [], program_delegation: "1000000000", commission_due: "5" },
      { valoper: "pbvaloper1bbb", moniker: "bravo", active: true, epoch_index: null, uptime_bps: null, eligible: null, failing_reasons: [], program_delegation: null, commission_due: null },
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

  it("falls back to worker checkpoints for heads, excluding meta: markers", async () => {
    await writer.reconcilerRun.deleteMany();
    // 4200 from chain-events — NOT 999999 from the meta:provenance marker.
    expect(await reader.heads()).toEqual({ chainHeight: null, indexedHeight: 4200 });
  });
});
