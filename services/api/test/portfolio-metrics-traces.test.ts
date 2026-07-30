// R3 sim-trace replay gate. The chain-free traces (Task A,
// packages/fixtures/fixtures/sim-traces) drive the production planners through
// realistic economies; here they replay through the pure derived-metrics fold
// and gate its conservation, non-negativity, and reconciliation invariants.
//
// Attribution note (Q1, RESOLVED 2026-07-23): the traces tag events
// round-robin to three synthetic addresses as documented METADATA over
// single-pooled economics: a per-address fold is not economically meaningful
// (a tagged redemption carries the whole pooled amount). derivePortfolioMetrics
// is per-address by construction, so R3's substance (the contract-derived
// dynamics) is preserved by replaying each trace's FULL event stream as ONE
// address; the address field is ignored for replay.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TransactionFacts } from "../src/derive.ts";
import { derivePortfolioMetrics, type EpochStepFact } from "../src/portfolio-metrics.ts";

const require = createRequire(import.meta.url);

interface TraceEpoch {
  epoch_index: number;
  ended_at_seconds: number;
  tvv_after: string;
  total_shares: string;
}
interface TraceEvent {
  seq: number;
  address: string;
  kind: TransactionFacts["kind"];
  shares: string;
  nhash: string;
  epoch_index: number;
}
interface Trace {
  seed: number;
  epochs: TraceEpoch[];
  events: TraceEvent[];
}
interface ManifestStats {
  deposits: number;
  swap_out_request: number;
  redemption_payout: number;
  redemption_refund: number;
}
interface ManifestEntry {
  file: string;
  seed: number;
  stats: ManifestStats;
}

// Consume the corpus via the @nvhash/fixtures workspace package: resolve its
// subpath through node, read the plain JSON via fs (the chain-client
// precedent: no export-map/JSON-import ceremony, a missing file fails loudly).
const MANIFEST_PATH = require.resolve("@nvhash/fixtures/sim-traces/manifest");
const TRACES_DIR = dirname(MANIFEST_PATH);
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { traces: ManifestEntry[] };

function loadTrace(file: string): Trace {
  return JSON.parse(readFileSync(join(TRACES_DIR, file), "utf8")) as Trace;
}

const POOLED = "pooled";
// The pre-first-settle offset: larger than any trace's event count so the
// synthesized times stay ordered, far smaller than the month-scale epoch
// spacing so they land strictly before the first settlement.
const PRE_SETTLE_GAP = 1_000_000n;

interface Synth {
  txs: TransactionFacts[];
  epochs: EpochStepFact[];
  /** Per-event [synthesized, strictLower, strictUpper] for the bounds gate. */
  bounds: Array<{ t: bigint; lower: bigint; upper: bigint }>;
}

/**
 * Synthesize monotone event times and heights from a trace. An event's
 * `epoch_index` is the last settled epoch at that moment (0 before the first
 * settle); its time is that epoch's `ended_at_seconds + seq + 1`, or, pre-first
 * -settle, `first_epoch.ended - PRE_SETTLE_GAP + seq`. Epoch step facts map
 * directly (netAprBps null: the trace carries no program APR), with a
 * synthesized ascending endHeight interleaved with the event heights by time.
 */
function synthesize(trace: Trace): Synth {
  const byIndex = new Map<number, TraceEpoch>();
  for (const e of trace.epochs) byIndex.set(e.epoch_index, e);
  const firstEpoch = trace.epochs[0]!;

  const txs: TransactionFacts[] = [];
  const bounds: Synth["bounds"] = [];
  for (const ev of trace.events) {
    const ep = byIndex.get(ev.epoch_index);
    let t: bigint;
    let lower: bigint;
    let upper: bigint;
    if (ep !== undefined) {
      // Between this settled epoch and the next one.
      t = BigInt(ep.ended_at_seconds) + BigInt(ev.seq) + 1n;
      lower = BigInt(ep.ended_at_seconds);
      const next = byIndex.get(ev.epoch_index + 1);
      upper = next !== undefined ? BigInt(next.ended_at_seconds) : t + 1n;
    } else {
      // Before the first settlement (epoch_index 0): precede every step.
      t = BigInt(firstEpoch.ended_at_seconds) - PRE_SETTLE_GAP + BigInt(ev.seq);
      lower = 0n;
      upper = BigInt(firstEpoch.ended_at_seconds);
    }
    bounds.push({ t, lower, upper });
    txs.push({
      txhash: `seq-${ev.seq}`,
      msgIndex: 0,
      address: POOLED,
      kind: ev.kind,
      shares: BigInt(ev.shares),
      nhash: BigInt(ev.nhash),
      navAtHeight: 0n,
      height: BigInt(ev.seq) + 1n, // event height = seq + 1
      blockTime: new Date(Number(t) * 1000),
    });
  }

  const epochs: EpochStepFact[] = trace.epochs.map((e) => {
    const endedAt = BigInt(e.ended_at_seconds);
    // Ascending endHeight interleaved with event heights: the count of events
    // that had occurred by this settlement (<= its time).
    const endHeight = BigInt(bounds.filter((b) => b.t <= endedAt).length);
    return {
      epochIndex: BigInt(e.epoch_index),
      endedAtSeconds: endedAt,
      tvvAfter: BigInt(e.tvv_after),
      totalShares: BigInt(e.total_shares),
      netAprBps: null,
      endHeight,
    };
  });

  return { txs, epochs, bounds };
}

