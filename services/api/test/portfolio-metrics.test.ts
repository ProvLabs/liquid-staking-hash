// Unit: the derived-metrics fold. Hand-computed BigInt goldens pin the
// average-cost basis (§14.11), realized gain, effective yield (§14.12), and the
// accrual series. The corpus NAV pair (tvv=315397882283, shares=
// 309963777029000000 -> 1.0175) also pins these against the shared helper.

import { describe, expect, it } from "vitest";
import type { TransactionFacts } from "../src/derive.ts";
import {
  derivePortfolioMetrics,
  MARKER_CAP,
  MAX_ACCRUAL_POINTS,
  MAX_YIELD_POINTS,
  type EpochStepFact,
} from "../src/portfolio-metrics.ts";

const ADDR = "pb1walletaqq";

// Corpus golden pair (see derive.test.ts / amounts.test.ts).
const CORPUS_TVV = 315397882283n; // NAV 1.0175 at CORPUS_SHARES
const CORPUS_SHARES = 309963777029000000n;
const UNIT_TVV = 309963777029n; // NAV 1.0000 at CORPUS_SHARES

const T0 = 1_767_139_200n; // 2025-12-31 deposit
const T1 = 1_767_225_600n; // 2026-01-01 epoch p
const T2 = 1_767_830_400n; // 2026-01-08 epoch e (one week later)

function tx(over: Partial<TransactionFacts> & Pick<TransactionFacts, "kind">): TransactionFacts {
  return {
    txhash: "TX",
    msgIndex: 0,
    address: ADDR,
    shares: 0n,
    nhash: 0n,
    navAtHeight: 0n,
    height: 100n,
    blockTime: new Date(Number(T0) * 1000),
    ...over,
  };
}

function epoch(over: Partial<EpochStepFact> & Pick<EpochStepFact, "epochIndex">): EpochStepFact {
  return {
    endedAtSeconds: T1,
    tvvAfter: UNIT_TVV,
    totalShares: CORPUS_SHARES,
    netAprBps: null,
    endHeight: 200n,
    ...over,
  };
}

describe("derivePortfolioMetrics: empty history", () => {
  it("is complete with zeroed figures and empty series", () => {
    expect(derivePortfolioMetrics(ADDR, [], [])).toEqual({
      address: ADDR,
      history_state: "complete",
      indexed_share_balance: "0",
      escrowed_share_balance: "0",
      cost_basis_nhash: "0",
      escrowed_basis_nhash: "0",
      realized_gain_nhash: "0",
      effective_apr_bps: null,
      yield_by_epoch: [],
      yield_truncated: false,
      accrual: [],
      accrual_truncated: false,
      accrual_markers: [],
      markers_truncated: false,
    });
  });
});

describe("derivePortfolioMetrics: single deposit then two rising-NAV epochs", () => {
  const txs = [
    tx({ kind: "swap_in", txhash: "DEP", shares: CORPUS_SHARES, nhash: UNIT_TVV, height: 100n, blockTime: new Date(Number(T0) * 1000) }),
  ];
  const epochs = [
    epoch({ epochIndex: 1n, endedAtSeconds: T1, tvvAfter: UNIT_TVV, totalShares: CORPUS_SHARES, netAprBps: 400, endHeight: 200n }),
    epoch({ epochIndex: 2n, endedAtSeconds: T2, tvvAfter: CORPUS_TVV, totalShares: CORPUS_SHARES, netAprBps: 431, endHeight: 300n }),
  ];
  const m = derivePortfolioMetrics(ADDR, txs, epochs);

  it("carries the held pool and its average-cost basis", () => {
    expect(m.history_state).toBe("complete");
    expect(m.indexed_share_balance).toBe(CORPUS_SHARES.toString());
    expect(m.escrowed_share_balance).toBe("0");
    expect(m.cost_basis_nhash).toBe(UNIT_TVV.toString());
    expect(m.escrowed_basis_nhash).toBe("0");
    expect(m.realized_gain_nhash).toBe("0");
  });

  it("computes exact per-epoch and overall effective APR", () => {
    // gain_e = 315397882283 - 309963777029 = 5434105254
    // personal = floor(5434105254 * 10000 * 31536000 / (309963777029 * 604800))
    expect(m.yield_by_epoch).toEqual([
      { epoch_index: 1, ended_at: "2026-01-01T00:00:00.000Z", personal_apr_bps: null, net_apr_bps: 400 },
      { epoch_index: 2, ended_at: "2026-01-08T00:00:00.000Z", personal_apr_bps: 9141, net_apr_bps: 431 },
    ]);
    expect(m.effective_apr_bps).toBe(9141);
  });

  it("prices the accrual series at each NAV-bearing epoch", () => {
    expect(m.accrual).toEqual([
      { time: "2026-01-01T00:00:00.000Z", height: 200, value_nhash: UNIT_TVV.toString() },
      { time: "2026-01-08T00:00:00.000Z", height: 300, value_nhash: CORPUS_TVV.toString() },
    ]);
  });

  it("marks the deposit event", () => {
    expect(m.accrual_markers).toEqual([
      { time: "2025-12-31T00:00:00.000Z", txhash: "DEP", kind: "swap_in", shares: CORPUS_SHARES.toString(), nhash: UNIT_TVV.toString() },
    ]);
    expect(m.markers_truncated).toBe(false);
  });
});

