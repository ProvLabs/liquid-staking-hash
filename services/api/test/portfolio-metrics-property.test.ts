// Property (Vitest + fast-check): the derived-metrics fold's invariants over
// random valid histories, modeled on the indexer's plan-arbitrary style
// (services/indexer/test/workers/chain-events-replay.test.ts). The plan is
// simulated as it is built so every generated history is CONSISTENT: requests
// never exceed the held pool, settlements never exceed outstanding escrow, and
// deposits/payouts enter at the NAV current at their moment (fair value), which
// is what makes the NAV-gain conservation identity hold within a floor-dust
// bound.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { TransactionFacts } from "../src/derive.ts";
import { derivePortfolioMetrics, type EpochStepFact } from "../src/portfolio-metrics.ts";

const A = "pb1walletaqq";

function valueAt(shares: bigint, epoch: EpochStepFact | null): bigint | null {
  if (epoch === null || epoch.totalShares <= 0n) return null;
  return (shares * epoch.tvvAfter) / epoch.totalShares;
}

// --- plan -> history -------------------------------------------------------

type Op =
  | { type: "epoch"; tvv: bigint; totalShares: bigint; net: number | null }
  | { type: "deposit"; shares: bigint }
  | { type: "request"; pct: number }
  | { type: "settle"; refund: boolean; pct: number };

interface Plan {
  init: { tvv: bigint; totalShares: bigint; net: number | null };
  ops: Op[];
}

// Height is the sequence counter; block time is a day per step so epoch
// durations are realistic (a 1-second epoch would annualize to absurd,
// safe-integer-overflowing bps, outside the on-chain input domain).
const DAY_MS = 86_400_000;

function ev(kind: TransactionFacts["kind"], h: bigint, shares: bigint, nhash: bigint): TransactionFacts {
  return {
    txhash: `tx${h}`,
    msgIndex: 0,
    address: A,
    kind,
    shares,
    nhash,
    navAtHeight: 0n,
    height: h,
    blockTime: new Date(Number(h) * DAY_MS),
  };
}

/** Materialize a plan into a consistent (txs, epochs) history. */
function build(plan: Plan): { txs: TransactionFacts[]; epochs: EpochStepFact[] } {
  const txs: TransactionFacts[] = [];
  const epochs: EpochStepFact[] = [];
  let h = 1n;
  let held = 0n;
  let escrow = 0n;
  const DAY = 86_400n;
  let nav: EpochStepFact = {
    epochIndex: 0n,
    endedAtSeconds: h * DAY,
    tvvAfter: plan.init.tvv,
    totalShares: plan.init.totalShares,
    netAprBps: plan.init.net,
    endHeight: h,
  };
  epochs.push(nav);
  h += 1n;
  let epochIndex = 1n;

  const clampPct = (pool: bigint, pct: number): bigint => {
    if (pool <= 0n) return 0n;
    const s = (pool * BigInt(pct)) / 100n;
    return s < 1n ? 1n : s > pool ? pool : s;
  };

  for (const op of plan.ops) {
    const at = h;
    h += 1n;
    if (op.type === "epoch") {
      nav = {
        epochIndex,
        endedAtSeconds: at * DAY,
        tvvAfter: op.tvv,
        totalShares: op.totalShares,
        netAprBps: op.net,
        endHeight: at,
      };
      epochs.push(nav);
      epochIndex += 1n;
    } else if (op.type === "deposit") {
      const basis = valueAt(op.shares, nav) ?? 0n; // fair value at current NAV
      txs.push(ev("swap_in", at, op.shares, basis));
      held += op.shares;
    } else if (op.type === "request") {
      const s = clampPct(held, op.pct);
      if (s === 0n) continue;
      txs.push(ev("swap_out_request", at, s, 0n));
      held -= s;
      escrow += s;
    } else {
      const s = clampPct(escrow, op.pct);
      if (s === 0n) continue;
      if (op.refund) {
        txs.push(ev("redemption_refund", at, s, 0n));
        held += s;
      } else {
        const payout = valueAt(s, nav) ?? 0n; // fair value at current NAV
        txs.push(ev("redemption_payout", at, s, payout));
      }
      escrow -= s;
    }
  }
  return { txs, epochs };
}

/** Independent accounting reference (event fold + a separate time-ordered epoch
 * gain pass). Deliberately not the fold's merged two-pointer walk. */
interface Ref {
  held: bigint;
  escrow: bigint;
  heldBasis: bigint;
  escrowBasis: bigint;
  realized: bigint;
  sumGain: bigint;
  lastNav: EpochStepFact | null;
}

