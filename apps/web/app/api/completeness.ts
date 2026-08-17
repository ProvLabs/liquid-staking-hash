// The tri-state a wire truncation flag maps to on a view model (C4 of the
// 8.0b plan): the flag is `.optional()` on the web schemas for deploy skew,
// and an ABSENT flag is an older producer — unknown, never "not truncated".
// Carrying the third state in the type forces every consumer to handle it;
// the conservative treatment is to withhold the completeness claim, never to
// display partial data as the whole. Client-safe (pure, zero-dependency).

/** Whether a served collection is the whole set, a flagged prefix of it, or
 * of unknown totality (older producer that ships no flag). */
export type Completeness = "complete" | "partial" | "unknown";

/** Map a wire `*_truncated` flag to the view-model tri-state. */
export function completenessOf(truncated: boolean | undefined): Completeness {
  if (truncated === undefined) return "unknown";
  return truncated ? "partial" : "complete";
}
