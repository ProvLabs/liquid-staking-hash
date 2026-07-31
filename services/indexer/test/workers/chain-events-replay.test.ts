// Property (Vitest + fast-check): the reducer's derived state is byte-identical
// whether replayed from height 0 in one pass or resumed from an arbitrary
// restart height — the app-spec §9.2 / SECURITY.md "idempotent replay"
// guarantee, executable. An in-memory Store stands in for Postgres (the same
// pure `applyEvents` runs against both), so the property is Postgres-free.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyEvents,
  type OperatorPaymentRow,
  type RedemptionRow,
  type Store,
  type TransactionRow,
} from "../../src/workers/chain-events/reduce.ts";
import type { DomainEvent } from "../../src/workers/chain-events/events.ts";

class MemStore implements Store {
  readonly txs = new Map<string, TransactionRow>();
  readonly reds = new Map<string, RedemptionRow>();
  readonly pays = new Map<string, OperatorPaymentRow>();
  private nav = 0n;
  async readNav(): Promise<bigint> {
    return this.nav;
  }
  async writeNav(nav: bigint): Promise<void> {
    this.nav = nav;
  }
  async getRedemption(requestId: string): Promise<RedemptionRow | null> {
    return this.reds.get(requestId) ?? null;
  }
  async upsertTransaction(row: TransactionRow): Promise<void> {
    this.txs.set(`${row.txhash}|${row.msgIndex}`, row);
  }
  async upsertRedemption(row: RedemptionRow): Promise<void> {
    this.reds.set(row.requestId, row);
  }
  async upsertOperatorPayment(row: OperatorPaymentRow): Promise<void> {
    this.pays.set(`${row.txhash}|${row.msgIndex}`, row);
  }
  get nav_(): bigint {
    return this.nav;
  }
}