function reference(txs: readonly TransactionFacts[], epochs: readonly EpochStepFact[]): Ref {
  const moments = [
    ...txs.map((t, idx) => ({ t: BigInt(Math.floor(t.blockTime.getTime() / 1000)), phase: 0, idx, tx: t as TransactionFacts | undefined, ep: undefined as EpochStepFact | undefined })),
    ...epochs.map((e, idx) => ({ t: e.endedAtSeconds, phase: 1, idx, tx: undefined as TransactionFacts | undefined, ep: e as EpochStepFact | undefined })),
  ].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.phase - b.phase));

  let held = 0n;
  let escrow = 0n;
  let hb = 0n;
  let eb = 0n;
  let realized = 0n;
  let sumGain = 0n;
  let nav: EpochStepFact | null = null;
  let prevEpoch: EpochStepFact | null = null;

  for (const m of moments) {
    if (m.tx) {
      const t = m.tx;
      if (t.kind === "swap_in") {
        held += t.shares;
        hb += t.nhash;
      } else if (t.kind === "swap_out_request") {
        const moved = (hb * t.shares) / held;
        held -= t.shares;
        hb -= moved;
        escrow += t.shares;
        eb += moved;
      } else if (t.kind === "redemption_payout") {
        const removed = (eb * t.shares) / escrow;
        escrow -= t.shares;
        eb -= removed;
        realized += t.nhash - removed;
      } else if (t.kind === "redemption_refund") {
        const returned = (eb * t.shares) / escrow;
        escrow -= t.shares;
        eb -= returned;
        held += t.shares;
        hb += returned;
      }
    } else if (m.ep) {
      const e = m.ep;
      const S = held + escrow;
      if (prevEpoch !== null && prevEpoch.totalShares > 0n && e.totalShares > 0n) {
        sumGain += valueAt(S, e)! - valueAt(S, prevEpoch)!;
      }
      if (e.totalShares > 0n) nav = e;
      prevEpoch = e;
    }
  }
  return { held, escrow, heldBasis: hb, escrowBasis: eb, realized, sumGain, lastNav: nav };
}

const bigShares = fc.bigInt({ min: 1n, max: 10n ** 15n });
// NAV stays in [0.5, 2] against a fixed vault size, the on-chain domain where
// stepwise NAV moves modestly per epoch, which keeps annualized bps within the
// safe-integer range the derive.ts guards enforce.
const bigTvv = fc.bigInt({ min: 5n * 10n ** 17n, max: 2n * 10n ** 18n });
const bigTotal = fc.constant(10n ** 18n);
const netArb = fc.option(fc.integer({ min: -5000, max: 5000 }), { nil: null });

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ type: fc.constant("epoch" as const), tvv: bigTvv, totalShares: bigTotal, net: netArb }),
  fc.record({ type: fc.constant("deposit" as const), shares: bigShares }),
  fc.record({ type: fc.constant("request" as const), pct: fc.integer({ min: 1, max: 100 }) }),
  fc.record({ type: fc.constant("settle" as const), refund: fc.boolean(), pct: fc.integer({ min: 1, max: 100 }) }),
);

const planArb: fc.Arbitrary<Plan> = fc.record({
  init: fc.record({ tvv: bigTvv, totalShares: bigTotal, net: netArb }),
  ops: fc.array(opArb, { maxLength: 30 }),
});

