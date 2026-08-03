// Shared services/api transport + boundary validation for the web tier
// (extracted from chrome.server.ts; consumers: chrome.server.ts,
// learn.server.ts). @nvhash/api-types ships the shapes but, deliberately
// zero-dep, no untrusted-input parser; the zod schemas here are this tier's
// boundary validation (SECURITY.md: inputs validated and bounded at entry).
// Every schema is pinned to its shared shape with `satisfies`, so drift
// between producer and consumer is a type error, not a runtime surprise.

import type {
  AccrualMarker,
  AccrualPoint,
  AdminAdoptionPoint,
  AdminConcentration,
  AdminHealthPoint,
  AdminHolderCohorts,
  AdminIncidentRow,
  AdminProgramHealth,
  AdminRedemptionMix,
  AdminRetentionCurve,
  AdminRetentionPoint,
  AdminUpkeepBucket,
  AdminUpkeepDistribution,
  AdminUpkeepTimeliness,
  AdminValidatorCohorts,
  AdminValidatorPoint,
  AlertArrearsFact,
  AlertIncidentFact,
  AlertRedemptionFact,
  BridgedSupplyRow,
  EffectiveYieldPoint,
  EpochRow,
  FreshnessMeta,
  GovDecisionPolicy,
  GovExecutorResult,
  GovPolicyRow,
  GovProposalDetail,
  GovProposalRow,
  GovProposalsPayload,
  GovProposalStatus,
  GovTally,
  GovVoteOption,
  GovVoteRow,
  IncidentKind,
  IncidentRow,
  IncidentSeverity,
  MarketDepthBand,
  MarketSample,
  MarketSummary,
  OperatorEpochRow,
  OperatorPaymentRow,
  OperatorPaymentType,
  OperatorSummary,
  OperatorValidatorRow,
  PayoutStats,
  PortfolioMetrics,
  PortfolioSummary,
  ProgramMetrics,
  RedemptionRow,
  RedemptionStatus,
  TransactionKind,
  TransactionRow,
  ValidatorRow,
  ValidatorSetHealth,
  ValidatorsPayload,
} from "@nvhash/api-types";
// The CONSUMER half of the wire bounds, imported rather than restated. Before
// These were literals here and the producer's caps were literals in
// services/api, coupled only by a comment in the row types — which is precisely
// how a `yield_by_epoch` mismatch nulls a whole derived read. The pairing
// is now asserted in packages/api-types/test/bounds.test.ts.
import {
  MARKER_CAP_WIRE,
  MAX_ADMIN_EPOCH_POINTS_WIRE,
  MAX_ADMIN_INCIDENTS_PAGE_WIRE,
  MAX_ADMIN_RETENTION_CURVES_WIRE,
  MAX_ADMIN_UPKEEP_BUCKETS_WIRE,
  MAX_ACCRUAL_POINTS_WIRE,
  MAX_BECH32_LENGTH,
  MAX_GOV_METADATA_LENGTH,
  MAX_GOV_POLICIES_WIRE,
  MAX_GOV_PROPOSAL_MESSAGES_WIRE,
  MAX_GOV_PROPOSALS_PAGE_WIRE,
  MAX_GOV_PROPOSERS_WIRE,
  MAX_GOV_SUMMARY_LENGTH,
  MAX_GOV_TITLE_LENGTH,
  MAX_GOV_VOTES_PER_PROPOSAL_WIRE,
  MAX_TXHASH_LENGTH,
  MAX_YIELD_POINTS_WIRE,
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
 * error: consumers BigInt these). */
const baseUnitString = z.string().regex(/^\d+$/, "expected a base-unit integer string");

/** Signed base-unit integer amount (realized gain, the one signed nhash
 * figure; leading `-` allowed, fractions a shape error since consumers
 * BigInt() these). */
const signedBaseUnitString = z
  .string()
  .regex(/^-?\d+$/, "expected a signed base-unit integer string");