/** LCG (numerical recipes); deterministic per seed for the prefix draws. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SECONDS_PER_YEAR = 31_536_000n;

function secondsOf(d: Date): bigint {
  return BigInt(Math.floor(d.getTime() / 1000));
}

/** Test-local NAV valuation (mirrors the fold's floor, computed here so the
 * RHS never borrows the fold's helpers). */
function valueAtLocal(shares: bigint, tvv: bigint, totalShares: bigint): bigint | null {
  if (totalShares <= 0n) return null;
  return (shares * tvv) / totalShares;
}

/** Independently tracked yield-bearing shares (held+escrow) at `seconds`,
 * from the raw events by signed sums: swap_in adds, redemption_payout removes,
 * request/refund only shuffle between pools (net zero). Events are time-
 * monotone, so we stop at the first one past the cutoff. */
function sharesAt(txs: readonly TransactionFacts[], seconds: bigint): bigint {
  let s = 0n;
  for (const t of txs) {
    if (secondsOf(t.blockTime) > seconds) break;
    if (t.kind === "swap_in") s += t.shares;
    else if (t.kind === "redemption_payout") s -= t.shares;
  }
  return s;
}

function firstDepositSeconds(txs: readonly TransactionFacts[]): bigint | null {
  const dep = txs.find((t) => t.kind === "swap_in");
  return dep === undefined ? null : secondsOf(dep.blockTime);
}

/**
 * INDEPENDENT sum of per-step gains: walk consecutive epoch pairs (p, e), both
 * NAV-bearing, e settled strictly after the first deposit, and accumulate
 * `value_at(S_e, e) − value_at(S_e, p)` where S_e is the yield-bearing share
 * count at e's time (recomputed from the raw events here, not read from the
 * fold). This is the mark-to-market total gain the conservation clause equates
 * with the fold's basis-method output. Never calls the fold.
 */
function stepGainSum(
  txs: readonly TransactionFacts[],
  epochs: readonly EpochStepFact[],
  firstDepSec: bigint | null,
): bigint {
  if (firstDepSec === null) return 0n;
  let sum = 0n;
  for (let j = 1; j < epochs.length; j += 1) {
    const p = epochs[j - 1]!;
    const e = epochs[j]!;
    if (p.totalShares > 0n && e.totalShares > 0n && e.endedAtSeconds > firstDepSec) {
      const s = sharesAt(txs, e.endedAtSeconds);
      sum += valueAtLocal(s, e.tvvAfter, e.totalShares)! - valueAtLocal(s, p.tvvAfter, p.totalShares)!;
    }
  }
  return sum;
}

/**
 * Cost-basis / realized bookkeeping conservation (spec §9.5.1), read from the
 * fold's OUTPUT against the raw transacted nhash. Every nhash of deposit basis
 * either remains in the held+escrow pools or was removed at a payout, and
 * realized gain is exactly payout nhash minus the basis removed, so
 *   (realized - Σpayout_nhash) == ((cost_basis + escrow_basis) - Σdeposit_nhash)
 * with NO residual. Returns the signed residual (expected 0). This gates the
 * realized/basis derivation against the actual amounts; it is NAV-independent
 * by design (the NAV/repricing path is gated separately by the per-step
 * personal-APR and accrual recomputation below).
 *
 * Note (why NOT `basis_gain == Σ step gains`): the cost-basis gain (§9.5.1,
 * built from transacted nhash) and the effective-yield step gain (§9.5.2,
 * `Σ S_e·ΔNAV` at epoch snapshots) are DIFFERENT quantities. Deposits and
 * payouts transact at the instantaneous pool NAV, not the epoch-boundary
 * snapshot NAV, so the two differ by that entry/exit pricing (measured ~8% of
 * total gain on the traces, ~1.4e19 base units on seed-9), far beyond any
 * flooring dust. See the report appendix.
 */