describe("derivePortfolioMetrics: properties", () => {
  it("conservation + fold matches the reference on every prefix", () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const { txs, epochs } = build(plan);
        const cutoffs = [...new Set([...txs.map((t) => t.height), ...epochs.map((e) => e.endHeight)])].sort(
          (a, b) => (a < b ? -1 : a > b ? 1 : 0),
        );
        for (const cut of cutoffs) {
          const ptxs = txs.filter((t) => t.height <= cut);
          const peps = epochs.filter((e) => e.endHeight <= cut);
          const m = derivePortfolioMetrics(A, ptxs, peps);
          const ref = reference(ptxs, peps);

          expect(m.history_state).toBe("complete"); // no transfers, always consistent
          expect(m.indexed_share_balance).toBe(ref.held.toString());
          expect(m.escrowed_share_balance).toBe(ref.escrow.toString());
          expect(m.cost_basis_nhash).toBe(ref.heldBasis.toString());
          expect(m.escrowed_basis_nhash).toBe(ref.escrowBasis.toString());
          expect(m.realized_gain_nhash).toBe(ref.realized.toString());

          // basis sanity
          expect(ref.heldBasis >= 0n).toBe(true);
          expect(ref.escrowBasis >= 0n).toBe(true);
          if (ref.held === 0n) expect(m.cost_basis_nhash).toBe("0");
          if (ref.escrow === 0n) expect(m.escrowed_basis_nhash).toBe("0");

          // value conservation within a per-floor-site dust bound
          if (ref.lastNav !== null) {
            const pv = valueAt(ref.held + ref.escrow, ref.lastNav)!;
            const diff = pv - (ref.heldBasis + ref.escrowBasis) + ref.realized - ref.sumGain;
            const bound = BigInt(ptxs.length + peps.length);
            expect(diff <= bound && diff >= -bound).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("is pure: identical input yields deeply equal output", () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const { txs, epochs } = build(plan);
        expect(derivePortfolioMetrics(A, txs, epochs)).toEqual(derivePortfolioMetrics(A, txs, epochs));
      }),
      { numRuns: 300 },
    );
  });

  it("payout realizes exactly nhash - proportional escrow basis; refunds realize nothing", () => {
    fc.assert(
      fc.property(
        fc.record({
          ds: fc.bigInt({ min: 1n, max: 10n ** 15n }),
          bn: fc.bigInt({ min: 0n, max: 10n ** 18n }),
          reqPct: fc.integer({ min: 1, max: 100 }),
          setPct: fc.integer({ min: 1, max: 100 }),
          pn: fc.bigInt({ min: 0n, max: 10n ** 18n }),
        }),
        ({ ds, bn, reqPct, setPct, pn }) => {
          const rs = ((ds * BigInt(reqPct)) / 100n) < 1n ? 1n : (ds * BigInt(reqPct)) / 100n;
          const ps = ((rs * BigInt(setPct)) / 100n) < 1n ? 1n : (rs * BigInt(setPct)) / 100n;
          const escrowBasis = (bn * rs) / ds; // moved at request
          const removed = (escrowBasis * ps) / rs;

          const paid = derivePortfolioMetrics(A, [
            ev("swap_in", 1n, ds, bn),
            ev("swap_out_request", 2n, rs, 0n),
            ev("redemption_payout", 3n, ps, pn),
          ], []);
          expect(paid.realized_gain_nhash).toBe((pn - removed).toString());
          expect(BigInt(paid.escrowed_basis_nhash!) >= 0n).toBe(true);

          const refunded = derivePortfolioMetrics(A, [
            ev("swap_in", 1n, ds, bn),
            ev("swap_out_request", 2n, rs, 0n),
            ev("redemption_refund", 3n, ps, 0n),
          ], []);
          expect(refunded.realized_gain_nhash).toBe("0");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("full refund restores the pools exactly", () => {
    fc.assert(
      fc.property(
        fc.record({ ds: fc.bigInt({ min: 1n, max: 10n ** 15n }), bn: fc.bigInt({ min: 0n, max: 10n ** 18n }), reqPct: fc.integer({ min: 1, max: 100 }) }),
        ({ ds, bn, reqPct }) => {
          const rs = ((ds * BigInt(reqPct)) / 100n) < 1n ? 1n : (ds * BigInt(reqPct)) / 100n;
          const m = derivePortfolioMetrics(A, [
            ev("swap_in", 1n, ds, bn),
            ev("swap_out_request", 2n, rs, 0n),
            ev("redemption_refund", 3n, rs, 0n),
          ], []);
          expect(m.indexed_share_balance).toBe(ds.toString());
          expect(m.escrowed_share_balance).toBe("0");
          expect(m.cost_basis_nhash).toBe(bn.toString());
          expect(m.escrowed_basis_nhash).toBe("0");
          expect(m.realized_gain_nhash).toBe("0");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("hold-only: personal APR equals the program NAV-step APR", () => {
    // Constant share count (NAV moves via tvv), deposit before the first step,
    // and the position IS the whole vault (S = totalShares) so value_at is
    // floor-exact, so personal must equal the NAV-derived program APR exactly.
    const T = 10n ** 18n;
    const stepArb = fc.record({
      tvv: fc.bigInt({ min: 5n * 10n ** 17n, max: 2n * 10n ** 18n }),
      net: fc.option(fc.integer({ min: -5000, max: 5000 }), { nil: null }),
      gap: fc.bigInt({ min: 1000n, max: 10n ** 6n }),
    });
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 2, maxLength: 8 }), (steps) => {
        // deposit at second 86400 (height 1); first epoch strictly after.
        const txs = [ev("swap_in", 1n, T, T)];
        const epochs: EpochStepFact[] = [];
        let sec = 1_000_000n;
        let idx = 0n;
        for (const s of steps) {
          epochs.push({ epochIndex: idx, endedAtSeconds: sec, tvvAfter: s.tvv, totalShares: T, netAprBps: s.net, endHeight: sec });
          sec += s.gap;
          idx += 1n;
        }
        const m = derivePortfolioMetrics(A, txs, epochs);
        const SPY = 31_536_000n;
        for (let k = 1; k < epochs.length; k += 1) {
          const p = epochs[k - 1]!;
          const e = epochs[k]!;
          const dur = e.endedAtSeconds - p.endedAtSeconds;
          const num = (e.tvvAfter - p.tvvAfter) * 10_000n * SPY;
          const den = p.tvvAfter * dur;
          const q = den === 0n ? 0n : num / den; // BigInt trunc toward zero
          const yp = m.yield_by_epoch.find((y) => y.epoch_index === Number(e.epochIndex));
          expect(yp?.personal_apr_bps).toBe(Number(q));
        }
      }),
      { numRuns: 300 },
    );
  });
});
