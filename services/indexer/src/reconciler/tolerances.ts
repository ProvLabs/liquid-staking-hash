// Per-metric reconciliation tolerances (app-spec §9.5.6 / §12.1). These live in
// CODE, reviewed like the schema allowlist — deliberately NOT env-tunable: a
// tolerance is a correctness contract, and letting an operator widen it would
// let them silence the honesty alarm, which §12.1.3 forbids ("enforced by
// machinery, not review").
//
// The reconciler compares the chain's retained latest epoch snapshot against
// the indexer's stored copy of that same epoch. Those values are COPIED from
// chain, so the faithful-copy tolerance is exact (0): any nonzero delta is an
// indexing defect, not drift. The lag threshold bounds how far a worker stream
// may trail the head before DATA DEGRADED (indexer_lag) opens.

export interface Tolerances {
  /** max |indexed − chain| total-shares delta before divergence (exact copy). */
  readonly totalShares: bigint;
  /** max |indexed − chain| TVV delta before divergence (exact copy). */
  readonly tvvAfter: bigint;
  /** max heights a stream may trail the head before indexer_lag opens. */
  readonly lagHeights: bigint;
}

export const TOLERANCES: Tolerances = {
  totalShares: 0n,
  tvvAfter: 0n,
  // ~5 s blocks; 120 heights ≈ 10 min of trailing before DATA DEGRADED.
  lagHeights: 120n,
};