function basisResidual(
  result: ReturnType<typeof derivePortfolioMetrics>,
  txs: readonly TransactionFacts[],
): bigint {
  let deposits = 0n;
  let payouts = 0n;
  for (const t of txs) {
    if (t.kind === "swap_in") deposits += t.nhash;
    else if (t.kind === "redemption_payout") payouts += t.nhash;
  }
  const basis = BigInt(result.cost_basis_nhash!) + BigInt(result.escrowed_basis_nhash!);
  const realized = BigInt(result.realized_gain_nhash!);
  return realized - payouts - (basis - deposits);
}

function assertHealthy(
  result: ReturnType<typeof derivePortfolioMetrics>,
  txs: readonly TransactionFacts[],
  epochs: readonly EpochStepFact[],
  label: string,
): void {
  expect(result.history_state, `${label} history_state`).toBe("complete");
  expect(result.cost_basis_nhash, `${label} cost_basis`).not.toBeNull();
  // Bases and balances never negative.
  expect(BigInt(result.indexed_share_balance) >= 0n, `${label} held >= 0`).toBe(true);
  expect(BigInt(result.escrowed_share_balance) >= 0n, `${label} escrow >= 0`).toBe(true);
  expect(BigInt(result.cost_basis_nhash!) >= 0n, `${label} cost_basis >= 0`).toBe(true);
  expect(BigInt(result.escrowed_basis_nhash!) >= 0n, `${label} escrow_basis >= 0`).toBe(true);
  // Cost-basis / realized bookkeeping is exact against the transacted nhash.
  expect(basisResidual(result, txs), `${label} basis/realized conservation`).toBe(0n);
  // Sanity: `epochs` reach the fold; keep the param meaningful for readers.
  expect(epochs.length).toBeGreaterThan(0);
}

