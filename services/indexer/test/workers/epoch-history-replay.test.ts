// Property (Vitest + fast-check): backfilling epoch history in one pass over the
// whole range yields the same `epoch_snapshots` as resuming from an arbitrary
// checkpoint height, and re-applying is idempotent — the height-pinned backfill
// converges (app-spec §9.2/§9.3, SECURITY.md idempotent replay). A fake chain
// (cranks at heights, deterministic snapshot per height) drives the real worker
// `collect`; an in-memory store stands in for Postgres.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { RpcClient, PinnedLcdClient } from "../../src/transport/rpc.ts";
import { createEpochHistoryWorker } from "../../src/workers/epoch-history/index.ts";
import { applyEpochRows, type EpochStore } from "../../src/workers/epoch-history/write.ts";
import type { EpochRow } from "../../src/workers/epoch-history/snapshot.ts";

const CONTRACT = "tp1contract";

class MemEpochStore implements EpochStore {
  readonly rows = new Map<string, EpochRow>();
  async upsertEpoch(row: EpochRow): Promise<void> {
    this.rows.set(row.epochIndex.toString(), row);
  }
}

function snapshot(store: MemEpochStore): unknown {
  return [...store.rows.values()]
    .map((r) => ({
      epochIndex: r.epochIndex.toString(),
      endHeight: r.endHeight.toString(),
      tvvAfter: r.tvvAfter.toString(),
      netDeposits: r.netDeposits.toString(),
      grossAprBps: r.grossAprBps,
      netAprBps: r.netAprBps,
      txhash: r.txhash,
      height: r.height.toString(),
      observedAt: r.observedAt.toISOString(),
    }))
    .sort((a, b) => Number(BigInt(a.epochIndex) - BigInt(b.epochIndex)));
}

interface BuiltCrank {
  height: bigint;
  txhash: string;
  epochIndex: number;
  tvvAfter: bigint;
  aprBps: number;
}

function snapshotJson(epochIndex: number, endHeight: bigint, tvvAfter: bigint): Record<string, unknown> {
  return {
    epoch_index: epochIndex,
    started_at_seconds: 1,
    ended_at_seconds: 2,
    end_height: Number(endHeight),
    tvv_before: "0",
    tvv_after: tvvAfter.toString(),
    total_shares: "1000",
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

/** Fake chain: cranks at heights; a height-pinned query at a crank height
 * returns that crank's deterministic snapshot/apr. */
function fakeChain(cranks: readonly BuiltCrank[]): { rpc: RpcClient; pinned: PinnedLcdClient } {
  const byHeight = new Map(cranks.map((c) => [c.height.toString(), c]));
  const runEpochEvent = {
    type: "wasm",
    attributes: [
      { key: "action", value: "run_epoch" },
      { key: "_contract_address", value: CONTRACT },
      { key: "msg_index", value: "0" },
    ],
  };

  const rpc = {
    txSearch: async (query: string) => {
      const m = /tx\.height>=(\d+) AND tx\.height<=(\d+)/.exec(query);
      const from = BigInt(m![1]!);
      const to = BigInt(m![2]!);
      const txs = cranks
        .filter((c) => c.height >= from && c.height <= to)
        .map((c) => ({ hash: c.txhash, height: c.height, events: [runEpochEvent] }));
      return { totalCount: txs.length, txs };
    },
    blockTime: async (height: bigint | number) => new Date(Number(height) * 1000),
  } as unknown as RpcClient;

  const pinned = {
    smartAtHeight: async (_contract: string, query: Record<string, unknown>, height: bigint | number) => {
      const c = byHeight.get(BigInt(height).toString());
      if (!c) throw new Error(`no crank at height ${height}`);
      if ("epoch_snapshot" in query) return { snapshot: snapshotJson(c.epochIndex, c.height, c.tvvAfter) };
      if ("apr" in query) return { epoch_index: c.epochIndex, gross_apr_bps: c.aprBps, net_apr_bps: c.aprBps };
      throw new Error("unexpected query");
    },
  } as unknown as PinnedLcdClient;

  return { rpc, pinned };
}

const chainArb = fc.record({
  cranks: fc.array(
    fc.record({ gap: fc.integer({ min: 1, max: 20 }), tvvAfter: fc.bigInt({ min: 0n, max: 10n ** 24n }), aprBps: fc.nat(20000) }),
    { maxLength: 15 },
  ),
  splitFraction: fc.double({ min: 0, max: 1, noNaN: true }),
});

function build(cranks: { gap: number; tvvAfter: bigint; aprBps: number }[]): BuiltCrank[] {
  let h = 0n;
  return cranks.map((c, i) => {
    h += BigInt(c.gap);
    return { height: h, txhash: `tx${h}`, epochIndex: i, tvvAfter: c.tvvAfter, aprBps: c.aprBps };
  });
}

describe("epoch-history backfill convergence", () => {
  it("resume from an arbitrary height == full backfill", async () => {
    await fc.assert(
      fc.asyncProperty(chainArb, async ({ cranks, splitFraction }) => {
        const built = build(cranks);
        const maxH = built.length === 0 ? 1n : built[built.length - 1]!.height;
        const worker = createEpochHistoryWorker({ ...fakeChain(built), contractAddress: CONTRACT });

        const full = new MemEpochStore();
        await applyEpochRows(full, await worker.collect({ from: 1n, to: maxH }));

        const k = BigInt(Math.floor(splitFraction * Number(maxH)));
        const split = new MemEpochStore();
        await applyEpochRows(split, await worker.collect({ from: 1n, to: k }));
        await applyEpochRows(split, await worker.collect({ from: k + 1n, to: maxH }));

        expect(snapshot(split)).toEqual(snapshot(full));
      }),
      { numRuns: 200 },
    );
  });

  it("re-applying the backfill is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(chainArb, async ({ cranks }) => {
        const built = build(cranks);
        const maxH = built.length === 0 ? 1n : built[built.length - 1]!.height;
        const worker = createEpochHistoryWorker({ ...fakeChain(built), contractAddress: CONTRACT });

        const once = new MemEpochStore();
        await applyEpochRows(once, await worker.collect({ from: 1n, to: maxH }));
        const twice = new MemEpochStore();
        await applyEpochRows(twice, await worker.collect({ from: 1n, to: maxH }));
        await applyEpochRows(twice, await worker.collect({ from: 1n, to: maxH }));

        expect(snapshot(twice)).toEqual(snapshot(once));
      }),
      { numRuns: 100 },
    );
  });
});
