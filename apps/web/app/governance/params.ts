// The `/governance` route boundaries (SECURITY.md: validate and bound every
// input at entry — REJECT, never clamp). The `portfolio/page-param.ts`
// precedent, and deliberately off `z.coerce`, which silently turns an empty
// string into 0.

import type { GovProposalStatus } from "@nvhash/api-types";

/** The closed wire union, as `services/api`'s `?status=` filter accepts it. A
 * value outside it is a 400 here rather than a forwarded request: the API would
 * reject it too, and a 400 that arrives from upstream is indistinguishable from
 * a deliberate rejection (M6.4's `VALOPER_PATHS` lesson). */
export const GOV_STATUS_FILTERS: readonly GovProposalStatus[] = [
  "submitted",
  "accepted",
  "rejected",
  "aborted",
  "withdrawn",
  "unspecified",
];

/** Parse `?status=`; absent → null (all). Throws a 400 Response otherwise. */
export function parseStatusParam(raw: string | null): GovProposalStatus | null {
  if (raw === null || raw === "") return null;
  if (!(GOV_STATUS_FILTERS as readonly string[]).includes(raw)) {
    throw new Response("invalid status", { status: 400 });
  }
  return raw as GovProposalStatus;
}

/**
 * Parse the `:proposalId` path segment.
 *
 * x/group ids are uint64 and the JSON number domain stops at 2^53, so this stays
 * a canonical DECIMAL STRING: bounded to uint64's 20-digit width, no leading
 * zeros (one proposal must not be addressable by two spellings), and never
 * coerced to a number. Same shape the API's own `id` query param enforces.
 */
export function parseProposalIdParam(raw: string | undefined): string {
  if (raw === undefined || raw.length > 20 || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Response("invalid proposal id", { status: 400 });
  }
  return raw;
}
