// Pure derivations: indexed facts → the frozen @nvhash/api-types shapes.
//
// The same pattern as the indexer's reducer (pure fold, thin store): every
// mapping from database rows to API rows lives here as a pure function over
// structural fact types (bigint/Date — no Prisma imports), so the whole
// derivation layer is unit-testable without Postgres, and the Prisma reader
// (reader-prisma.ts) stays a thin query-and-convert shell.
//
// Amount discipline (app-spec §5.8): base-unit amounts arrive as bigint and
// leave as decimal strings; NAV uses the shared scale-then-floor helper
// ([R1], docs/plans/2026-07-22-app-m3-query-api.md). Heights and counts are
// JS safe integers, guarded loudly ([R7a]): a height that cannot be a safe
// integer is corrupt, and serializing it would ship a lie — throw instead.

import {
  navHashPerShare,
  SHARE_EXPONENT,
  type BridgedSupplyRow,
  type EpochRow,
  type IncidentKind,
  type IncidentRow,
  type IncidentSeverity,
  type MarketDepthBand,
  type MarketSample,
  type PayoutStats,
  type PortfolioSummary,
  type ProgramMetrics,
  type RedemptionRow,
  type RedemptionStatus,
  type TransactionKind,
  type TransactionRow,
  type ValidatorRow,
  type ValidatorSetHealth,
  type ValidatorsPayload,
} from "@nvhash/api-types";
import { z } from "zod";

/** Envelope heights as the reader reports them (null = honestly unknown). */
export interface Heads {
  readonly chainHeight: number | null;
  readonly indexedHeight: number | null;
}

// --- guards -----------------------------------------------------------------

/**
 * bigint → non-negative safe integer, or a loud RangeError ([R7a]). Applied
 * to every height/index/count crossing into the JSON number domain, so a
 * corrupt value fails the request instead of reaching a consumer.
 */
export function toSafeInt(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} must be a non-negative safe integer, got ${value}`);
  }
  return Number(value);
}

/** Signed variant for measures that may legitimately be negative (bps). */
export function toSafeSignedInt(value: bigint, label: string): number {
  const abs = value < 0n ? -value : value;
  if (abs > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} must be a safe integer, got ${value}`);
  }
  return Number(value);
}

// --- fact shapes (structural; satisfied by converted Prisma rows) -----------

export interface EpochSnapshotFacts {
  readonly epochIndex: bigint;
  readonly endedAtSeconds: bigint;
  readonly tvvAfter: bigint;
  readonly totalShares: bigint;
  readonly netAprBps: number;
  /** Snapshot end height; only the M6.1 step-fact mapping consumes it. */
  readonly endHeight?: bigint;
}

export interface IncidentFacts {
  readonly kind: IncidentKind;
  readonly severity: IncidentSeverity;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly openedHeight: bigint | null;
}

export interface ValidatorRegistryFacts {
  readonly valoper: string;
  readonly moniker: string;
  readonly unregisteredAt: Date | null;
}

export interface ValidatorEpochFacts {
  readonly valoper: string;
  readonly epochIndex: bigint;
  readonly uptimeBps: number;
  readonly eligible: boolean;
  readonly failingReasons: readonly string[];
  readonly programDelegation: bigint;
  readonly commissionDue: bigint;
}

export interface MetricsFacts {
  /** Has any (non-`meta:`) worker stream committed a window yet? */
  readonly indexed: boolean;
  readonly participantCount: number;
  readonly firstActivityAt: Date | null;
  readonly epochCount: number;
}

// --- derivations ------------------------------------------------------------

export function deriveHeads(
  reconcilerRun: { readonly chainHeight: bigint; readonly indexedHeight: bigint } | null,
  maxCheckpointHeight: bigint | null,
): Heads {
  if (reconcilerRun !== null) {
    return {
      chainHeight: toSafeInt(reconcilerRun.chainHeight, "chain_height"),
      indexedHeight: toSafeInt(reconcilerRun.indexedHeight, "indexed_height"),
    };
  }
  // The reconciler has never run: the checkpoints certify indexed progress,
  // but nothing in the store knows the chain head — report null, never guess.
  if (maxCheckpointHeight !== null) {
    return { chainHeight: null, indexedHeight: toSafeInt(maxCheckpointHeight, "indexed_height") };
  }
  return { chainHeight: null, indexedHeight: null };
}

