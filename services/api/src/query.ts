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
  .regex(/^[a-z]{1,10}1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,83}$/, "must be a bech32 account address");

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
 * Hard ceiling on an internal alert-facts page (M6.2). Higher than the public
 * page limit because the notifier scans a bounded fact stream per tick, but
 * still a firm bound — an internal caller may not request an unbounded scan
 * (SECURITY.md: bound every query param; the cursor is efficiency, the bound
 * is safety).
 */
export const MAX_ALERT_FACT_LIMIT = 500;
/** Default alert-facts page size (matches the notifier's `NOTIFIER_FACT_LIMIT`). */
export const DEFAULT_ALERT_FACT_LIMIT = 200;

/**
 * `GET /internal/alert-facts/redemptions` query: a height cursor + bounded
 * page. `since_height` selects rows whose last lifecycle height exceeds the
 * notifier's cursor; the cursor is an efficiency device, and the notifier's
 * unique constraint absorbs any re-scan (plan §2.1).
 */
export const alertRedemptionsQuerySchema = z.object({
  since_height: z.coerce.number().int().min(0).default(0),
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