export const epochRowSchema = z.object({
  epoch_index: z.number().int().nonnegative(),
  ended_at: isoTimestamp,
  // null: an epoch settled with zero shares has no NAV. NAV is
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

// The §9.5.3 typical time-to-payout. Stats are null below the gates
// (the web tier then shows the guarantee alone); the band bounds are data.
export const payoutStatsSchema = z.object({
  sample_count: z.number().int().nonnegative(),
  median_seconds: z.number().int().nonnegative().nullable(),
  p90_seconds: z.number().int().nonnegative().nullable(),
  band_floor_seconds: z.number().int().nonnegative(),
  band_ceiling_seconds: z.number().int().nonnegative(),
  cold_start: z.boolean(),
}) satisfies z.ZodType<PayoutStats>;

// Owns /validators: ValidatorsPayload = per-validator rows (registry
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

// The /market shapes: market data has no chain-canonical plane, so the
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

// Personal surfaces (address-scoped /portfolio, /portfolio/metrics,
// /transactions). Amounts are base-unit integer strings; only realized_gain_nhash
// is signed (the accrual/marker legs are unsigned). Closed unions are pinned so
// an unknown wire variant is a shape error, not a guess. The redemption
// tracker consumes the same /portfolio (active redemptions) and /transactions
// (terminal payout/refund rows) shapes.
export const redemptionStatusSchema = z.enum([
  "enqueued",
  "expedited",
  "matured",
  "refunded",
]) satisfies z.ZodType<RedemptionStatus>;

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
]) satisfies z.ZodType<TransactionKind>;

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
  yield_by_epoch: z.array(effectiveYieldPointSchema).max(MAX_YIELD_POINTS_WIRE),
  yield_truncated: z.boolean(),
  accrual: z.array(accrualPointSchema).max(MAX_ACCRUAL_POINTS_WIRE),
  accrual_truncated: z.boolean(),
  accrual_markers: z.array(accrualMarkerSchema).max(MARKER_CAP_WIRE),
  markers_truncated: z.boolean(),
}) satisfies z.ZodType<PortfolioMetrics>;

// Operator surface (address-scoped /operator/{summary,epochs,payments}).
// Same posture as the personal shapes: amounts are base-unit integer
// strings, closed unions pinned, every field bounded. `epoch_index` on a
// payment is nullable BY DESIGN — the crediting epoch may still be open
// (app-spec §9.1/§9.4), and null must survive the boundary as null.
export const operatorPaymentTypeSchema = z.enum([
  "commission",
  "tip",
]) satisfies z.ZodType<OperatorPaymentType>;

export const operatorValidatorRowSchema = z.object({
  valoper: z.string().max(90),
  moniker: z.string().max(128),
  operator: z.string().max(90),
  active: z.boolean(),
  enrolled_at: isoTimestamp,
  unregistered_at: isoTimestamp.nullable(),
  epoch_index: z.number().int().nonnegative().nullable(),
  uptime_bps: z.number().int().min(0).max(1_000_000).nullable(),
  eligible: z.boolean().nullable(),
  failing_reasons: z.array(z.string().max(64)).max(32),
  program_delegation: baseUnitString.nullable(),
  tip: baseUnitString.nullable(),
  commission_accrued: baseUnitString.nullable(),
  commission_paid: baseUnitString.nullable(),
  commission_due: baseUnitString.nullable(),
  commission_paid_total: baseUnitString,
  tip_paid_total: baseUnitString,
  payment_count: z.number().int().nonnegative(),
}) satisfies z.ZodType<OperatorValidatorRow>;

export const operatorSummarySchema = z.object({
  address: z.string().max(90),
  validators: z.array(operatorValidatorRowSchema).max(500),
}) satisfies z.ZodType<OperatorSummary>;

export const operatorEpochRowSchema = z.object({
  valoper: z.string().max(90),
  epoch_index: z.number().int().nonnegative(),
  uptime_bps: z.number().int().min(0).max(1_000_000),
  eligible: z.boolean(),
  failing_reasons: z.array(z.string().max(64)).max(32),
  tip: baseUnitString,
  commission_accrued: baseUnitString,
  commission_paid: baseUnitString,
  commission_due: baseUnitString,
  program_delegation: baseUnitString,
  height: z.number().int().nonnegative(),
  observed_at: isoTimestamp,
}) satisfies z.ZodType<OperatorEpochRow>;

export const operatorPaymentRowSchema = z.object({
  txhash: z.string().max(64),
  msg_index: z.number().int().nonnegative(),
  valoper: z.string().max(90),
  payer: z.string().max(90),
  payment_type: operatorPaymentTypeSchema,
  amount: baseUnitString,
  epoch_index: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative(),
  occurred_at: isoTimestamp,
}) satisfies z.ZodType<OperatorPaymentRow>;