/**
 * `/metrics` (§8.1 proof strip). `participant_count` is pinned as distinct
 * addresses across ALL transaction kinds ([R5], recorded in the §9.4 revision
 * note). All-null until a worker stream has committed — after that, zero is
 * an honest count, not a cold-start artifact.
 */
export function deriveMetrics(facts: MetricsFacts): ProgramMetrics {
  if (!facts.indexed) {
    return { participant_count: null, program_started_at: null, epoch_count: null };
  }
  return {
    participant_count: facts.participantCount,
    program_started_at: facts.firstActivityAt === null ? null : facts.firstActivityAt.toISOString(),
    epoch_count: facts.epochCount,
  };
}

export function toEpochRow(s: EpochSnapshotFacts): EpochRow {
  return {
    epoch_index: toSafeInt(s.epochIndex, "epoch_index"),
    ended_at: new Date(toSafeInt(s.endedAtSeconds, "ended_at_seconds") * 1000).toISOString(),
    // Shared scale-then-floor helper [R1]; null for a zero-share epoch (an
    // empty vault has no NAV — the honest state, never a fabricated "0").
    nav: navHashPerShare(s.tvvAfter, s.totalShares),
    tvv: s.tvvAfter.toString(),
    net_apr_bps: s.netAprBps,
  };
}

export function toIncidentRow(f: IncidentFacts): IncidentRow {
  return {
    kind: f.kind,
    severity: f.severity,
    opened_at: f.openedAt.toISOString(),
    closed_at: f.closedAt === null ? null : f.closedAt.toISOString(),
    height: f.openedHeight === null ? null : toSafeInt(f.openedHeight, "incident height"),
  };
}

/**
 * One `/validators` row: registry enrollment joined with the validator's
 * latest sampled epoch (null per-epoch fields before the first sample — the
 * honest "no sample yet" state).
 */
export function toValidatorRow(
  reg: ValidatorRegistryFacts,
  latest: ValidatorEpochFacts | null,
): ValidatorRow {
  return {
    valoper: reg.valoper,
    moniker: reg.moniker,
    active: reg.unregisteredAt === null,
    epoch_index: latest === null ? null : toSafeInt(latest.epochIndex, "epoch_index"),
    uptime_bps: latest === null ? null : latest.uptimeBps,
    eligible: latest === null ? null : latest.eligible,
    failing_reasons: latest === null ? [] : [...latest.failingReasons],
    program_delegation: latest === null ? null : latest.programDelegation.toString(),
    commission_due: latest === null ? null : latest.commissionDue.toString(),
  };
}

/** Set-health aggregates over the full row set (semantics per rows.ts). */
export function deriveSetHealth(rows: readonly ValidatorRow[]): ValidatorSetHealth {
  const active = rows.filter((r) => r.active);
  return {
    total: rows.length,
    active: active.length,
    eligible: active.filter((r) => r.eligible === true).length,
    in_arrears: active.filter((r) => r.commission_due !== null && BigInt(r.commission_due) > 0n)
      .length,
  };
}

export function deriveValidatorsPayload(
  registry: readonly ValidatorRegistryFacts[],
  latestEpochByValoper: ReadonlyMap<string, ValidatorEpochFacts>,
): ValidatorsPayload {
  const validators = registry.map((reg) =>
    toValidatorRow(reg, latestEpochByValoper.get(reg.valoper) ?? null),
  );
  return { validators, set_health: deriveSetHealth(validators) };
}

// --- market (PR 3.2) --------------------------------------------------------

export interface MarketSampleFacts {
  readonly venue: string;
  readonly pool: string;
  /** Pool price in nhash per whole nvHASH (base-unit integer). */
  readonly priceNhash: bigint;
  /** Raw `depthBands` JSON as stored — validated here, never trusted. */
  readonly depthBands: unknown;
  readonly sampledAt: Date;
}

export interface BridgedSupplyFacts {
  readonly chain: string;
  readonly remoteSupply: bigint;
  readonly sampledAt: Date;
}