describe("derivePortfolioMetrics: partial redemption paid above basis", () => {
  const txs = [
    tx({ kind: "swap_in", txhash: "A", shares: 1000n, nhash: 1000n, height: 1n }),
    tx({ kind: "swap_out_request", txhash: "B", shares: 400n, height: 2n }),
    tx({ kind: "redemption_payout", txhash: "C", shares: 400n, nhash: 500n, height: 3n }),
  ];
  const m = derivePortfolioMetrics(ADDR, txs, []);

  it("moves escrow proportionally with floor and realizes the exact excess", () => {
    // moved = floor(1000 * 400 / 1000) = 400; removed = floor(400*400/400)=400
    expect(m.indexed_share_balance).toBe("600");
    expect(m.escrowed_share_balance).toBe("0");
    expect(m.cost_basis_nhash).toBe("600");
    expect(m.escrowed_basis_nhash).toBe("0");
    expect(m.realized_gain_nhash).toBe("100"); // 500 payout - 400 basis
    expect(m.history_state).toBe("complete");
  });

  it("annotates every event", () => {
    expect(m.accrual_markers.map((k) => [k.kind, k.shares, k.nhash])).toEqual([
      ["swap_in", "1000", "1000"],
      ["swap_out_request", "400", "0"],
      ["redemption_payout", "400", "500"],
    ]);
  });
});

describe("derivePortfolioMetrics: refund reverses the request", () => {
  const txs = [
    tx({ kind: "swap_in", txhash: "A", shares: 1000n, nhash: 1000n, height: 1n }),
    tx({ kind: "swap_out_request", txhash: "B", shares: 400n, height: 2n }),
    tx({ kind: "redemption_refund", txhash: "C", shares: 400n, nhash: 0n, height: 3n }),
  ];
  const m = derivePortfolioMetrics(ADDR, txs, []);

  it("returns pools exactly and realizes nothing", () => {
    expect(m.indexed_share_balance).toBe("1000");
    expect(m.escrowed_share_balance).toBe("0");
    expect(m.cost_basis_nhash).toBe("1000");
    expect(m.escrowed_basis_nhash).toBe("0");
    expect(m.realized_gain_nhash).toBe("0");
    expect(m.history_state).toBe("complete");
  });
});

describe("derivePortfolioMetrics: transfers", () => {
  it("flags has_transfers while leaving pool math untouched", () => {
    const txs = [
      tx({ kind: "swap_in", txhash: "A", shares: 1000n, nhash: 1000n, height: 1n }),
      tx({ kind: "transfer_in", txhash: "B", shares: 50n, height: 2n }),
    ];
    const m = derivePortfolioMetrics(ADDR, txs, []);
    expect(m.history_state).toBe("has_transfers");
    expect(m.indexed_share_balance).toBe("1000");
    expect(m.cost_basis_nhash).toBe("1000");
    expect(m.accrual_markers).toHaveLength(2);
  });
});

describe("derivePortfolioMetrics: payout against an empty escrow", () => {
  it("is inconsistent: balances hold the last consistent state, figures null", () => {
    const txs = [
      tx({ kind: "swap_in", txhash: "A", shares: 1000n, nhash: 1000n, height: 1n }),
      tx({ kind: "redemption_payout", txhash: "C", shares: 100n, nhash: 100n, height: 2n }),
    ];
    const m = derivePortfolioMetrics(ADDR, txs, []);
    expect(m.history_state).toBe("inconsistent");
    expect(m.indexed_share_balance).toBe("1000");
    expect(m.escrowed_share_balance).toBe("0");
    expect(m.cost_basis_nhash).toBeNull();
    expect(m.escrowed_basis_nhash).toBeNull();
    expect(m.realized_gain_nhash).toBeNull();
    expect(m.effective_apr_bps).toBeNull();
    expect(m.yield_by_epoch).toEqual([]);
    expect(m.accrual).toEqual([]);
    expect(m.accrual_truncated).toBe(false);
    expect(m.accrual_markers).toEqual([]);
    expect(m.markers_truncated).toBe(false);
  });
});

