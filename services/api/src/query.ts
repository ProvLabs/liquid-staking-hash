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

/** Convert a URLSearchParams into a plain record for zod parsing (last wins). */
export function searchParamsToRecord(params: URLSearchParams): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of params) record[key] = value;
  return record;
}