// Internal alert-facts (the notifier's `internal:notifier` reads). Bounded
// at the boundary like every other API input; amounts stay decimal strings.
// `commission_due` is the one amount that rides (arrears), a decimal string.
export const alertRedemptionFactSchema = z.object({
  request_id: z.string().max(128),
  owner: z.string().max(90),
  status: redemptionStatusSchema,
  enqueued_at: isoTimestamp,
  expedited_at: isoTimestamp.nullable(),
  matured_at: isoTimestamp.nullable(),
  refunded_at: isoTimestamp.nullable(),
  last_height: z.number().int().nonnegative(),
}) satisfies z.ZodType<AlertRedemptionFact>;

export const alertIncidentFactSchema = z.object({
  id: z.number().int().nonnegative(),
  kind: incidentKindSchema,
  severity: incidentSeveritySchema,
  dedupe_key: z.string().max(256),
  opened_at: isoTimestamp,
  opened_height: z.number().int().nonnegative().nullable(),
}) satisfies z.ZodType<AlertIncidentFact>;

export const alertArrearsFactSchema = z.object({
  valoper: z.string().max(90),
  operator: z.string().max(90),
  epoch_index: z.number().int().nonnegative(),
  commission_due: baseUnitString,
}) satisfies z.ZodType<AlertArrearsFact>;

// Governance mirror (public /governance/{proposals,proposal,policies}).
// Every array cap here IMPORTS its bound from `@nvhash/api-types/bounds.ts`
// rather than restating a number — a locally-written `.max(N)` on a governance
// array is the literal shape of that defect, and the pairing is asserted
// by `packages/api-types/test/bounds.test.ts` rather than by eye (C2).
//
// Weights and tally counts are UNBOUNDED integers in the protocol (sums of
// member weights, not token amounts), so they stay decimal strings and are never
// coerced to a number. The length cap below is a bound on the WIRE ENCODING —
// this tier will not accept an arbitrarily long string from the network — and is
// deliberately far past anything a real group can produce, so it is not a claim
// about the protocol's ceiling.
const weightString = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)$/, "expected a canonical unsigned integer string");

/** A `voting_period` / `min_execution_period` duration as x/group serves it. */
const durationString = z.string().max(32);

export const govProposalStatusSchema = z.enum([
  "submitted",
  "accepted",
  "rejected",
  "aborted",
  "withdrawn",
  "unspecified",
]) satisfies z.ZodType<GovProposalStatus>;

export const govExecutorResultSchema = z.enum([
  "not_run",
  "success",
  "failure",
  "unspecified",
]) satisfies z.ZodType<GovExecutorResult>;

export const govVoteOptionSchema = z.enum([
  "yes",
  "no",
  "abstain",
  "no_with_veto",
  "unspecified",
]) satisfies z.ZodType<GovVoteOption>;

export const govTallySchema = z.object({
  yes: weightString,
  no: weightString,
  abstain: weightString,
  no_with_veto: weightString,
}) satisfies z.ZodType<GovTally>;

/** The decision rule, closed on `kind`. The `unknown` arm is not defensive
 * padding: a policy type this build does not recognize must survive the
 * boundary so the page can say so, rather than nulling the whole read. */
export const govDecisionPolicySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("threshold"),
    threshold: weightString,
    voting_period: durationString,
    min_execution_period: durationString,
  }),
  z.object({
    kind: z.literal("percentage"),
    // A decimal FRACTION ("0.5"), not bps and not an integer.
    percentage: z.string().max(32),
    voting_period: durationString,
    min_execution_period: durationString,
  }),
  z.object({ kind: z.literal("unknown"), type_url: z.string().max(256) }),
]) satisfies z.ZodType<GovDecisionPolicy>;

/** u64 proposal id as a DECIMAL STRING — the JSON number domain stops at 2^53,
 * so a coerced number would silently accept a corrupted id. */
const proposalIdString = z
  .string()
  .max(20)
  .regex(/^(0|[1-9][0-9]*)$/, "expected a canonical u64 decimal string");

