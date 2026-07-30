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
  type AlertArrearsFact,
  type AlertIncidentFact,
  type AlertRedemptionFact,
  type BridgedSupplyRow,
  type EpochRow,
  type IncidentKind,
  type IncidentRow,
  type IncidentSeverity,
  type MarketDepthBand,
  type MarketSample,
  type OperatorEpochRow,
  type OperatorPaymentRow,
  type OperatorPaymentType,
  type OperatorSummary,
  type OperatorValidatorRow,
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
  MAX_GOV_METADATA_LENGTH,
  MAX_GOV_PROPOSAL_MESSAGES,
  MAX_GOV_PROPOSERS,
  MAX_GOV_SUMMARY_LENGTH,
  MAX_GOV_TITLE_LENGTH,
  MAX_GOV_VOTES_PER_PROPOSAL,
  type GovDecisionPolicy,
  type GovExecutorResult,
  type GovPolicyRow,
  type GovProposalDetail,
  type GovProposalRow,
  type GovProposalStatus,
  type GovVoteOption,
  type GovVoteRow,
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
  /**
   * Operator account (public chain data). Optional because the public
   * `/validators` derivation never surfaces it (it is excluded from public
   * economics, app-spec §9.4); only the M6.2 arrears join reads it.
   */
  readonly operator?: string;
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

// --- internal alert-facts (M6.2, `internal:notifier` scope) -----------------
//
// The notifier's cross-address evaluation reads (ADR-001 Decision 3). Each is
// a pure projection to the identity/ordinal fields the notifier keys off —
// NEVER amounts on the redemption/incident facts (the stored notification
// carries no amount, plan §2.1). The heights/ids cross into JS number domain
// through the same loud safe-integer guard as every other fact.

/** Structural facts for one alert-incident projection (id + dedupe identity). */
export interface AlertIncidentFacts {
  readonly id: bigint;
  readonly kind: IncidentKind;
  readonly severity: IncidentSeverity;
  readonly dedupeKey: string;
  readonly openedAt: Date;
  readonly openedHeight: bigint | null;
}

/** Structural facts for one arrears projection (validator × operator × epoch). */
export interface AlertArrearsFacts {
  readonly valoper: string;
  readonly operator: string;
  readonly epochIndex: bigint;
  readonly commissionDue: bigint;
}

/**
 * A redemption fact for the notifier: owner + terminal timestamps + the height
 * cursor. Reuses `RedemptionFacts` (only a subset is read); deliberately drops
 * `shares` — the alert surface carries no amount (plan §2.1).
 */
export function toAlertRedemptionFact(f: RedemptionFacts): AlertRedemptionFact {
  return {
    request_id: f.requestId,
    owner: f.owner,
    status: f.status,
    enqueued_at: f.enqueuedAt.toISOString(),
    expedited_at: f.expeditedAt === null ? null : f.expeditedAt.toISOString(),
    matured_at: f.maturedAt === null ? null : f.maturedAt.toISOString(),
    refunded_at: f.refundedAt === null ? null : f.refundedAt.toISOString(),
    last_height: toSafeInt(f.lastHeight, "last_height"),
  };
}

export function toAlertIncidentFact(f: AlertIncidentFacts): AlertIncidentFact {
  return {
    id: toSafeInt(f.id, "incident id"),
    kind: f.kind,
    severity: f.severity,
    dedupe_key: f.dedupeKey,
    opened_at: f.openedAt.toISOString(),
    opened_height: f.openedHeight === null ? null : toSafeInt(f.openedHeight, "opened_height"),
  };
}

export function toAlertArrearsFact(f: AlertArrearsFacts): AlertArrearsFact {
  return {
    valoper: f.valoper,
    operator: f.operator,
    epoch_index: toSafeInt(f.epochIndex, "epoch_index"),
    commission_due: f.commissionDue.toString(),
  };
}

// --- operator surface (M6.4, address-scoped) --------------------------------
//
// The personal counterpart of the public `/validators` projection. Two rules
// shape everything here:
//   1. The address→valoper mapping is resolved from `validator_registry` and
//      enforced server-side; a valoper the address does not operate resolves to
//      nothing, and the route answers honest-empty rather than 403 — a 403
//      would be an oracle telling the caller that valoper exists and belongs to
//      someone else (plan §3 commit B: "never 403-leaks about who operates
//      what").
//   2. `epoch_index` on a payment is DERIVED here, not stored: the indexer
//      cannot know a payment's crediting epoch at ingest (app-spec §9.1).

