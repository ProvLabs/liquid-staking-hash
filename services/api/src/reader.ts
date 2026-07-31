// The reader port: the ONLY seam through which route handlers see indexed
// data (the abstract-Store pattern the indexer's reducer
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
// This split keeps `pnpm -r run test` Postgres-free while the
// Postgres-backed integration gate exercises the real queries.

import type {
  AlertArrearsFact,
  AlertIncidentFact,
  AlertRedemptionFact,
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
  type EpochBoundary,
  type Heads,
  type OperatorEpochFacts,
  type OperatorPaymentFacts,
  type OperatorPaymentTotalFacts,
  type OperatorRegistryFacts,
  type GovPolicyFacts,
  type GovProposalFacts,
  type GovVoteFacts,
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
   * `{ sample: null, bridged_supply: [] }` while the sampler is
   * parked — the v1 "coming soon" state (app-spec §13 decision 4).
   */
  latestMarket(): Promise<MarketSummary>;
  /**
   * Program-wide typical time-to-payout (app-spec §9.5.3, §14.12).
   * Public + aggregate over the recent terminal-request cohort — no owner
   * keying, so no PII. Honest-empty (`sample_count: 0`, null stats,
   * `cold_start: true`) until data + a completed epoch exist.
   */
  payoutStats(): Promise<PayoutStats>;
  /**
   * Address-scoped reads. Callers reach these ONLY through routes
   * whose registry `auth: "address"` requirement passed the in-process
   * scope↔target check (ADR-001 Decision 2) — the reader itself has no
   * authorization role; the address arrives already authorized.
   */
  portfolioFor(address: string): Promise<PortfolioSummary>;
  /** Per-event history for the address, newest first, paginated. */
  transactionsFor(address: string, page: Pagination): Promise<TransactionRow[]>;
  /**
   * The address's COMPLETE history ascending by `(height, msgIndex)` as an
   * array — `derivePortfolioMetrics` folds over the whole thing, so this one
   * caller genuinely needs it materialized. Backed by the keyset stream below.
   */
  transactionsAscFor(address: string): Promise<TransactionFacts[]>;
  /** The same history as a keyset-paged stream — the §14.11 holder CSV's
   * source, so the export never materializes an unbounded history. */
  transactionsAscStream(address: string): AsyncIterable<readonly TransactionFacts[]>;
  /** All epoch snapshots ascending by epochIndex, as the fold's step facts. */
  listEpochsAsc(): Promise<EpochStepFact[]>;
  /**
   * Internal alert-facts reads (`internal:notifier` scope; ADR-001
   * Decision 3). Cross-address by nature — the notifier evaluates rules over
   * every present address — so they carry no `address:` scope and never touch
   * a personal endpoint. All three are bounded (a cursor + a page limit, or a
   * single latest-epoch snapshot); the cursor is efficiency, the notifier's
   * unique constraint is correctness.
   */
  redemptionsChangedSince(
    sinceHeight: number,
    afterId: string,
    limit: number,
  ): Promise<AlertRedemptionFact[]>;
  incidentsSince(sinceId: number, limit: number): Promise<AlertIncidentFact[]>;
  /** Validators with commission due in the latest sampled epoch (active only). */
  latestArrears(): Promise<AlertArrearsFact[]>;
  /**
   * Operator-surface reads. Like the other address-scoped reads these
   * carry no authorization role — the address arrives already authorized by the
   * registry's `auth: "address"` declaration. What they DO carry is the
   * ownership mapping: `operatorValopers` is the only source of the valopers an
   * address may see, and every other operator read is called with a valoper
   * that came from it (enforced in the handlers via `resolveOwnedValoper`).
   */
  operatorValopers(address: string): Promise<OperatorRegistryFacts[]>;
  /** Latest sampled epoch per valoper (full economics, not the public subset). */
  latestOperatorEpochs(valopers: readonly string[]): Promise<OperatorEpochFacts[]>;
  /** One validator's epoch history, newest first, paginated. */
  validatorEpochsFor(valoper: string, page: Pagination): Promise<OperatorEpochFacts[]>;
  /** Lifetime commission/TIP sums + row count per valoper (`operator_payments`). */
  operatorPaymentTotalsFor(valopers: readonly string[]): Promise<OperatorPaymentTotalFacts[]>;
  /** One validator's payment history, newest first, paginated (the JSON view). */
  operatorPaymentsFor(valoper: string, page: Pagination): Promise<OperatorPaymentFacts[]>;
  /**
   * One validator's COMPLETE payment history ascending by (height, msgIndex),
   * yielded in bounded chunks — the §14.11 CSV export's source. Pagination
   * bounds the JSON view only; a statement of fact is never a paginated slice
   * (the 6.1 completeness precedent).
   *
   * It is a STREAM, not an array, and it walks by keyset with a SQL ROW
   * COMPARISON, for two measured reasons (2026-07-28 review, at 300 000
   * payments on one valoper):
   *   - an `OFFSET`-chunked walk re-scans and discards every prior row, so the
   *     export cost is quadratic — the whole export took 14.8 s. So does
   *     Prisma's two-arm `OR` cursor, which Postgres cannot push into an index
   *     condition (it becomes a post-scan Filter). Only the row comparison
   *     `("height","msgIndex") > (?,?)`, against the composite index, is flat:
   *     ~42 buffers / 0.2 ms per chunk at ANY depth. See reader-prisma.ts.
   *   - materializing the history cost 323 MB RSS per concurrent request, on a
   *     table fed by a PERMISSIONLESS write path (anyone may PayTip for any
   *     validator), so its row count is bounded by nobody.
   * `operator_payments` is append-only, so a keyset walk cannot skip a row.
   */
  operatorPaymentsAscStream(valoper: string): AsyncIterable<readonly OperatorPaymentFacts[]>;
  /** Epoch closing heights ascending — how a payment's epoch is derived. */
  epochBoundariesAsc(): Promise<EpochBoundary[]>;
  /**
   * Governance reads. PUBLIC: proposals and votes are public chain facts
   * with no address keying, so these carry no scope and create no
   * `PERSONAL_PATHS` entry.
   *
   * The API serves the durable MIRROR only — it has no chain client by design
   * (D12/D16), so the live policy set, current membership and live tallies are
   * web-tier reads at 7.2. That is the `/market` and `/portfolio` division, and it
   * is why `listGovProposals` reports `indexedFromHeight` alongside the rows: a
   * proposal pruned before the indexer existed is unrecoverable, and the page must
   * never imply a completeness it lacks.
   */
  listGovProposals(
    page: Pagination,
    filter: { policy?: string; status?: string },
  ): Promise<{ proposals: GovProposalFacts[]; indexedFromHeight: number | null }>;
  /** One proposal with its votes, or null when the mirror has never seen the id. */
  govProposal(
    proposalId: bigint,
  ): Promise<{ proposal: GovProposalFacts; votes: GovVoteFacts[] } | null>;
  /** The HISTORICAL policy set observed in the mirror, newest activity first. */
  listGovPolicies(): Promise<GovPolicyFacts[]>;
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
  // An unwired process has no rows, so the stream yields nothing at all.
  async *transactionsAscStream() {},
  listEpochsAsc: () => Promise.resolve([]),
  redemptionsChangedSince: () => Promise.resolve([]),
  incidentsSince: () => Promise.resolve([]),
  latestArrears: () => Promise.resolve([]),
  // An unwired process knows of no validators, so it operates none: every
  // operator read is empty. Same honest-empty state a real address that
  // operates nothing gets — the surface never distinguishes the two.
  operatorValopers: () => Promise.resolve([]),
  latestOperatorEpochs: () => Promise.resolve([]),
  validatorEpochsFor: () => Promise.resolve([]),
  operatorPaymentTotalsFor: () => Promise.resolve([]),
  operatorPaymentsFor: () => Promise.resolve([]),
  // An unwired process has no rows, so the stream yields nothing at all.
  async *operatorPaymentsAscStream() {},
  epochBoundariesAsc: () => Promise.resolve([]),
  // A dataless process has mirrored no governance. `indexedFromHeight: null` is
  // the honest "no height certifies this list" state — never 0, which would claim
  // the mirror starts at genesis and is simply empty.
  listGovProposals: () => Promise.resolve({ proposals: [], indexedFromHeight: null }),
  // Null, not a fabricated row: "the mirror has never seen this id" and "the id
  // exists but is empty" are different answers.
  govProposal: () => Promise.resolve(null),
  listGovPolicies: () => Promise.resolve([]),
};