export const govProposalRowSchema = z.object({
  proposal_id: proposalIdString,
  group_policy_address: z.string().max(MAX_BECH32_LENGTH),
  group_id: z.string().max(20),
  proposers: z.array(z.string().max(MAX_BECH32_LENGTH)).max(MAX_GOV_PROPOSERS_WIRE),
  status: govProposalStatusSchema,
  executor_result: govExecutorResultSchema,
  title: z.string().max(MAX_GOV_TITLE_LENGTH),
  summary: z.string().max(MAX_GOV_SUMMARY_LENGTH),
  metadata: z.string().max(MAX_GOV_METADATA_LENGTH).nullable(),
  tally: govTallySchema,
  decision_policy: govDecisionPolicySchema,
  submit_time: isoTimestamp,
  voting_period_end: isoTimestamp,
  group_version: z.string().max(20),
  group_policy_version: z.string().max(20),
  observed_height: z.number().int().nonnegative(),
  observed_at: isoTimestamp,
  height: z.number().int().nonnegative().nullable(),
  txhash: z.string().max(MAX_TXHASH_LENGTH).nullable(),
  pruned_at_height: z.number().int().nonnegative().nullable(),
  messages_truncated: z.boolean(),
  proposers_truncated: z.boolean(),
  // Messages stay `unknown` on purpose: they are decoded against a closed union
  // in `app/governance/decode.ts`, and a schema that shaped them here would have
  // to either reject an unrecognized message (losing the proposal) or describe
  // it (inventing a meaning). Both are forbidden; carrying it verbatim is not.
  messages: z.array(z.unknown()).max(MAX_GOV_PROPOSAL_MESSAGES_WIRE),
}) satisfies z.ZodType<GovProposalRow>;

export const govVoteRowSchema = z.object({
  proposal_id: proposalIdString,
  voter: z.string().max(MAX_BECH32_LENGTH),
  option: govVoteOptionSchema,
  metadata: z.string().max(MAX_GOV_METADATA_LENGTH).nullable(),
  // Nullable because x/group's `Vote` carries NO weight field. Null survives the
  // boundary as null — a vote whose weight could not be recovered must never
  // read as a vote that counted for zero.
  weight: weightString.nullable(),
  submit_time: isoTimestamp,
  height: z.number().int().nonnegative().nullable(),
  txhash: z.string().max(MAX_TXHASH_LENGTH).nullable(),
}) satisfies z.ZodType<GovVoteRow>;

export const govProposalsPayloadSchema = z.object({
  proposals: z.array(govProposalRowSchema).max(MAX_GOV_PROPOSALS_PAGE_WIRE),
  indexed_from_height: z.number().int().nonnegative().nullable(),
}) satisfies z.ZodType<GovProposalsPayload>;

export const govProposalDetailSchema = z.object({
  proposal: govProposalRowSchema,
  votes: z.array(govVoteRowSchema).max(MAX_GOV_VOTES_PER_PROPOSAL_WIRE),
  votes_truncated: z.boolean(),
}) satisfies z.ZodType<GovProposalDetail>;

export const govPolicyRowSchema = z.object({
  address: z.string().max(MAX_BECH32_LENGTH),
  group_id: z.string().max(20),
  proposal_count: z.number().int().nonnegative(),
  last_seen_height: z.number().int().nonnegative(),
  decision_policy: govDecisionPolicySchema.nullable(),
}) satisfies z.ZodType<GovPolicyRow>;

export const govProposalsEnvelopeSchema = envelopeSchema(govProposalsPayloadSchema);
export const govProposalEnvelopeSchema = envelopeSchema(govProposalDetailSchema);
export const govPoliciesEnvelopeSchema = envelopeSchema(
  z.array(govPolicyRowSchema).max(MAX_GOV_POLICIES_WIRE),
);

/** The notifier caps its fact page at 500 (MAX_ALERT_FACT_LIMIT); bound here. */
export const alertRedemptionsEnvelopeSchema = envelopeSchema(
  z.array(alertRedemptionFactSchema).max(500),
);
export const alertIncidentsEnvelopeSchema = envelopeSchema(
  z.array(alertIncidentFactSchema).max(500),
);
export const alertArrearsEnvelopeSchema = envelopeSchema(z.array(alertArrearsFactSchema).max(500));

