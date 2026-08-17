// The drill-phase gate: a drill spec never skips inside its active phase —
// an absent expected state is an assertion failure. Skipping is sanctioned
// only when E2E_DRILL_PHASE is unset or names a different phase.

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