export interface OperatorRegistryFacts {
  readonly valoper: string;
  readonly operator: string;
  readonly moniker: string;
  readonly enrolledAt: Date;
  readonly unregisteredAt: Date | null;
}

/**
 * The FULL `validator_epochs` row. Distinct from `ValidatorEpochFacts`, which
 * the public projection deliberately keeps narrow (operator economics never
 * leave the server on the public page — `apps/web/test/validators-data.test.ts`
 * gates that closed key set). Widening the public fact type instead of adding
 * this one would have quietly opened that boundary.
 */
export interface OperatorEpochFacts {
  readonly valoper: string;
  readonly epochIndex: bigint;
  readonly uptimeBps: number;
  readonly eligible: boolean;
  readonly failingReasons: readonly string[];
  readonly tip: bigint;
  readonly commissionAccrued: bigint;
  readonly commissionPaid: bigint;
  readonly commissionDue: bigint;
  readonly programDelegation: bigint;
  readonly height: bigint;
  readonly observedAt: Date;
}

export interface OperatorPaymentFacts {
  readonly txhash: string;
  readonly msgIndex: number;
  /** Sibling discriminator within (txhash, msgIndex). Internal: it completes
   * the row's identity and the export's sort key, and is not served. */
  readonly ordinal: number;
  readonly valoper: string;
  readonly payer: string;
  readonly paymentType: OperatorPaymentType;
  readonly amount: bigint;
  readonly height: bigint;
  readonly occurredAt: Date;
}

/** Lifetime payment sums for one validator, by type (`operator_payments`). */
export interface OperatorPaymentTotalFacts {
  readonly valoper: string;
  readonly commissionPaidTotal: bigint;
  readonly tipPaidTotal: bigint;
  readonly paymentCount: number;
}

/** An epoch's closing height — the boundary payment epochs are assigned by. */
export interface EpochBoundary {
  readonly epochIndex: bigint;
  readonly endHeight: bigint;
}

/**
 * The valoper a request may be served, or null. The ONE place the ownership
 * rule lives: a valoper not in the operator's own set resolves to null, and
 * every operator route answers honest-empty for null. Pure, so the rule is
 * unit-tested rather than reviewed.
 */
export function resolveOwnedValoper(
  owned: readonly OperatorRegistryFacts[],
  requested: string,
): string | null {
  return owned.some((r) => r.valoper === requested) ? requested : null;
}

/**
 * The epoch a payment at `height` credited: the EARLIEST epoch that closed at
 * or after the payment's height. A payment lands inside an open epoch, and that
 * epoch closes at the next `run_epoch` crank — so the first snapshot whose
 * `endHeight >= height` is the one that swept it (app-spec §9.1/§9.2).
 *
 * Null when no such snapshot exists: the crediting epoch has not closed yet, or
 * the indexer has not reached it. Null is the honest answer — never the latest
 * epoch, which would misattribute every recent payment.
 *
 * **Same-block boundary: ACCEPTED as-is (Ira, 2026-07-28), not merely
 * tolerated.** When `height == endHeight` — a payment in the SAME BLOCK as the
 * crank that closed the epoch — intra-block ordering decides which epoch truly
 * swept it, and `operator_payments` stores no intra-block ordinal, so that
 * ordering is not recoverable from stored data. `>=` resolves the tie to the
 * epoch closing AT that height.
 *
 * The reason this needs no further precision is ECONOMIC, not statistical:
 * program commission ROLLS OVER (`contracts/src/validators.rs`; the same
 * cumulative-overpayment fact the `prepaid` banner state rests on). So both
 * directions of a misattribution are harmless — if the payment is credited to
 * the earlier epoch and commission WAS due, it settles a real obligation; if
 * nothing was due, it becomes a prepaid credit that carries forward to the next
 * bill. Either way the operator is credited exactly once for exactly what they
 * paid. The boundary can only shift which row of the §14.11 CSV a payment
 * appears against, never whether it counts.
 *
 * That is why a tx-ordinal column was considered and NOT added: it would buy
 * presentational precision on a figure that is already economically exact.
 * Pinned by the boundary cases in `test/operator-endpoints.test.ts` so the
 * choice cannot drift silently.
 *
 * `boundariesAsc` MUST be ascending by height; the walk relies on it.
 */