describe("portfolio-metrics sim-trace replay (R3)", () => {
  expect(manifest.traces.length, "all committed traces present").toBe(5);

  for (const entry of manifest.traces) {
    describe(`${entry.file} (seed ${entry.seed})`, () => {
      const trace = loadTrace(entry.file);
      const { txs, epochs, bounds } = synthesize(trace);

      it("synthesized event times stay strictly within their epoch bounds", () => {
        expect(bounds.length).toBeGreaterThan(0);
        for (let k = 0; k < bounds.length; k += 1) {
          const b = bounds[k]!;
          expect(b.t > b.lower, `event ${k}: ${b.t} > ${b.lower}`).toBe(true);
          expect(b.t < b.upper, `event ${k}: ${b.t} < ${b.upper} (before next epoch)`).toBe(true);
          if (k > 0) expect(b.t > bounds[k - 1]!.t, `event ${k} time is monotone`).toBe(true);
        }
      });

      it("full history: conservation, non-negative bases, complete", () => {
        const result = derivePortfolioMetrics(POOLED, txs, epochs);
        assertHealthy(result, txs, epochs, "full");
      });

      it("NAV-derived outputs reconcile with an independent recomputation", () => {
        const result = derivePortfolioMetrics(POOLED, txs, epochs);
        const finalShares =
          BigInt(result.indexed_share_balance) + BigInt(result.escrowed_share_balance);
        const firstDepSec = firstDepositSeconds(txs);
        expect(firstDepSec, "trace has a deposit").not.toBeNull();
        let lastNav: EpochStepFact | null = null;
        for (const e of epochs) if (e.totalShares > 0n) lastNav = e;
        expect(lastNav, "trace has a NAV-bearing epoch").not.toBeNull();

        // (a) The last accrual point prices the final shares at the last NAV.
        expect(result.accrual.length).toBeGreaterThan(0);
        const last = result.accrual[result.accrual.length - 1]!;
        expect(last.value_nhash).toBe(
          valueAtLocal(finalShares, lastNav!.tvvAfter, lastNav!.totalShares)!.toString(),
        );

        // (b) personal_apr_bps recomputed for the first and last attributable
        // epoch steps (deterministic), matched by epoch_index in the output.
        const candidates: Array<{ epochIndex: number; bps: number }> = [];
        for (let j = 1; j < epochs.length; j += 1) {
          const p = epochs[j - 1]!;
          const e = epochs[j]!;
          if (!(p.totalShares > 0n && e.totalShares > 0n && p.endedAtSeconds >= firstDepSec!)) continue;
          const s = sharesAt(txs, e.endedAtSeconds);
          const dur = e.endedAtSeconds - p.endedAtSeconds;
          const vp = valueAtLocal(s, p.tvvAfter, p.totalShares)!;
          const ve = valueAtLocal(s, e.tvvAfter, e.totalShares)!;
          if (s > 0n && dur > 0n && vp > 0n) {
            candidates.push({
              epochIndex: Number(e.epochIndex),
              bps: Number(((ve - vp) * 10_000n * SECONDS_PER_YEAR) / (vp * dur)),
            });
          }
        }
        expect(candidates.length, "≥ 2 attributable steps").toBeGreaterThanOrEqual(2);
        for (const pick of [candidates[0]!, candidates[candidates.length - 1]!]) {
          const row = result.yield_by_epoch.find((y) => y.epoch_index === pick.epochIndex);
          expect(row, `yield row for epoch ${pick.epochIndex}`).toBeDefined();
          expect(row!.personal_apr_bps, `epoch ${pick.epochIndex} personal apr`).toBe(pick.bps);
        }

        // (c) effective_apr_bps exists once a step settled after the deposit,
        // and its sign matches the independently computed gain (when nonzero
        // beyond the dust bound (flooring can flip the sign of a near-zero).
        expect(result.effective_apr_bps, "effective apr present").not.toBeNull();
        const gain = stepGainSum(txs, epochs, firstDepSec);
        const dust = BigInt(txs.length + epochs.length);
        if (gain > dust) expect(result.effective_apr_bps! > 0, "positive gain → +apr").toBe(true);
        else if (gain < -dust) expect(result.effective_apr_bps! < 0, "negative gain → -apr").toBe(true);
      });

      it("holds over 3 seeded random prefixes", () => {
        const rng = makeRng(trace.seed);
        for (let n = 0; n < 3; n += 1) {
          const len = 1 + Math.floor(rng() * txs.length);
          const prefix = txs.slice(0, len);
          const result = derivePortfolioMetrics(POOLED, prefix, epochs);
          assertHealthy(result, prefix, epochs, `prefix[${len}]`);
        }
      });

      it("refunds leave realized gain unchanged across the refund event", () => {
        const refundIdx = trace.events
          .map((e, i) => (e.kind === "redemption_refund" ? i : -1))
          .filter((i) => i >= 0);
        for (const idx of refundIdx) {
          const before = derivePortfolioMetrics(POOLED, txs.slice(0, idx), epochs);
          const after = derivePortfolioMetrics(POOLED, txs.slice(0, idx + 1), epochs);
          expect(after.realized_gain_nhash, `refund at seq ${idx}`).toBe(before.realized_gain_nhash);
        }
      });

      it("final escrow reconciles with pending requests and the manifest stats", () => {
        const result = derivePortfolioMetrics(POOLED, txs, epochs);
        let sor = 0n;
        let pay = 0n;
        let ref = 0n;
        const counts = { swap_in: 0, swap_out_request: 0, redemption_payout: 0, redemption_refund: 0 };
        for (const ev of trace.events) {
          if (ev.kind === "swap_out_request") sor += BigInt(ev.shares);
          else if (ev.kind === "redemption_payout") pay += BigInt(ev.shares);
          else if (ev.kind === "redemption_refund") ref += BigInt(ev.shares);
          if (ev.kind in counts) counts[ev.kind as keyof typeof counts] += 1;
        }
        // Escrow = requests − payouts − refunds, by shares (exact; no floor).
        expect(BigInt(result.escrowed_share_balance)).toBe(sor - pay - ref);
        expect(sor - pay - ref >= 0n, "pending shares non-negative").toBe(true);
        // Cross-check the trace against the manifest counts (same fact).
        expect(counts.swap_in).toBe(entry.stats.deposits);
        expect(counts.swap_out_request).toBe(entry.stats.swap_out_request);
        expect(counts.redemption_payout).toBe(entry.stats.redemption_payout);
        expect(counts.redemption_refund).toBe(entry.stats.redemption_refund);
      });
    });
  }
});