describe("derivePortfolioMetrics: a slashing epoch", () => {
  it("reports a signed negative gain and personal APR", () => {
    const txs = [
      tx({ kind: "swap_in", txhash: "DEP", shares: CORPUS_SHARES, nhash: UNIT_TVV, height: 100n, blockTime: new Date(Number(T0) * 1000) }),
    ];
    const epochs = [
      epoch({ epochIndex: 1n, endedAtSeconds: T1, tvvAfter: UNIT_TVV, totalShares: CORPUS_SHARES, netAprBps: 400, endHeight: 200n }),
      epoch({ epochIndex: 2n, endedAtSeconds: T2, tvvAfter: 300000000000n, totalShares: CORPUS_SHARES, netAprBps: -1200, endHeight: 300n }),
    ];
    const m = derivePortfolioMetrics(ADDR, txs, epochs);
    // gain_e = 300000000000 - 309963777029 = -9963777029
    expect(m.yield_by_epoch[1]).toEqual({
      epoch_index: 2,
      ended_at: "2026-01-08T00:00:00.000Z",
      personal_apr_bps: -16761, // BigInt division truncates toward zero
      net_apr_bps: -1200,
    });
    expect(m.accrual[1]).toEqual({ time: "2026-01-08T00:00:00.000Z", height: 300, value_nhash: "300000000000" });
    expect(m.effective_apr_bps).toBe(-16761);
  });
});

describe("derivePortfolioMetrics: multi-segment TWAB (deposit between epochs)", () => {
  // Small synthetic economy (totalShares T = 1000 for every epoch) so the
  // TWAB integral has three sub-intervals with two distinct share counts, and
  // the arithmetic is hand-checkable. NAV steps: e1 tvv=1000, e2 tvv=1100,
  // e3 tvv=1200; value_at(S, e) = floor(S * tvv / 1000).
  //   times (s): e1=0, D1=100, e2=200, D2=300, e3=400
  //   firstDeposit=100, lastStep=400
  // gain_total = [v(100,e2)-v(100,e1)] + [v(200,e3)-v(200,e2)]
  //            = (110-100) + (240-220) = 10 + 20 = 30
  // denom = v(100,e1)*100 + v(100,e2)*100 + v(200,e2)*100
  //       = 100*100 + 110*100 + 220*100 = 43000
  // effective = floor(30 * 10000 * 31536000 / 43000) = 220018604
  // e3 personal = floor(20 * 10000 * 31536000 / (220 * 200)) = 143345454
  const T = 1000n;
  const at = (s: number): Date => new Date(s * 1000);
  const txs = [
    tx({ kind: "swap_in", txhash: "D1", shares: 100n, nhash: 100n, height: 2n, blockTime: at(100) }),
    tx({ kind: "swap_in", txhash: "D2", shares: 100n, nhash: 110n, height: 4n, blockTime: at(300) }),
  ];
  const epochs: EpochStepFact[] = [
    { epochIndex: 1n, endedAtSeconds: 0n, tvvAfter: 1000n, totalShares: T, netAprBps: null, endHeight: 1n },
    { epochIndex: 2n, endedAtSeconds: 200n, tvvAfter: 1100n, totalShares: T, netAprBps: 500, endHeight: 3n },
    { epochIndex: 3n, endedAtSeconds: 400n, tvvAfter: 1200n, totalShares: T, netAprBps: 600, endHeight: 5n },
  ];
  const m = derivePortfolioMetrics(ADDR, txs, epochs);

  it("accumulates the TWAB across segments with differing share counts", () => {
    expect(m.effective_apr_bps).toBe(220018604);
  });

  it("prices per-epoch personal APR against the right predecessor", () => {
    expect(m.yield_by_epoch).toEqual([
      // e2 predecessor (e1) predates the first deposit -> personal null
      { epoch_index: 2, ended_at: "1970-01-01T00:03:20.000Z", personal_apr_bps: null, net_apr_bps: 500 },
      { epoch_index: 3, ended_at: "1970-01-01T00:06:40.000Z", personal_apr_bps: 143345454, net_apr_bps: 600 },
    ]);
  });
});

