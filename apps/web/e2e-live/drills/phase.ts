// The drill-phase gate (8.1 §2.6). The rule it enforces: a drill spec NEVER
// skips inside an active phase — a drill that skips is silence, and every
// drill must FAIL when the honesty machinery is silent. Skipping is sanctioned
// exactly twice: when no drill is being driven at all (E2E_DRILL_PHASE unset,
// so `test:e2e:live` stays runnable standalone), and when a different phase is
// active (its specs are not this file's subject). Inside the matching phase,
// an absent expected state is an ASSERTION FAILURE, never a skip — and
// infra/devnet/drills.sh additionally asserts a non-zero executed test count
// per phase, so a gate rewritten to skip goes red at the driver.

import { test } from "@playwright/test";

export const DRILL_PHASES = [
  "baseline",
  "corrupt-row",
  "repair",
  "indexer-kill",
  "indexer-recover",
  "lcd-kill",
  "lcd-recover",
  "bell",
] as const;

export type DrillPhase = (typeof DRILL_PHASES)[number];

/** The active drill phase, or undefined when no drill is being driven. */
export function activeDrillPhase(): string | undefined {
  const phase = process.env.E2E_DRILL_PHASE;
  return phase === undefined || phase === "" ? undefined : phase;
}

/**
 * Gate a describe/test block to one phase: skip clean when no drill runs or a
 * DIFFERENT phase is active; run (and let assertions fail loudly) when this
 * phase is the active one.
 */
export function onlyInPhase(phase: DrillPhase): void {
  const active = activeDrillPhase();
  test.skip(active === undefined, "E2E_DRILL_PHASE not set (driven by infra/devnet/drills.sh)");
  test.skip(
    active !== undefined && active !== phase,
    `drill phase '${active}' is active; these cases cover '${phase}'`,
  );
}
