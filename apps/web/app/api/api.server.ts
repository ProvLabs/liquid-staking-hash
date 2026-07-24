// Shared services/api transport + boundary validation for the web tier
// (extracted from chrome.server.ts in PR 4.2; consumers: chrome.server.ts,
// learn.server.ts). @nvhash/api-types ships the shapes but, deliberately
// zero-dep, no untrusted-input parser; the zod schemas here are this tier's
// boundary validation (SECURITY.md: inputs validated and bounded at entry).
// Every schema is pinned to its shared shape with `satisfies`, so drift
// between producer and consumer is a type error, not a runtime surprise.

import type {
  AccrualMarker,
  AccrualPoint,
  BridgedSupplyRow,
  EffectiveYieldPoint,
  EpochRow,
  FreshnessMeta,
  IncidentKind,
  IncidentRow,
  IncidentSeverity,
  MarketDepthBand,
  MarketSample,
  MarketSummary,
  PortfolioMetrics,
  PortfolioSummary,
  ProgramMetrics,
  RedemptionRow,
  TransactionRow,
  ValidatorRow,
  ValidatorSetHealth,
  ValidatorsPayload,
} from "@nvhash/api-types";
import type { FetchLike } from "@nvhash/chain-client";
import { z } from "zod";

const isoTimestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "expected an ISO-8601 timestamp");

export const freshnessMetaSchema = z.object({
  chain_height: z.number().int().nonnegative().nullable(),
  indexed_height: z.number().int().nonnegative().nullable(),
  generated_at: isoTimestamp,
  source: z.enum(["live", "indexed"]),
}) satisfies z.ZodType<FreshnessMeta>;

/** Envelope schema over a typed payload schema. */
export function envelopeSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({ data, meta: freshnessMetaSchema });
}

export const incidentKindSchema = z.enum([
  "contract_halted",
  "vault_paused",
  "slash_write_down",
  "redemption_refund",
  "jail_report",
  "epoch_overdue",
  "reconciler_divergence",
  "indexer_lag",
]) satisfies z.ZodType<IncidentKind>;

export const incidentSeveritySchema = z.enum([
  "info",
  "warning",
  "critical",
]) satisfies z.ZodType<IncidentSeverity>;

export const incidentRowSchema = z.object({
  kind: incidentKindSchema,
  severity: incidentSeveritySchema,
  opened_at: isoTimestamp,
  closed_at: isoTimestamp.nullable(),
  height: z.number().int().nonnegative().nullable(),
}) satisfies z.ZodType<IncidentRow>;

/** Decimal-string amount (BigInt/Decimal domain; floats never touch these). */
const decimalString = z.string().regex(/^\d+(\.\d+)?$/, "expected a decimal string");

/** Base-unit integer amount as a decimal string (fractions are a shape
 * error: consumers BigInt() these; PR #14 review). */
const baseUnitString = z.string().regex(/^\d+$/, "expected a base-unit integer string");

/** Signed base-unit integer amount (realized gain, the one signed nhash
 * figure; leading `-` allowed, fractions a shape error since consumers
 * BigInt() these). */
const signedBaseUnitString = z.string().regex(/^-?\d+$/, "expected a signed base-unit integer string");

export const epochRowSchema = z.object({
  epoch_index: z.number().int().nonnegative(),
  ended_at: isoTimestamp,
  // null since PR 3.1: an epoch settled with zero shares has no NAV. NAV is
  // a fractional decimal (HASH per nvHASH); TVV is base units, integer-only.
  nav: decimalString.nullable(),
  tvv: baseUnitString,
  net_apr_bps: z.number().int().min(-1_000_000).max(1_000_000).nullable(),
}) satisfies z.ZodType<EpochRow>;

export const programMetricsSchema = z.object({
  participant_count: z.number().int().nonnegative().nullable(),
  program_started_at: isoTimestamp.nullable(),
  epoch_count: z.number().int().nonnegative().nullable(),
}) satisfies z.ZodType<ProgramMetrics>;

// PR 3.1 owns /validators: ValidatorsPayload = per-validator rows (registry
// enrollment joined to the latest sample) plus the set-health aggregates.
export const apiValidatorRowSchema = z.object({
  valoper: z.string().max(90),
  moniker: z.string().max(128),
  active: z.boolean(),
  epoch_index: z.number().int().nonnegative().nullable(),
  uptime_bps: z.number().int().min(0).max(1_000_000).nullable(),
  eligible: z.boolean().nullable(),
  failing_reasons: z.array(z.string().max(64)).max(32),
  program_delegation: decimalString.nullable(),
  commission_due: decimalString.nullable(),
}) satisfies z.ZodType<ValidatorRow>;

export const validatorSetHealthSchema = z.object({
  total: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  in_arrears: z.number().int().nonnegative(),
}) satisfies z.ZodType<ValidatorSetHealth>;

export const validatorsPayloadSchema = z.object({
  validators: z.array(apiValidatorRowSchema).max(500),
  set_health: validatorSetHealthSchema,
}) satisfies z.ZodType<ValidatorsPayload>;

// PR 3.2's /market shapes: market data has no chain-canonical plane, so the
// venue + sample-time labeling rides IN the payload and is validated here
// like any other boundary input.
export const marketDepthBandSchema = z.object({
  side: z.enum(["buy", "sell"]),
  slippage_bps: z.number().int().min(0).max(100_000),
  amount: baseUnitString,
}) satisfies z.ZodType<MarketDepthBand>;