/** Collections stay bounded at the boundary, mirroring the API's page cap. */
export const incidentsEnvelopeSchema = envelopeSchema(z.array(incidentRowSchema).max(200));
export const epochsEnvelopeSchema = envelopeSchema(z.array(epochRowSchema).max(200));
export const validatorsEnvelopeSchema = envelopeSchema(validatorsPayloadSchema);
export const metricsEnvelopeSchema = envelopeSchema(programMetricsSchema);
export const marketEnvelopeSchema = envelopeSchema(marketSummarySchema);
export const payoutStatsEnvelopeSchema = envelopeSchema(payoutStatsSchema);
export const statusEnvelopeSchema = envelopeSchema(z.unknown());
export const portfolioEnvelopeSchema = envelopeSchema(portfolioSummarySchema);
export const portfolioMetricsEnvelopeSchema = envelopeSchema(portfolioMetricsSchema);
export const transactionsEnvelopeSchema = envelopeSchema(z.array(transactionRowSchema).max(200));
export const operatorSummaryEnvelopeSchema = envelopeSchema(operatorSummarySchema);
export const operatorEpochsEnvelopeSchema = envelopeSchema(
  z.array(operatorEpochRowSchema).max(200),
);
export const operatorPaymentsEnvelopeSchema = envelopeSchema(
  z.array(operatorPaymentRowSchema).max(200),
);

/**
 * Bounded-timeout GET returning parsed JSON. Throws on non-OK status,
 * timeout, or non-JSON; callers degrade the failure to their own null path.
 * `headers` carries the `internal:notifier` (or personal) assertion where a
 * route requires it; public reads pass none.
 */
