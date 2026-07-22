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
  ProgramMetrics,
  ValidatorsPayload,
} from "@nvhash/api-types";
import type { Heads } from "./derive.ts";
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
};
