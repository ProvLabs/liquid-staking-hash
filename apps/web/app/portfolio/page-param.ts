// The Portfolio `?page=` boundary (app-spec §8.2; SECURITY.md: validate and
// bound at entry, reject never clamp). Absent -> page 0; a present value must
// be a plain non-negative integer string within [0, MAX_PAGE], else a 400.
// Kept off `z.coerce`, which silently turns an empty string into 0.

export const MAX_PAGE = 10_000;

/** Parse `?page=`; throws a 400 Response on malformed or out-of-range input. */
export function parsePageParam(raw: string | null): number {
  if (raw === null) return 0;
  if (!/^\d+$/.test(raw)) throw new Response("invalid page", { status: 400 });
  const page = Number(raw);
  if (!Number.isSafeInteger(page) || page < 0 || page > MAX_PAGE) {
    throw new Response("invalid page", { status: 400 });
  }
  return page;
}