/**
 * The frozen `MarketDepthBand` shape as a boundary validator: `depthBands`
 * arrives as stored JSON, and a malformed band set is corrupt data — it
 * fails loudly (the toSafeInt philosophy), never a best-effort passthrough
 * that would ship an unchecked shape to consumers (SECURITY.md: validate at
 * the boundary; amounts stay decimal strings end to end).
 */
const depthBandsSchema = z.array(
  z.object({
    side: z.enum(["buy", "sell"]),
    slippage_bps: z.number().int().min(0).max(100_000),
    amount: z.string().regex(/^\d+$/, "base-unit decimal string"),
  }),
);

export function parseDepthBands(raw: unknown): MarketDepthBand[] {
  const parsed = depthBandsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RangeError(`market depth_bands failed shape validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * NAV as a base-unit price (nhash per whole nvHASH): tvv × 10^15 / shares,
 * floored. The bigint counterpart of the display-string `navHashPerShare` —
 * used only as the denominator of the premium/discount measure. Null for a
 * zero-share epoch (no NAV, no premium).
 */
export function navPriceNhash(tvvAfter: bigint, totalShares: bigint): bigint | null {
  if (totalShares <= 0n || tvvAfter < 0n) return null;
  return (tvvAfter * 10n ** BigInt(SHARE_EXPONENT)) / totalShares;
}

/**
 * `(market_price − NAV) / NAV` in bps, signed, truncated toward zero
 * (app-spec §9.5(4)); null when no NAV exists — the [R6] rule: the NAV here
 * must be the one current at the SAMPLE'S time, which the reader looks up
 * (last epoch settled at or before `sampled_at`) before calling this.
 */
export function premiumDiscountBps(priceNhash: bigint, navNhash: bigint | null): number | null {
  if (navNhash === null || navNhash <= 0n) return null;
  return toSafeSignedInt(((priceNhash - navNhash) * 10_000n) / navNhash, "premium_discount_bps");
}

export function toMarketSample(facts: MarketSampleFacts, navAtSampleTime: bigint | null): MarketSample {
  return {
    venue: facts.venue,
    pool: facts.pool,
    price: facts.priceNhash.toString(),
    premium_discount_bps: premiumDiscountBps(facts.priceNhash, navAtSampleTime),
    depth_bands: parseDepthBands(facts.depthBands),
    sampled_at: facts.sampledAt.toISOString(),
  };
}

export function toBridgedSupplyRow(facts: BridgedSupplyFacts): BridgedSupplyRow {
  return {
    chain: facts.chain,
    supply: facts.remoteSupply.toString(),
    sampled_at: facts.sampledAt.toISOString(),
  };
}

// --- address-scoped (PR 3.3) ------------------------------------------------

export interface TransactionFacts {
  readonly txhash: string;
  readonly msgIndex: number;
  readonly address: string;
  readonly kind: TransactionKind;
  readonly shares: bigint;
  readonly nhash: bigint;
  readonly navAtHeight: bigint;
  readonly height: bigint;
  readonly blockTime: Date;
}

export interface RedemptionFacts {
  readonly requestId: string;
  readonly owner: string;
  readonly shares: bigint;
  readonly status: RedemptionStatus;
  readonly enqueuedAt: Date;
  readonly expeditedAt: Date | null;
  readonly maturedAt: Date | null;
  readonly refundedAt: Date | null;
  readonly lastHeight: bigint;
  readonly lastTxhash: string;
}

export function toTransactionRow(f: TransactionFacts): TransactionRow {
  return {
    txhash: f.txhash,
    msg_index: f.msgIndex,
    kind: f.kind,
    shares: f.shares.toString(),
    nhash: f.nhash.toString(),
    nav_at_height: f.navAtHeight.toString(),
    height: toSafeInt(f.height, "height"),
    block_time: f.blockTime.toISOString(),
  };
}

export function toRedemptionRow(f: RedemptionFacts): RedemptionRow {
  return {
    request_id: f.requestId,
    shares: f.shares.toString(),
    status: f.status,
    enqueued_at: f.enqueuedAt.toISOString(),
    expedited_at: f.expeditedAt === null ? null : f.expeditedAt.toISOString(),
    matured_at: f.maturedAt === null ? null : f.maturedAt.toISOString(),
    refunded_at: f.refundedAt === null ? null : f.refundedAt.toISOString(),
    last_height: toSafeInt(f.lastHeight, "last_height"),
    last_txhash: f.lastTxhash,
  };
}

/** A redemption escrows shares while it is enqueued or expedited. */
export function isActiveRedemption(status: RedemptionStatus): boolean {
  return status === "enqueued" || status === "expedited";
}

// ── Payout statistics (§9.5.3, §14.12) ───────────────────────────────────

/** The physical band the "typical" statistic lives in (§9.5.3): the
 * unbonding floor (~21 days) to the redemption guarantee ceiling (60 days).
 * Carried in the payload so display copy never implies precision outside it. */
export const REDEMPTION_BAND_FLOOR_SECONDS = 21 * 24 * 60 * 60;
export const REDEMPTION_BAND_CEILING_SECONDS = 60 * 24 * 60 * 60;
/** §14.12: below ten terminal requests the "typical" would be a lie. */
export const PAYOUT_STATS_MIN_SAMPLE = 10;
/** The recent-terminal-request window (Q4 delivery: no epoch-index column
 * exists, so "recent-epoch cohort" is a rolling window). */
export const PAYOUT_STATS_WINDOW_DAYS = 90;

/** Linear-interpolated percentile over a NON-EMPTY sorted ascending array. */
export function percentileSeconds(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  return Math.round(sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (rank - lo));
}

/**
 * The §9.5.3 typical time-to-payout. `payoutDurationsSeconds` are already
 * filtered to the recent terminal cohort — each is
 * `(expedited_at ?? matured_at) − enqueued_at` in seconds — and `epochCount`
 * is the completed-epoch count (the cold-start gate). Median/p90 are exposed
 * only when NOT cold-start AND the cohort is sample-sufficient; otherwise
 * null, and the web tier shows the 60-day guarantee alone (§14.12).
 */
export function derivePayoutStats(
  payoutDurationsSeconds: readonly number[],
  epochCount: number,
): PayoutStats {
  const coldStart = epochCount < 1;
  const sampleCount = payoutDurationsSeconds.length;
  const sufficient = !coldStart && sampleCount >= PAYOUT_STATS_MIN_SAMPLE;
  const sorted = sufficient ? [...payoutDurationsSeconds].sort((a, b) => a - b) : [];
  return {
    sample_count: sampleCount,
    median_seconds: sufficient ? percentileSeconds(sorted, 50) : null,
    p90_seconds: sufficient ? percentileSeconds(sorted, 90) : null,
    band_floor_seconds: REDEMPTION_BAND_FLOOR_SECONDS,
    band_ceiling_seconds: REDEMPTION_BAND_CEILING_SECONDS,
    cold_start: coldStart,
  };
}

/** The payout time of a terminal request: expedited wins over matured
 * (§9.5.3); null when the request never paid out (refund-only). */
export function payoutTime(f: RedemptionFacts): Date | null {
  return f.expeditedAt ?? f.maturedAt ?? null;
}

/** enqueue→payout duration in whole seconds, or null when not paid out. */
export function payoutDurationSeconds(f: RedemptionFacts): number | null {
  const paid = payoutTime(f);
  if (paid === null) return null;
  const seconds = Math.floor((paid.getTime() - f.enqueuedAt.getTime()) / 1000);
  return seconds >= 0 ? seconds : null;
}

/**
 * `/portfolio` ([R2]): indexed facts only — first activity, event count,
 * escrow, active redemptions. Deliberately no balance (a live read) and no
 * derived metrics (M6.1). `activeRedemptions` must already be filtered to
 * active states (the readers own the filter; asserted here defensively).
 */
export function derivePortfolio(
  address: string,
  firstActivityAt: Date | null,
  transactionCount: number,
  activeRedemptions: readonly RedemptionFacts[],
): PortfolioSummary {
  let escrowed = 0n;
  for (const redemption of activeRedemptions) {
    if (!isActiveRedemption(redemption.status)) {
      throw new RangeError(`redemption ${redemption.requestId} is ${redemption.status}, not active`);
    }
    escrowed += redemption.shares;
  }
  return {
    address,
    first_activity_at: firstActivityAt === null ? null : firstActivityAt.toISOString(),
    transaction_count: transactionCount,
    escrowed_shares: escrowed.toString(),
    active_redemptions: activeRedemptions.map(toRedemptionRow),
  };
}
