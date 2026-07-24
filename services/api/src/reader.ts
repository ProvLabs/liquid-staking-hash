// The reader port: the ONLY seam through which route handlers see indexed
// data (app plan PR 3.1; the abstract-Store pattern the indexer's reducer
// established). Two implementations exist:
//
//   - reader-prisma.ts — @nvhash/db-indexed over the SELECT-only `api_reader`
//     role (ADR-001 Decision 1). Constructed only when DATABASE_URL is
//     configured; imported dynamically by main() so the DB-free test suite
//     never loads the generated client.
//   - test doubles — `emptyReader` below (the default when no database is
//     wired: every route reports the honest empty/null state, exactly the
//     scaffold behavior), and the populated in-memory fake in
//     test/reader-fake.ts.
//
// This split keeps `pnpm -r run test` Postgres-free (plan §4) while the
// Postgres-backed integration gate exercises the real queries.

import type {
  EpochRow,
  IncidentRow,
  MarketSummary,
  PayoutStats,
  PortfolioSummary,
  ProgramMetrics,
  TransactionRow,
  ValidatorsPayload,
} from "@nvhash/api-types";
import {
  REDEMPTION_BAND_CEILING_SECONDS,
  REDEMPTION_BAND_FLOOR_SECONDS,
  type Heads,
  type TransactionFacts,
} from "./derive.ts";
import type { EpochStepFact } from "./portfolio-metrics.ts";
import type { Pagination } from "./query.ts";

export type { Heads } from "./derive.ts";

/** Reads the M3.1/3.2 public program endpoints need. 3.3 extends this. */
export interface IndexedReader {
  /** Envelope heights (latest reconciler run; checkpoint fallback; nulls). */
  heads(): Promise<Heads>;
  programMetrics(): Promise<ProgramMetrics>;
  /** Newest first, bounded by the shared pagination schema. */
  listEpochs(page: Pagination): Promise<EpochRow[]>;
  /** Newest first, bounded by the shared pagination schema. */
  listIncidents(page: Pagination): Promise<IncidentRow[]>;
  listValidators(): Promise<ValidatorsPayload>;
  /**
   * Latest pool sample (premium computed against the NAV current at the
   * sample's time, [R6]) + latest bridged supply per chain. Honest-empty
   * `{ sample: null, bridged_supply: [] }` while the sampler (PR 2.4) is
   * parked — the v1 "coming soon" state (app-spec §13 decision 4).
   */
  latestMarket(): Promise<MarketSummary>;
  /**
   * Program-wide typical time-to-payout (PR 5.4; app-spec §9.5.3, §14.12).
   * Public + aggregate over the recent terminal-request cohort — no owner
   * keying, so no PII. Honest-empty (`sample_count: 0`, null stats,
   * `cold_start: true`) until data + a completed epoch exist.
   */
  payoutStats(): Promise<PayoutStats>;
  /**
   * Address-scoped reads (PR 3.3). Callers reach these ONLY through routes
   * whose registry `auth: "address"` requirement passed the in-process
   * scope↔target check (ADR-001 Decision 2) — the reader itself has no
   * authorization role; the address arrives already authorized.
   */
  portfolioFor(address: string): Promise<PortfolioSummary>;
  /** Per-event history for the address, newest first, paginated. */
  transactionsFor(address: string, page: Pagination): Promise<TransactionRow[]>;
  /**
   * The address's FULL event history ascending (height asc, msgIndex asc) as
   * fold facts (M6.1). Chunked internally so no single query is unbounded; the
   * derived-metrics fold and the CSV export both replay the complete history.
   */
  transactionsAscFor(address: string): Promise<TransactionFacts[]>;
  /** All epoch snapshots ascending by epochIndex, as the fold's step facts. */
  listEpochsAsc(): Promise<EpochStepFact[]>;
}

/**
 * The honest empty reader — the default when no data plane is configured.
 * Null heights and empty collections are the §12.1 "not certified fresh"
 * state; nothing here fabricates a height, a count, or a row.
 */
export const emptyReader: IndexedReader = {
  heads: () => Promise.resolve({ chainHeight: null, indexedHeight: null }),
  programMetrics: () =>
    Promise.resolve({ participant_count: null, program_started_at: null, epoch_count: null }),
  listEpochs: () => Promise.resolve([]),
  listIncidents: () => Promise.resolve([]),
  listValidators: () =>
    Promise.resolve({
      validators: [],
      set_health: { total: 0, active: 0, eligible: 0, in_arrears: 0 },
    }),
  latestMarket: () => Promise.resolve({ sample: null, bridged_supply: [] }),
  payoutStats: () =>
    Promise.resolve({
      sample_count: 0,
      median_seconds: null,
      p90_seconds: null,
      band_floor_seconds: REDEMPTION_BAND_FLOOR_SECONDS,
      band_ceiling_seconds: REDEMPTION_BAND_CEILING_SECONDS,
      cold_start: true,
    }),
  portfolioFor: (address) =>
    Promise.resolve({
      address,
      first_activity_at: null,
      transaction_count: 0,
      escrowed_shares: "0",
      active_redemptions: [],
    }),
  transactionsFor: () => Promise.resolve([]),
  transactionsAscFor: () => Promise.resolve([]),
  listEpochsAsc: () => Promise.resolve([]),
};