export const marketSampleSchema = z.object({
  venue: z.string().min(1).max(64),
  pool: z.string().min(1).max(90),
  price: baseUnitString,
  premium_discount_bps: z.number().int().min(-1_000_000).max(1_000_000).nullable(),
  depth_bands: z.array(marketDepthBandSchema).max(32),
  sampled_at: isoTimestamp,
}) satisfies z.ZodType<MarketSample>;

export const bridgedSupplyRowSchema = z.object({
  chain: z.string().min(1).max(64),
  supply: baseUnitString,
  sampled_at: isoTimestamp,
}) satisfies z.ZodType<BridgedSupplyRow>;

export const marketSummarySchema = z.object({
  sample: marketSampleSchema.nullable(),
  bridged_supply: z.array(bridgedSupplyRowSchema).max(64),
}) satisfies z.ZodType<MarketSummary>;

// M6.1 personal surfaces (address-scoped /portfolio, /portfolio/metrics,
// /transactions). Amounts are base-unit integer strings; only realized_gain_nhash
// is signed (the accrual/marker legs are unsigned). Closed unions are pinned so
// an unknown wire variant is a shape error, not a guess.
export const redemptionStatusSchema = z.enum([
  "enqueued",
  "expedited",
  "matured",
  "refunded",
]);

export const redemptionRowSchema = z.object({
  request_id: z.string().max(128),
  shares: baseUnitString,
  status: redemptionStatusSchema,
  enqueued_at: isoTimestamp,
  expedited_at: isoTimestamp.nullable(),
  matured_at: isoTimestamp.nullable(),
  refunded_at: isoTimestamp.nullable(),
  last_height: z.number().int().nonnegative(),
  last_txhash: z.string().max(64),
}) satisfies z.ZodType<RedemptionRow>;

export const portfolioSummarySchema = z.object({
  address: z.string().max(90),
  first_activity_at: isoTimestamp.nullable(),
  transaction_count: z.number().int().nonnegative(),
  escrowed_shares: baseUnitString,
  active_redemptions: z.array(redemptionRowSchema).max(500),
}) satisfies z.ZodType<PortfolioSummary>;

export const transactionKindSchema = z.enum([
  "swap_in",
  "swap_out_request",
  "redemption_payout",
  "redemption_refund",
  "transfer_in",
  "transfer_out",
]);

export const transactionRowSchema = z.object({
  txhash: z.string().max(64),
  msg_index: z.number().int().nonnegative(),
  kind: transactionKindSchema,
  shares: baseUnitString,
  nhash: baseUnitString,
  nav_at_height: decimalString,
  height: z.number().int().nonnegative(),
  block_time: isoTimestamp,
}) satisfies z.ZodType<TransactionRow>;

export const effectiveYieldPointSchema = z.object({
  epoch_index: z.number().int().nonnegative(),
  ended_at: isoTimestamp,
  personal_apr_bps: z.number().int().min(-1_000_000).max(1_000_000).nullable(),
  net_apr_bps: z.number().int().min(-1_000_000).max(1_000_000).nullable(),
}) satisfies z.ZodType<EffectiveYieldPoint>;

export const accrualPointSchema = z.object({
  time: isoTimestamp,
  height: z.number().int().nonnegative(),
  value_nhash: baseUnitString,
}) satisfies z.ZodType<AccrualPoint>;

export const accrualMarkerSchema = z.object({
  time: isoTimestamp,
  txhash: z.string().max(64),
  kind: transactionKindSchema,
  shares: baseUnitString,
  nhash: baseUnitString,
}) satisfies z.ZodType<AccrualMarker>;

export const portfolioMetricsSchema = z.object({
  address: z.string().max(90),
  history_state: z.enum(["complete", "has_transfers", "inconsistent"]),
  indexed_share_balance: baseUnitString,
  escrowed_share_balance: baseUnitString,
  cost_basis_nhash: baseUnitString.nullable(),
  escrowed_basis_nhash: baseUnitString.nullable(),
  realized_gain_nhash: signedBaseUnitString.nullable(),
  effective_apr_bps: z.number().int().min(-1_000_000).max(1_000_000).nullable(),
  yield_by_epoch: z.array(effectiveYieldPointSchema).max(20_000),
  yield_truncated: z.boolean(),
  accrual: z.array(accrualPointSchema).max(20_000),
  accrual_truncated: z.boolean(),
  accrual_markers: z.array(accrualMarkerSchema).max(2_000),
  markers_truncated: z.boolean(),
}) satisfies z.ZodType<PortfolioMetrics>;

/** Collections stay bounded at the boundary, mirroring the API's page cap. */
export const incidentsEnvelopeSchema = envelopeSchema(z.array(incidentRowSchema).max(200));
export const epochsEnvelopeSchema = envelopeSchema(z.array(epochRowSchema).max(200));
export const validatorsEnvelopeSchema = envelopeSchema(validatorsPayloadSchema);
export const metricsEnvelopeSchema = envelopeSchema(programMetricsSchema);
export const marketEnvelopeSchema = envelopeSchema(marketSummarySchema);
export const statusEnvelopeSchema = envelopeSchema(z.unknown());
export const portfolioEnvelopeSchema = envelopeSchema(portfolioSummarySchema);
export const portfolioMetricsEnvelopeSchema = envelopeSchema(portfolioMetricsSchema);
export const transactionsEnvelopeSchema = envelopeSchema(z.array(transactionRowSchema).max(200));

/**
 * Bounded-timeout GET returning parsed JSON. Throws on non-OK status,
 * timeout, or non-JSON; callers degrade the failure to their own null path.
 */
export async function fetchApiJson(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`GET ${url}: HTTP ${response.status}`);
    }
    return JSON.parse(await response.text()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}
