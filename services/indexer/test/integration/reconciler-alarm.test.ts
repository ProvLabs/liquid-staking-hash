// Reconciler alarm — the M2.5 acceptance gate (app-spec §9.6/§12.1, plan §2):
// feed a deliberately corrupted indexed row and observe the incident open,
// end-to-end against real Postgres. Seeds an `epoch_snapshots` row whose
// `total_shares` diverges from what the (faked) live chain reports for the same
// epoch, runs one reconciliation pass, and asserts a `reconciler_divergence`
// incident opens and the `reconciler_runs` row records the divergence.
//
// Runs in the app-ci `db-grants` job (Postgres service) and infra/devnet
// stack verification, alongside the grant-boundary gate. It brings its own
// Prisma client (URL from DATABASE_URL / ADMIN_DATABASE_URL) so it does not
// depend on the singleton's environment.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { reconcileOnce, type ReconcilerDeps } from "../../src/reconciler/index.ts";
import type { PinnedLcdClient, RpcClient } from "../../src/transport/rpc.ts";

const URL =
  process.env.DATABASE_URL ??
  process.env.ADMIN_DATABASE_URL ??
  "postgresql://nvhash:nvhash-dev@postgres:5432/nvhash?schema=indexed";

// A distinctive epoch index unlikely to collide with real data, so cleanup is
// surgical on a shared dev/CI database.
const TEST_EPOCH = 999_999n;
const INDEXED_TOTAL_SHARES = 1000n; // what we (corruptly) stored
const LIVE_TOTAL_SHARES = 999n; // what chain actually reports → divergence

const prisma = new PrismaClient({ datasources: { db: { url: URL } } });

/** A full epoch_snapshot JSON payload with a given index + total_shares. */
function snapshotJson(epochIndex: bigint, totalShares: bigint): Record<string, unknown> {
  return {
    epoch_index: Number(epochIndex),
    started_at_seconds: 1,
    ended_at_seconds: 2,
    end_height: 100,
    tvv_before: "0",
    tvv_after: "500",
    total_shares: totalShares.toString(),
    rewards_claimed: "0",
    commission_received: "0",
    tips_received: "0",
    rewards_deposited: "0",
    settled: "0",
    write_down: "0",
    deployed: "0",
    rebalanced: "0",
    unbonded_for_redemptions: "0",
    aum_fee_estimate: "0",
    net_deposits: "0",
    redemptions_expedited: 0,
    validators_purged: 0,
    eligible_count: 0,
  };
}

/** Fake chain: reports LIVE_TOTAL_SHARES for TEST_EPOCH, not halted. */
const fakeRpc = { latestHeight: async () => 1000n } as unknown as RpcClient;
const fakePinned = {
  smartAtHeight: async (_c: string, query: Record<string, unknown>) => {
    if ("epoch_snapshot" in query) return { snapshot: snapshotJson(TEST_EPOCH, LIVE_TOTAL_SHARES) };
    if ("epoch_status" in query) return { phase: "idle", halted: false, last_run_seconds: 0 };
    throw new Error("unexpected query");
  },
} as unknown as PinnedLcdClient;

const deps: ReconcilerDeps = {
  prisma,
  rpc: fakeRpc,
  pinned: fakePinned,
  contractAddress: "tp1contract",
  cadenceMs: 1000,
  sleep: async () => {},
  signal: new AbortController().signal,
  now: () => new Date("2026-07-21T00:00:00Z"),
};

async function cleanup(): Promise<void> {
  await prisma.reconcilerRun.deleteMany({ where: { chainHeight: 1000n } });
  await prisma.incident.deleteMany({ where: { kind: "reconciler_divergence", dedupeKey: "latest" } });
  await prisma.epochSnapshot.deleteMany({ where: { epochIndex: TEST_EPOCH } });
}

beforeAll(async () => {
  // Guard: the schema must be migrated for this end-to-end gate to be meaningful.
  await prisma.$queryRaw`SELECT 1 FROM indexed.epoch_snapshots LIMIT 1`.catch((cause: unknown) => {
    throw new Error(
      `indexed.epoch_snapshots is absent — run the indexer migration (migrate:deploy) ` +
        `before this test. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  });
  await cleanup();
  // Seed the corrupted indexed copy: same epoch, wrong total_shares.
  await prisma.epochSnapshot.create({
    data: {
      epochIndex: TEST_EPOCH,
      startedAtSeconds: 1n,
      endedAtSeconds: 2n,
      endHeight: 100n,
      tvvBefore: "0",
      tvvAfter: "500",
      totalShares: INDEXED_TOTAL_SHARES.toString(),
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
      redemptionsExpedited: 0,
      validatorsPurged: 0,
      eligibleCount: 0,
      grossAprBps: 0,
      netAprBps: 0,
      txhash: "SEED",
      height: 100n,
      observedAt: new Date("2026-07-21T00:00:00Z"),
    },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("reconciler alarm (M2.5 acceptance gate)", () => {
  it("opens a reconciler_divergence incident when an indexed row is corrupt", async () => {
    await reconcileOnce(deps);

    const incident = await prisma.incident.findUnique({
      where: { kind_dedupeKey: { kind: "reconciler_divergence", dedupeKey: "latest" } },
    });
    expect(incident).not.toBeNull();
    expect(incident?.closedAt).toBeNull(); // open
    expect(incident?.severity).toBe("critical");

    const run = await prisma.reconcilerRun.findFirst({
      where: { chainHeight: 1000n },
      orderBy: { id: "desc" },
    });
    expect(run?.withinTolerance).toBe(false);
    expect(run?.incidentId).toBe(incident?.id); // the run links the incident it opened
  });

  it("closes the incident once the indexed copy matches chain again", async () => {
    // Fix the corrupted row to match the live value, then re-run.
    await prisma.epochSnapshot.update({
      where: { epochIndex: TEST_EPOCH },
      data: { totalShares: LIVE_TOTAL_SHARES.toString() },
    });

    await reconcileOnce(deps);

    const incident = await prisma.incident.findUnique({
      where: { kind_dedupeKey: { kind: "reconciler_divergence", dedupeKey: "latest" } },
    });
    expect(incident?.closedAt).not.toBeNull(); // closed now
  });
});
