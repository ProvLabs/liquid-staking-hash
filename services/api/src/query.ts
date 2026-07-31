// Shared, bounded query-param schemas (SECURITY.md: "validate and bound all
// query parameters"; app-spec §9.4). Every route parses its query string
// through a zod schema so out-of-range input is rejected with 400 at the
// boundary — never clamped silently, never trusted. Pagination is the pattern
// every collection route inherits from the scaffold onward.

import { z } from "zod";

/** Hard ceiling on page size — a request may not ask for an unbounded scan. */
export const MAX_PAGE_LIMIT = 200;
/** Default page size when `limit` is omitted. */
export const DEFAULT_PAGE_LIMIT = 50;
/** Bound on `offset` so pagination cannot request an absurd skip. */
export const MAX_PAGE_OFFSET = 1_000_000;

/**
 * `?limit=&offset=` with defaults and hard bounds. `z.coerce` turns the raw
 * string query value into a number; `.int()` rejects fractional input; the
 * min/max reject out-of-range values (400) rather than clamping.
 */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).max(MAX_PAGE_OFFSET).default(0),
});

export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Bech32 account address, bounded at the boundary (SECURITY.md: "pagination
 * limits, address formats"): lowercase HRP, the `1` separator, and the
 * bech32 data charset (no `b`/`i`/`o`/`1`), within the spec's 90-char
 * ceiling. Deliberately NOT a checksum verification — a well-formed address
 * that doesn't exist simply matches no rows — but malformed input (path
 * fragments, SQL-ish strings, mixed case) is rejected with 400 before any
 * read runs.
 */
export const bech32AddressSchema = z
  .string()
  .max(90)
  .regex(
    /^[a-z]{1,10}1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,83}$/,
    "must be a bech32 account address",
  );

/**
 * Bech32 VALIDATOR-operator address (`…valoper1…`), bounded at the boundary
 * like `bech32AddressSchema` but requiring the `valoper` HRP suffix, so an
 * account address can never be passed where a valoper is meant. Same posture:
 * shape only, no checksum — a well-formed valoper the address does not operate
 * simply resolves to nothing (honest-empty), while malformed input is rejected
 * with 400 before any read runs.
 */
export const bech32ValoperSchema = z
  .string()
  .max(90)
  .regex(
    /^[a-z]{1,10}valoper1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,83}$/,
    "must be a bech32 valoper address",
  );

/** `GET /portfolio` query: the target address only. */
export const portfolioQuerySchema = z.object({
  address: bech32AddressSchema,
});

/** `GET /transactions` query: target address + pagination + output format. */
export const transactionsQuerySchema = z.object({
  address: bech32AddressSchema,
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).max(MAX_PAGE_OFFSET).default(0),
  format: z.enum(["json", "csv"]).default("json"),
});

export type TransactionsQuery = z.infer<typeof transactionsQuerySchema>;

/**
 * Operator-surface queries. `address` is the assertion target the
 * handler's scope check compares against — it is what makes these `auth:
 * "address"` routes enforceable. `valoper` is then checked for OWNERSHIP by the
 * handler against `validator_registry.operator`; the schema only bounds its
 * shape.
 */
export const operatorSummaryQuerySchema = z.object({
  address: bech32AddressSchema,
});

export const operatorEpochsQuerySchema = z.object({
  address: bech32AddressSchema,
  valoper: bech32ValoperSchema,
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).max(MAX_PAGE_OFFSET).default(0),
});

export type OperatorEpochsQuery = z.infer<typeof operatorEpochsQuerySchema>;

/** As above plus `format`: `csv` serves the COMPLETE payment history (the 6.1
 * precedent — a statement of fact is never a paginated slice), so `limit`/
 * `offset` bound only the JSON view. */
export const operatorPaymentsQuerySchema = z.object({
  address: bech32AddressSchema,
  valoper: bech32ValoperSchema,
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).max(MAX_PAGE_OFFSET).default(0),
  format: z.enum(["json", "csv"]).default("json"),
});