export function paymentEpochIndex(
  height: bigint,
  boundariesAsc: readonly EpochBoundary[],
): bigint | null {
  // Binary search for the first boundary with endHeight >= height.
  let lo = 0;
  let hi = boundariesAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boundariesAsc[mid]!.endHeight < height) lo = mid + 1;
    else hi = mid;
  }
  return lo < boundariesAsc.length ? boundariesAsc[lo]!.epochIndex : null;
}

export function toOperatorEpochRow(f: OperatorEpochFacts): OperatorEpochRow {
  return {
    valoper: f.valoper,
    epoch_index: toSafeInt(f.epochIndex, "epoch_index"),
    uptime_bps: f.uptimeBps,
    eligible: f.eligible,
    failing_reasons: [...f.failingReasons],
    tip: f.tip.toString(),
    commission_accrued: f.commissionAccrued.toString(),
    commission_paid: f.commissionPaid.toString(),
    commission_due: f.commissionDue.toString(),
    program_delegation: f.programDelegation.toString(),
    height: toSafeInt(f.height, "height"),
    observed_at: f.observedAt.toISOString(),
  };
}

export function toOperatorPaymentRow(
  f: OperatorPaymentFacts,
  boundariesAsc: readonly EpochBoundary[],
): OperatorPaymentRow {
  const epoch = paymentEpochIndex(f.height, boundariesAsc);
  return {
    txhash: f.txhash,
    msg_index: f.msgIndex,
    valoper: f.valoper,
    payer: f.payer,
    payment_type: f.paymentType,
    amount: f.amount.toString(),
    epoch_index: epoch === null ? null : toSafeInt(epoch, "epoch_index"),
    height: toSafeInt(f.height, "height"),
    occurred_at: f.occurredAt.toISOString(),
  };
}

/** One `/operator/summary` row: registry + latest sampled epoch + lifetime
 * totals. Latest-epoch fields are null before the first sample; totals are a
 * sum over indexed rows, so "0" there is honest, not a cold-start artifact. */
export function toOperatorValidatorRow(
  reg: OperatorRegistryFacts,
  latest: OperatorEpochFacts | null,
  totals: OperatorPaymentTotalFacts | null,
): OperatorValidatorRow {
  return {
    valoper: reg.valoper,
    moniker: reg.moniker,
    operator: reg.operator,
    active: reg.unregisteredAt === null,
    enrolled_at: reg.enrolledAt.toISOString(),
    unregistered_at: reg.unregisteredAt === null ? null : reg.unregisteredAt.toISOString(),
    epoch_index: latest === null ? null : toSafeInt(latest.epochIndex, "epoch_index"),
    uptime_bps: latest === null ? null : latest.uptimeBps,
    eligible: latest === null ? null : latest.eligible,
    failing_reasons: latest === null ? [] : [...latest.failingReasons],
    program_delegation: latest === null ? null : latest.programDelegation.toString(),
    tip: latest === null ? null : latest.tip.toString(),
    commission_accrued: latest === null ? null : latest.commissionAccrued.toString(),
    commission_paid: latest === null ? null : latest.commissionPaid.toString(),
    commission_due: latest === null ? null : latest.commissionDue.toString(),
    commission_paid_total: (totals?.commissionPaidTotal ?? 0n).toString(),
    tip_paid_total: (totals?.tipPaidTotal ?? 0n).toString(),
    payment_count: totals?.paymentCount ?? 0,
  };
}