describe("derivePortfolioMetrics: negative swap_in", () => {
  it("flags a negative-amount deposit as inconsistent (boundary guard)", () => {
    const m = derivePortfolioMetrics(ADDR, [tx({ kind: "swap_in", txhash: "BAD", shares: -100n, nhash: 0n, height: 1n })], []);
    expect(m.history_state).toBe("inconsistent");
    expect(m.indexed_share_balance).toBe("0");
    expect(m.cost_basis_nhash).toBeNull();
    expect(m.realized_gain_nhash).toBeNull();
  });

  it("flags a negative nhash leg as inconsistent", () => {
    const m = derivePortfolioMetrics(ADDR, [tx({ kind: "swap_in", txhash: "BAD", shares: 100n, nhash: -1n, height: 1n })], []);
    expect(m.history_state).toBe("inconsistent");
  });
});

describe("derivePortfolioMetrics: marker cap", () => {
  it("keeps the most recent MARKER_CAP events and flags truncation", () => {
    const txs: TransactionFacts[] = [];
    for (let i = 0; i < MARKER_CAP + 1; i += 1) {
      txs.push(tx({ kind: "swap_in", txhash: `T${i}`, shares: 1n, nhash: 1n, height: BigInt(i + 1) }));
    }
    const m = derivePortfolioMetrics(ADDR, txs, []);
    expect(m.accrual_markers).toHaveLength(MARKER_CAP);
    expect(m.markers_truncated).toBe(true);
    // most-recent window: the first kept marker is the second event (T1).
    expect(m.accrual_markers[0]?.txhash).toBe("T1");
    expect(m.accrual_markers[MARKER_CAP - 1]?.txhash).toBe(`T${MARKER_CAP}`);
  });
});

describe("derivePortfolioMetrics: accrual cap", () => {
  // One deposit at second 1, then N bearing epochs (each pushes one accrual
  // point priced at its NAV). endHeight = epochIndex so a kept point is
  // identifiable by height.
  const withEpochs = (n: number) => {
    const txs = [tx({ kind: "swap_in", txhash: "DEP", shares: 1000n, nhash: 1000n, height: 1n, blockTime: new Date(1000) })];
    const epochs: EpochStepFact[] = [];
    for (let i = 0; i < n; i += 1) {
      epochs.push({
        epochIndex: BigInt(i + 1),
        endedAtSeconds: BigInt(i + 2),
        tvvAfter: 1000n,
        totalShares: 1000n,
        netAprBps: null,
        endHeight: BigInt(i + 1),
      });
    }
    return derivePortfolioMetrics(ADDR, txs, epochs);
  };

  it("keeps the most recent MAX_ACCRUAL_POINTS and flags truncation past the cap", () => {
    const m = withEpochs(MAX_ACCRUAL_POINTS + 1);
    expect(m.accrual).toHaveLength(MAX_ACCRUAL_POINTS);
    expect(m.accrual_truncated).toBe(true);
    // 2001 points sliced to the most recent 2000: the first kept point is the
    // second epoch (endHeight 2), the earliest was dropped.
    expect(m.accrual[0]?.height).toBe(2);
    expect(m.accrual[MAX_ACCRUAL_POINTS - 1]?.height).toBe(MAX_ACCRUAL_POINTS + 1);
  });

  it("keeps the full series and flags false at the cap", () => {
    const m = withEpochs(MAX_ACCRUAL_POINTS);
    expect(m.accrual).toHaveLength(MAX_ACCRUAL_POINTS);
    expect(m.accrual_truncated).toBe(false);
    expect(m.accrual[0]?.height).toBe(1);
  });

  // yield_by_epoch gets one entry per epoch step at/after the first deposit
  // (the first has a null personal figure), so N epochs yield N entries.
  it("keeps the most recent MAX_YIELD_POINTS yield entries and flags truncation", () => {
    const m = withEpochs(MAX_YIELD_POINTS + 2);
    expect(m.yield_by_epoch).toHaveLength(MAX_YIELD_POINTS);
    expect(m.yield_truncated).toBe(true);
    // 2002 entries (epochs 1..2002) sliced to the most recent 2000: 1 and 2 dropped.
    expect(m.yield_by_epoch[0]?.epoch_index).toBe(3);
    expect(m.yield_by_epoch[MAX_YIELD_POINTS - 1]?.epoch_index).toBe(MAX_YIELD_POINTS + 2);
  });

  it("keeps the full yield series and flags false at the cap", () => {
    const m = withEpochs(MAX_YIELD_POINTS);
    expect(m.yield_by_epoch).toHaveLength(MAX_YIELD_POINTS);
    expect(m.yield_truncated).toBe(false);
    expect(m.yield_by_epoch[0]?.epoch_index).toBe(1);
  });
});