export type OperatorPaymentsQuery = z.infer<typeof operatorPaymentsQuerySchema>;

/**
 * Hard ceiling on an internal alert-facts page. Higher than the public
 * page limit because the notifier scans a bounded fact stream per tick, but
 * still a firm bound — an internal caller may not request an unbounded scan
 * (SECURITY.md: bound every query param; the cursor is efficiency, the bound
 * is safety).
 */
export const MAX_ALERT_FACT_LIMIT = 500;
/** Default alert-facts page size (matches the notifier's `NOTIFIER_FACT_LIMIT`). */
export const DEFAULT_ALERT_FACT_LIMIT = 200;

/**
 * `GET /internal/alert-facts/redemptions` query: a compound keyset cursor +
 * bounded page — rows `(lastHeight, requestId) > (since_height, after_id)` in
 * `(lastHeight asc, requestId asc)` page order. `after_id` tie-breaks WITHIN
 * `since_height`, so a burst of same-height transitions larger than one page —
 * e.g. mass maturation at an epoch settlement — pages through completely
 * instead of being skipped by a strictly-greater height cursor. An empty
 * `after_id` therefore INCLUDES the boundary height's rows (a re-scan the
 * notifier's unique constraint absorbs — the cursor is an efficiency device,
 * the notifier's unique constraint is the correctness).
 */
export const alertRedemptionsQuerySchema = z.object({
  since_height: z.coerce.number().int().min(0).default(0),
  /** requestId tie-break at `since_height`; empty = the whole height is new. */
  after_id: z.string().max(128).default(""),
  limit: z.coerce.number().int().min(1).max(MAX_ALERT_FACT_LIMIT).default(DEFAULT_ALERT_FACT_LIMIT),
});

export type AlertRedemptionsQuery = z.infer<typeof alertRedemptionsQuerySchema>;

/** `GET /internal/alert-facts/incidents` query: an id cursor + bounded page. */
export const alertIncidentsQuerySchema = z.object({
  since_id: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_ALERT_FACT_LIMIT).default(DEFAULT_ALERT_FACT_LIMIT),
});

export type AlertIncidentsQuery = z.infer<typeof alertIncidentsQuerySchema>;

/** Convert a URLSearchParams into a plain record for zod parsing (last wins). */
export function searchParamsToRecord(params: URLSearchParams): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of params) record[key] = value;
  return record;
}

/**
 * Governance query schemas. Every param bounded at the entry
 * boundary — out-of-range input is REJECTED with 400, never clamped
 * (SECURITY.md: a value that cannot be bounded safely is an error).
 *
 * `id` is a u64 DECIMAL STRING, not a coerced number: x/group proposal ids are
 * uint64 and the JSON number domain stops at 2^53, so coercing here would
 * silently accept a corrupted id. Bounded to 20 digits (uint64's decimal width)
 * and validated as canonical — no leading zeros, so one proposal cannot be
 * addressed by two spellings.
 */
export const govProposalQuerySchema = z.object({
  id: z
    .string()
    .max(20)
    .regex(/^(0|[1-9][0-9]*)$/, "must be a canonical u64 decimal string"),
});

export type GovProposalQuery = z.infer<typeof govProposalQuerySchema>;

/** Proposal statuses accepted as a `?status=` filter — the closed wire union.
 * `unspecified` is filterable too: a proposal whose status this build does not
 * recognize is still a row someone may need to find. */
export const GOV_STATUS_FILTERS = [
  "submitted",
  "accepted",
  "rejected",
  "aborted",
  "withdrawn",
  "unspecified",
] as const;

/**
 * `GET /governance/proposals` — pagination plus two optional filters. Both are
 * shape-bounded only: a well-formed policy address that matches no rows resolves
 * to honest-empty, while malformed input is rejected before any read runs.
 */
export const govProposalsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).max(MAX_PAGE_OFFSET).default(0),
  policy: bech32AddressSchema.optional(),
  status: z.enum(GOV_STATUS_FILTERS).optional(),
});

export type GovProposalsQuery = z.infer<typeof govProposalsQuerySchema>;
