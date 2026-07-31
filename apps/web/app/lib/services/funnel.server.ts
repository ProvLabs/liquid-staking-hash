// The funnel-counter vocabulary and key mapping (app-spec §8.8, §14.10) —
// PURE: no Prisma, no fetch, no clock (the layering rule). Persistence and the
// swallow-on-failure policy live in app/lib/models/funnel-counters.server.ts.
//
// THE POINT OF THIS MODULE is the shape of `FunnelEvent`. §14.10 forbids
// keying a counter by wallet, session or device, and the allowlist gate
// enforces that on the SCHEMA. This type enforces it on the CALL: an event
// carries a closed stage and, for `visit`, a closed page class — and nothing
// else. There is no parameter through which an address, a request, a header or
// a session id could reach the counter, so the mistake is not available rather
// than merely forbidden (plan invariant 7).
//
// The stored key folds the page class into the stage, because
// `FunnelCounter`'s columns are pinned at exactly {stage, day, count}. Keeping
// the two separate HERE and joined only at the storage boundary is what lets a
// caller be unable to attach a page class to a stage that has none.

/** Page classes, one per counted route. Closed (plan §7.1 Q3). */
export type FunnelPageClass = "learn_index" | "validators" | "market";

/**
 * A countable funnel event. A discriminated union rather than
 * `(stage, pageClass?)`, so `{ stage: "connect", pageClass: "market" }` is a
 * type error instead of a row nobody can interpret.
 *
 * `first_deposit` is absent: the funnel's terminal stage is derived from public
 * chain history (§14.10), never incremented from web behavior.
 */
export type FunnelEvent =
  | { readonly stage: "visit"; readonly pageClass: FunnelPageClass }
  /** Loaded a program-evidence surface — the server-observable form of
   * §8.1.7's "due-diligence sections". Scroll depth is not measurable without
   * a client script and is not claimed. */
  | { readonly stage: "due_diligence_depth" }
  | { readonly stage: "connect" };

/** The stored `FunnelStage` enum values, exactly as the migration declares them. */
export const FUNNEL_STAGE_KEYS = [
  "visit_learn_index",
  "visit_validators",
  "visit_market",
  "due_diligence_depth",
  "connect",
] as const;

export type FunnelStageKey = (typeof FUNNEL_STAGE_KEYS)[number];

/** The `visit` stage's page class → stored key. Total by type, so a new page
 * class without a key is a compile error rather than a dropped count. */
const VISIT_STAGE_KEY: Record<FunnelPageClass, FunnelStageKey> = {
  learn_index: "visit_learn_index",
  validators: "visit_validators",
  market: "visit_market",
};

/**
 * Map an event to its stored stage key. The non-`visit` stages ARE their keys;
 * only `visit` folds a page class in.
 */
export function funnelStageKey(event: FunnelEvent): FunnelStageKey {
  return event.stage === "visit" ? VISIT_STAGE_KEY[event.pageClass] : event.stage;
}

/**
 * The UTC calendar day `at` falls on, as `YYYY-MM-DD`.
 *
 * UTC explicitly (plan §7.1 Q5): a local-time day would make the series
 * silently discontinuous across a DST boundary — one 23-hour day and one
 * 25-hour day, presented as if they were comparable.
 */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Retention: day rows older than this are swept (plan §7.1 Q4). Long enough
 * for year-over-year comparison, short enough to be a real bound. Stated here
 * and in the schema's allowlist entry, and ENFORCED by the notifier tick's
 * sweep — a retention window nothing deletes is an aspiration, not a bound.
 */
export const FUNNEL_RETENTION_DAYS = 400;

/**
 * The total row count the table can ever hold: stages × retention days, both
 * closed. C2 asks for the product to be stated rather than described, because
 * "bounded by two closed sets" is only reassuring if someone has multiplied it.
 */
export const MAX_FUNNEL_ROWS = FUNNEL_STAGE_KEYS.length * FUNNEL_RETENTION_DAYS;

/** The UTC day before which rows are swept, given `now`. */
export function funnelRetentionCutoff(now: Date): string {
  const cutoff = new Date(now.getTime() - FUNNEL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return utcDay(cutoff);
}