export function deriveOperatorSummary(
  address: string,
  registry: readonly OperatorRegistryFacts[],
  latestByValoper: ReadonlyMap<string, OperatorEpochFacts>,
  totalsByValoper: ReadonlyMap<string, OperatorPaymentTotalFacts>,
): OperatorSummary {
  return {
    address,
    validators: registry.map((reg) =>
      toOperatorValidatorRow(
        reg,
        latestByValoper.get(reg.valoper) ?? null,
        totalsByValoper.get(reg.valoper) ?? null,
      ),
    ),
  };
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

// --- governance (PR 7.1 commit C) -------------------------------------------
//
// Pure mappers from the indexer's row facts to the frozen wire shapes. The
// division of labour is the same as everywhere else in this file: derivation
// happens here, the reader adds only SELECTs, and the route adds only the
// envelope.
//
// Two things these mappers deliberately do NOT do:
//   * decode a proposal's `messages` — they are carried verbatim, because 7.2
//     owns the decode (a closed typed union with a tagged `unknown`) and 7.4's
//     relay guard re-encodes them canonically byte-for-byte;
//   * decide passage — that is `meetsThreshold` in @nvhash/api-types, shared
//     with the web tier so the two cannot disagree about whether a proposal
//     passed (D17, the `navHashPerShare` precedent).

/** Row facts as the indexer stores a proposal (bigints already widened). */
export interface GovProposalFacts {
  readonly proposalId: bigint;
  readonly groupPolicyAddress: string;
  readonly groupId: bigint;
  readonly proposers: string[];
  readonly status: string;
  readonly executorResult: string;
  readonly metadata: string | null;
  readonly title: string;
  readonly summary: string;
  readonly messages: unknown;
  readonly submitTime: Date;
  readonly votingPeriodEnd: Date;
  readonly yesCount: bigint;
  readonly noCount: bigint;
  readonly abstainCount: bigint;
  readonly noWithVetoCount: bigint;
  readonly groupVersion: bigint;
  readonly groupPolicyVersion: bigint;
  readonly decisionPolicy: unknown;
  readonly observedHeight: bigint;
  readonly observedAt: Date;
  readonly height: bigint | null;
  readonly txhash: string | null;
  readonly prunedAtHeight: bigint | null;
}

export interface GovVoteFacts {
  readonly proposalId: bigint;
  readonly voter: string;
  readonly option: string;
  readonly metadata: string | null;
  readonly weight: bigint | null;
  readonly submitTime: Date;
  readonly height: bigint | null;
  readonly txhash: string | null;
}

/** Lower-case the stored SCREAMING enum into the wire union, falling back to
 * `unspecified` for anything unrecognized. Never throws: a status a later chain
 * upgrade adds must render honestly rather than 500 a page. */
function toStatus(stored: string): GovProposalStatus {
  const lower = stored.toLowerCase();
  return (GOV_STATUS_WIRE as readonly string[]).includes(lower)
    ? (lower as GovProposalStatus)
    : "unspecified";
}
const GOV_STATUS_WIRE = [
  "submitted",
  "accepted",
  "rejected",
  "aborted",
  "withdrawn",
  "unspecified",
] as const;

function toExecutorResult(stored: string): GovExecutorResult {
  const lower = stored.toLowerCase();
  return lower === "success" || lower === "failure" || lower === "not_run"
    ? (lower as GovExecutorResult)
    : "unspecified";
}

function toVoteOption(stored: string): GovVoteOption {
  const lower = stored.toLowerCase();
  return lower === "yes" || lower === "no" || lower === "abstain" || lower === "no_with_veto"
    ? (lower as GovVoteOption)
    : "unspecified";
}

/**
 * The stored decision-policy JSON → the wire union. An unrecognized `@type`
 * becomes a tagged `unknown` carrying the type URL: a surface can then say which
 * policy type it does not understand, and `meetsThreshold` returns null for it
 * rather than scoring against a guessed rule.
 */
export function toGovDecisionPolicy(stored: unknown): GovDecisionPolicy | null {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return null;
  const o = stored as Record<string, unknown>;
  const typeUrl = typeof o["@type"] === "string" ? o["@type"] : "";
  const windows = (o["windows"] ?? {}) as Record<string, unknown>;
  const votingPeriod = typeof windows["voting_period"] === "string" ? windows["voting_period"] : "";
  const minExecution =
    typeof windows["min_execution_period"] === "string" ? windows["min_execution_period"] : "";

  if (typeUrl === "/cosmos.group.v1.ThresholdDecisionPolicy" && typeof o["threshold"] === "string") {
    return {
      kind: "threshold",
      threshold: o["threshold"],
      voting_period: votingPeriod,
      min_execution_period: minExecution,
    };
  }
  if (typeUrl === "/cosmos.group.v1.PercentageDecisionPolicy" && typeof o["percentage"] === "string") {
    return {
      kind: "percentage",
      percentage: o["percentage"],
      voting_period: votingPeriod,
      min_execution_period: minExecution,
    };
  }
  return { kind: "unknown", type_url: typeUrl };
}

/**
 * One proposal row.
 *
 * `messages` is TRIMMED to its wire bound with an explicit `messages_truncated`
 * flag rather than silently shortened: a governance payload that quietly loses a
 * message would misstate what is being voted on. Same posture as the vote list in
 * `toGovProposalDetail`.
 *
 * `proposers` is trimmed the same way, and the trim is on the PRODUCER side of a
 * bound the consumer also imports (§4b C2) — the pairing is asserted in
 * `packages/api-types/test/bounds.test.ts`, not agreed by eye.
 */
export function toGovProposalRow(f: GovProposalFacts): GovProposalRow {
  const messages = Array.isArray(f.messages) ? f.messages : [];
  const truncated = messages.length > MAX_GOV_PROPOSAL_MESSAGES;
  // Flagged for the same reason `messages` is, and it is NOT covered by that flag:
  // `proposers` is identity data, so a silent trim leaves a consumer unable to tell
  // a full list from a shortened one (PR #23 review, P2).
  const proposersTruncated = f.proposers.length > MAX_GOV_PROPOSERS;
  return {
    // u64 ids stay STRINGS on the wire: the JSON number domain stops at 2^53.
    proposal_id: f.proposalId.toString(),
    group_policy_address: f.groupPolicyAddress,
    group_id: f.groupId.toString(),
    proposers: f.proposers.slice(0, MAX_GOV_PROPOSERS),
    status: toStatus(f.status),
    executor_result: toExecutorResult(f.executorResult),
    title: f.title.slice(0, MAX_GOV_TITLE_LENGTH),
    summary: f.summary.slice(0, MAX_GOV_SUMMARY_LENGTH),
    metadata: f.metadata === null ? null : f.metadata.slice(0, MAX_GOV_METADATA_LENGTH),
    tally: {
      // Unbounded weight sums: decimal strings, never numbers.
      yes: f.yesCount.toString(),
      no: f.noCount.toString(),
      abstain: f.abstainCount.toString(),
      no_with_veto: f.noWithVetoCount.toString(),
    },
    decision_policy: toGovDecisionPolicy(f.decisionPolicy) ?? { kind: "unknown", type_url: "" },
    submit_time: f.submitTime.toISOString(),
    voting_period_end: f.votingPeriodEnd.toISOString(),
    group_version: f.groupVersion.toString(),
    group_policy_version: f.groupPolicyVersion.toString(),
    observed_height: toSafeInt(f.observedHeight, "gov_proposals.observedHeight"),
    observed_at: f.observedAt.toISOString(),
    height: f.height === null ? null : toSafeInt(f.height, "gov_proposals.height"),
    txhash: f.txhash,
    pruned_at_height:
      f.prunedAtHeight === null ? null : toSafeInt(f.prunedAtHeight, "gov_proposals.prunedAtHeight"),
    messages_truncated: truncated,
    proposers_truncated: proposersTruncated,
    messages: truncated ? messages.slice(0, MAX_GOV_PROPOSAL_MESSAGES) : messages,
  };
}

export function toGovVoteRow(f: GovVoteFacts): GovVoteRow {
  return {
    proposal_id: f.proposalId.toString(),
    voter: f.voter,
    option: toVoteOption(f.option),
    metadata: f.metadata,
    // Null stays NULL. A vote whose weight could not be recovered must not read
    // as a vote that counted for zero.
    weight: f.weight === null ? null : f.weight.toString(),
    submit_time: f.submitTime.toISOString(),
    height: f.height === null ? null : toSafeInt(f.height, "gov_votes.height"),
    txhash: f.txhash,
  };
}

/**
 * A proposal plus its votes.
 *
 * The vote list is NOT page-controlled by the caller — the detail endpoint serves
 * a proposal's whole vote set, whose size is a property of the group rather than
 * of the request — so it is trimmed to its wire bound and FLAGGED. x/group puts no
 * ceiling on group membership, so "the group is obviously small" is precisely the
 * assumption §4b C2 says not to rely on.
 */
export function toGovProposalDetail(
  proposal: GovProposalFacts,
  votes: readonly GovVoteFacts[],
): GovProposalDetail {
  const truncated = votes.length > MAX_GOV_VOTES_PER_PROPOSAL;
  return {
    proposal: toGovProposalRow(proposal),
    votes: (truncated ? votes.slice(0, MAX_GOV_VOTES_PER_PROPOSAL) : votes).map(toGovVoteRow),
    votes_truncated: truncated,
  };
}

/** Aggregated per-policy facts, as the reader groups them out of the mirror. */
export interface GovPolicyFacts {
  readonly address: string;
  readonly groupId: bigint;
  readonly proposalCount: number;
  readonly lastSeenHeight: bigint;
  readonly decisionPolicy: unknown;
}

export function toGovPolicyRow(f: GovPolicyFacts): GovPolicyRow {
  return {
    address: f.address,
    group_id: f.groupId.toString(),
    proposal_count: f.proposalCount,
    last_seen_height: toSafeInt(f.lastSeenHeight, "gov_policies.lastSeenHeight"),
    decision_policy: toGovDecisionPolicy(f.decisionPolicy),
  };
}
