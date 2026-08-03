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

import {
  FUNNEL_RETENTION_DAYS,
  FUNNEL_STAGE_KEYS,
  MAX_FUNNEL_ROWS_TOTAL,
  type FunnelStageKey,
} from "@nvhash/api-types";

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

/**
 * The stored `FunnelStage` enum values, exactly as the migration declares them.
 *
 * IMPORTED from `@nvhash/api-types`, not declared here: the funnel's row ceiling
 * is `stages × retention days` and that product is stated there, so a stage list
 * restated in this file would be a second declaration of half a bound — two
 * numbers agreeing by luck until someone adds a stage. Re-exported so this
 * module stays the one import site for the funnel vocabulary.
 */
export { FUNNEL_STAGE_KEYS, type FunnelStageKey };

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
 * for year-over-year comparison, short enough to be a real bound. Declared in
 * `@nvhash/api-types` beside the stage list it multiplies against, recorded in
 * the schema's allowlist entry, and ENFORCED by the notifier tick's sweep — a
 * retention window nothing deletes is an aspiration, not a bound.
 */
export { FUNNEL_RETENTION_DAYS };

/**
 * The total row count the table can ever hold: stages × retention days, both
 * closed. C2 asks for the product to be stated rather than described, because
 * "bounded by two closed sets" is only reassuring if someone has multiplied it.
 * Derived from the two shared declarations, so adding a stage moves it.
 */
export { MAX_FUNNEL_ROWS_TOTAL as MAX_FUNNEL_ROWS };

/** The UTC day before which rows are swept, given `now`. */
export function funnelRetentionCutoff(now: Date): string {
  const cutoff = new Date(now.getTime() - FUNNEL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return utcDay(cutoff);
}