export async function fetchApiJson(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers });
    if (!response.ok) {
      throw new Error(`GET ${url}: HTTP ${response.status}`);
    }
    return JSON.parse(await response.text()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

// §8.8 admin analytics (the `admin`-scoped reads). Same posture as every other
// boundary schema here: closed unions pinned, every collection capped by an
// IMPORTED bound, and nullability preserved exactly — a `null` that arrives as
// a withheld or unknown figure must not be coerced into a number on the way in.
//
// Note what is NOT in any of these schemas: an address field. The API does not
// send one on these routes by construction (plan invariant 12), and declaring
// none here means an address that somehow appeared would be dropped at the
// boundary rather than rendered.
export const adminHealthPointSchema = z.object({
  epoch_index: z.number().int().nonnegative(),
  ended_at: isoTimestamp,
  tvv: baseUnitString,
  net_apr_bps: z.number().int().min(-1_000_000).max(1_000_000).nullable(),
  // SIGNED: a net-outflow epoch is a real state (see AdminHealthPoint).
  net_deposits: signedBaseUnitString,
}) satisfies z.ZodType<AdminHealthPoint>;

export const adminProgramHealthSchema = z.object({
  depositor_count: z.number().int().nonnegative().nullable(),
  // The funnel's terminal stage, windowed. Nullable for the same reason
  // `depositor_count` is: "we could not count" is not "nobody deposited".
  first_deposits_in_window: z.number().int().nonnegative().nullable(),
  funnel_window_days: z.number().int().positive(),
  epochs: z.array(adminHealthPointSchema).max(MAX_ADMIN_EPOCH_POINTS_WIRE),
  epochs_truncated: z.boolean(),
}) satisfies z.ZodType<AdminProgramHealth>;

export const adminAdoptionPointSchema = z.object({
  epoch_index: z.number().int().nonnegative(),
  ended_at: isoTimestamp,
  new_depositors: z.number().int().nonnegative(),
}) satisfies z.ZodType<AdminAdoptionPoint>;

export const adminRetentionPointSchema = z.object({
  horizon: z.number().int().positive(),
  // Null means EITHER "the horizon has not elapsed" OR "withheld below the
  // minimum cohort" — `below_minimum` on the curve says which, so the panel can
  // give the right reason instead of one that might be wrong.
  retained_bps: z.number().int().min(0).max(10_000).nullable(),
}) satisfies z.ZodType<AdminRetentionPoint>;

export const adminRetentionCurveSchema = z.object({
  cohort_epoch: z.number().int().nonnegative(),
  cohort_size: z.number().int().nonnegative(),
  points: z.array(adminRetentionPointSchema).max(16),
  below_minimum: z.boolean(),
}) satisfies z.ZodType<AdminRetentionCurve>;

export const adminRedemptionMixSchema = z.object({
  enqueued: z.number().int().nonnegative(),
  expedited: z.number().int().nonnegative(),
  matured: z.number().int().nonnegative(),
  refunded: z.number().int().nonnegative(),
}) satisfies z.ZodType<AdminRedemptionMix>;

export const adminConcentrationSchema = z.object({
  top1_bps: z.number().int().min(0).max(10_000),
  top5_bps: z.number().int().min(0).max(10_000),
  top10_bps: z.number().int().min(0).max(10_000),
  holder_count: z.number().int().nonnegative(),
}) satisfies z.ZodType<AdminConcentration>;

export const adminHolderCohortsSchema = z.object({
  min_cohort_size: z.number().int().positive(),
  adoption: z.array(adminAdoptionPointSchema).max(MAX_ADMIN_EPOCH_POINTS_WIRE),
  adoption_truncated: z.boolean(),
  retention: z.array(adminRetentionCurveSchema).max(MAX_ADMIN_RETENTION_CURVES_WIRE),
  retention_truncated: z.boolean(),
  redemption_mix: adminRedemptionMixSchema,
  // Nullable: withheld entirely below the minimum holder count (§7.1 Q7).
  concentration: adminConcentrationSchema.nullable(),
}) satisfies z.ZodType<AdminHolderCohorts>;

export const adminValidatorPointSchema = z.object({
  epoch_index: z.number().int().nonnegative(),
  ended_at: isoTimestamp,
  sampled: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  in_arrears: z.number().int().nonnegative(),
  tip_paying: z.number().int().nonnegative(),
  purged: z.number().int().nonnegative(),
}) satisfies z.ZodType<AdminValidatorPoint>;

export const adminValidatorCohortsSchema = z.object({
  enrolled_now: z.number().int().nonnegative(),
  churned_total: z.number().int().nonnegative(),
  timeline: z.array(adminValidatorPointSchema).max(MAX_ADMIN_EPOCH_POINTS_WIRE),
  timeline_truncated: z.boolean(),
}) satisfies z.ZodType<AdminValidatorCohorts>;

export const adminUpkeepBucketSchema = z.object({
  from_seconds: z.number().int().nonnegative(),
  to_seconds: z.number().int().nonnegative().nullable(),
  count: z.number().int().nonnegative(),
}) satisfies z.ZodType<AdminUpkeepBucket>;

export const adminUpkeepDistributionSchema = z.object({
  sample_count: z.number().int().nonnegative(),
  median_seconds: z.number().int().nonnegative().nullable(),
  p90_seconds: z.number().int().nonnegative().nullable(),
  buckets: z.array(adminUpkeepBucketSchema).max(MAX_ADMIN_UPKEEP_BUCKETS_WIRE),
}) satisfies z.ZodType<AdminUpkeepDistribution>;

export const adminUpkeepTimelinessSchema = z.object({
  epoch_lag: adminUpkeepDistributionSchema,
  redemption_latency: adminUpkeepDistributionSchema,
  // Nullable and, in this build, always null: §8.8 names it but no
  // capture-signal series is indexed. The panel says so rather than showing an
  // empty histogram that would look measured.
  capture_cadence: adminUpkeepDistributionSchema.nullable(),
}) satisfies z.ZodType<AdminUpkeepTimeliness>;

export const adminIncidentRowSchema = z.object({
  id: z.number().int().nonnegative(),
  kind: incidentKindSchema,
  severity: incidentSeveritySchema,
  opened_at: isoTimestamp,
  closed_at: isoTimestamp.nullable(),
  height: z.number().int().nonnegative().nullable(),
}) satisfies z.ZodType<AdminIncidentRow>;

export const adminProgramHealthEnvelopeSchema = envelopeSchema(adminProgramHealthSchema);
export const adminHolderCohortsEnvelopeSchema = envelopeSchema(adminHolderCohortsSchema);
export const adminValidatorCohortsEnvelopeSchema = envelopeSchema(adminValidatorCohortsSchema);
export const adminUpkeepEnvelopeSchema = envelopeSchema(adminUpkeepTimelinessSchema);
export const adminIncidentsEnvelopeSchema = envelopeSchema(
  z.array(adminIncidentRowSchema).max(MAX_ADMIN_INCIDENTS_PAGE_WIRE),
);
