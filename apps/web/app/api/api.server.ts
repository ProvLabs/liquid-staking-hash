// Shared services/api transport + boundary validation for the web tier
// (extracted from chrome.server.ts in PR 4.2; consumers: chrome.server.ts,
// learn.server.ts). @nvhash/api-types ships the shapes but, deliberately
// zero-dep, no untrusted-input parser; the zod schemas here are this tier's
// boundary validation (SECURITY.md: inputs validated and bounded at entry).
// Every schema is pinned to its shared shape with `satisfies`, so drift
// between producer and consumer is a type error, not a runtime surprise.

import type {
  EpochRow,
  FreshnessMeta,
  IncidentKind,
  IncidentRow,
  IncidentSeverity,
  ProgramMetrics,
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

export const epochRowSchema = z.object({
  epoch_index: z.number().int().nonnegative(),
  ended_at: isoTimestamp,
  nav: decimalString,
  tvv: decimalString,
  net_apr_bps: z.number().int().min(-1_000_000).max(1_000_000).nullable(),
}) satisfies z.ZodType<EpochRow>;

export const programMetricsSchema = z.object({
  participant_count: z.number().int().nonnegative().nullable(),
  program_started_at: isoTimestamp.nullable(),
  epoch_count: z.number().int().nonnegative().nullable(),
}) satisfies z.ZodType<ProgramMetrics>;

/** Collections stay bounded at the boundary, mirroring the API's page cap. */
export const incidentsEnvelopeSchema = envelopeSchema(z.array(incidentRowSchema).max(200));
export const epochsEnvelopeSchema = envelopeSchema(z.array(epochRowSchema).max(200));
export const metricsEnvelopeSchema = envelopeSchema(programMetricsSchema);
export const statusEnvelopeSchema = envelopeSchema(z.unknown());

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