/** Order-independent, bigint/date-safe snapshot for deep comparison. */
function snapshot(store: MemStore): unknown {
  const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
  const txs = [...store.txs.values()]
    .map((t) => ({
      key: `${t.txhash}|${t.msgIndex}`,
      address: t.address,
      kind: t.kind,
      shares: t.shares.toString(),
      nhash: t.nhash.toString(),
      navAtHeight: t.navAtHeight.toString(),
      height: t.height.toString(),
      blockTime: t.blockTime.toISOString(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const reds = [...store.reds.values()]
    .map((r) => ({
      requestId: r.requestId,
      owner: r.owner,
      shares: r.shares.toString(),
      status: r.status,
      enqueuedAt: r.enqueuedAt.toISOString(),
      expeditedAt: iso(r.expeditedAt),
      maturedAt: iso(r.maturedAt),
      refundedAt: iso(r.refundedAt),
      lastHeight: r.lastHeight.toString(),
      lastTxhash: r.lastTxhash,
    }))
    .sort((a, b) => a.requestId.localeCompare(b.requestId));
  const pays = [...store.pays.values()]
    .map((p) => ({
      key: `${p.txhash}|${p.msgIndex}`,
      valoper: p.valoper,
      payer: p.payer,
      paymentType: p.paymentType,
      amount: p.amount.toString(),
      epochIndex: p.epochIndex === null ? null : p.epochIndex.toString(),
      height: p.height.toString(),
      occurredAt: p.occurredAt.toISOString(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { txs, reds, pays, nav: store.nav_.toString() };
}

// A high-level plan of program activity, turned into a valid height-ordered
// event stream (per-request order: requested → expedited? → terminal?).
interface Plan {
  navs: bigint[];
  swapIns: { owner: string; nhash: bigint; shares: bigint }[];
  requests: {
    id: string;
    owner: string;
    shares: bigint;
    expedite: boolean;
    terminal: "none" | "matured" | "refunded";
  }[];
  payments: { valoper: string; payer: string; paymentType: "commission" | "tip"; amount: bigint }[];
  splitFraction: number;
}

function build(plan: Plan): DomainEvent[] {
  const evs: DomainEvent[] = [];
  let h = 1n;
  const at = (): { height: bigint; blockTime: Date } => {
    const height = h;
    h += 1n;
    return { height, blockTime: new Date(Number(height) * 1000) };
  };

  for (const price of plan.navs) evs.push({ kind: "nav", priceNhash: price, ...at() });
  for (const s of plan.swapIns) {
    const ctx = at();
    evs.push({
      kind: "swap_in",
      owner: s.owner,
      nhashIn: s.nhash,
      sharesReceived: s.shares,
      txhash: `tx${ctx.height}`,
      msgIndex: 0,
      ...ctx,
    });
  }
  for (const r of plan.requests) {
    const reqCtx = at();
    evs.push({
      kind: "swap_out_requested",
      owner: r.owner,
      requestId: r.id,
      shares: r.shares,
      redeemDenom: "nhash",
      txhash: `tx${reqCtx.height}`,
      msgIndex: 0,
      ...reqCtx,
    });
    if (r.expedite && r.terminal !== "refunded") {
      const exCtx = at();
      evs.push({
        kind: "expedited",
        requestId: r.id,
        txhash: `tx${exCtx.height}`,
        msgIndex: 0,
        ...exCtx,
      });
    }
    if (r.terminal === "matured")
      evs.push({
        kind: "swap_out_completed",
        owner: r.owner,
        requestId: r.id,
        assetsNhash: r.shares,
        ...at(),
      });
    if (r.terminal === "refunded")
      evs.push({
        kind: "swap_out_refunded",
        owner: r.owner,
        requestId: r.id,
        shares: r.shares,
        reason: "insufficient_funds",
        ...at(),
      });
  }
  for (const p of plan.payments) {
    const ctx = at();
    evs.push({
      kind: "operator_payment",
      ordinal: 0,
      paymentType: p.paymentType,
      valoper: p.valoper,
      payer: p.payer,
      amount: p.amount,
      txhash: `tx${ctx.height}`,
      msgIndex: 0,
      ...ctx,
    });
  }
  return evs;
}

const bigintArb = fc.bigInt({ min: 0n, max: 10n ** 18n });
const planArb: fc.Arbitrary<Plan> = fc.record({
  navs: fc.array(fc.bigInt({ min: 1n, max: 10n ** 18n }), { maxLength: 5 }),
  swapIns: fc.array(
    fc.record({
      owner: fc.constantFrom("tp1a", "tp1b", "tp1c"),
      nhash: bigintArb,
      shares: bigintArb,
    }),
    { maxLength: 5 },
  ),
  requests: fc.uniqueArray(
    fc.record({
      id: fc.nat(40).map(String),
      owner: fc.constantFrom("tp1a", "tp1b", "tp1c"),
      shares: fc.bigInt({ min: 1n, max: 10n ** 12n }),
      expedite: fc.boolean(),
      terminal: fc.constantFrom("none", "matured", "refunded") as fc.Arbitrary<
        "none" | "matured" | "refunded"
      >,
    }),
    { selector: (r) => r.id, maxLength: 10 },
  ),
  payments: fc.array(
    fc.record({
      valoper: fc.constantFrom("tpvaloper1a", "tpvaloper1b"),
      payer: fc.constantFrom("tp1a", "tp1b", "tp1c"),
      paymentType: fc.constantFrom("commission", "tip") as fc.Arbitrary<"commission" | "tip">,
      amount: fc.bigInt({ min: 1n, max: 10n ** 15n }),
    }),
    { maxLength: 6 },
  ),
  splitFraction: fc.double({ min: 0, max: 1, noNaN: true }),
});

async function replay(events: DomainEvent[]): Promise<MemStore> {
  const store = new MemStore();
  await applyEvents(store, events);
  return store;
}

describe("chain-events replay convergence", () => {
  it("resume from an arbitrary height == full replay from 0", async () => {
    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        const events = build(plan);
        const maxHeight = events.length === 0 ? 0 : Number(events[events.length - 1]!.height);
        const k = BigInt(Math.floor(plan.splitFraction * maxHeight));

        const part1 = events.filter((e) => e.height <= k);
        const part2 = events.filter((e) => e.height > k);

        const resumed = new MemStore();
        await applyEvents(resumed, part1); // "processed up to height k, then crashed"
        await applyEvents(resumed, part2); // "resumed from the checkpoint"

        const full = await replay(events);
        expect(snapshot(resumed)).toEqual(snapshot(full));
      }),
      { numRuns: 300 },
    );
  });

  it("re-applying the full stream is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        const events = build(plan);
        const once = await replay(events);
        const twice = new MemStore();
        await applyEvents(twice, events);
        await applyEvents(twice, events); // replay the same range again
        expect(snapshot(twice)).toEqual(snapshot(once));
      }),
      { numRuns: 200 },
    );
  });
});
