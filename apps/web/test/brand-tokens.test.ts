// Brand-token gate (app-spec §11 / §14.8 brand pass,
// security-executable layer). The categorical dataviz palette is gated by
// check-palette.mjs; the two brand-pass additions that script does not cover —
// the mint-green primary accent and the semantic UI status set — are gated
// here. Contrast is COMPUTED with the same shared method (validate_palette.js's
// `contrast`, the repo dataviz validator), never eyeballed or hardcoded, so a
// token edit that drops a CTA below AA or unthemes a status color fails CI.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { contrast } from "../scripts/validate_palette.js";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "app/theme/tokens.css"),
  "utf8",
);

/** A `--name: light-dark(#light, #dark)` token → its two hex values. */
function pair(name: string): { light: string; dark: string } {
  const m = css.match(
    new RegExp(`--${name}:\\s*light-dark\\(\\s*(#[0-9a-fA-F]{6})\\s*,\\s*(#[0-9a-fA-F]{6})\\s*\\)`),
  );
  const light = m?.[1];
  const dark = m?.[2];
  if (!light || !dark)
    throw new Error(`token --${name} not found as a light-dark(#hex, #hex) pair`);
  return { light: light.toLowerCase(), dark: dark.toLowerCase() };
}

/** A fixed `--name: #hex;` token → its single hex, asserting it is declared
 *  exactly once (never re-themed under a data-theme scope). */
function fixed(name: string): string {
  const all = [...css.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`, "g"))];
  expect(all.length, `--${name} must be declared exactly once (fixed, never themed)`).toBe(1);
  const hex = all[0]?.[1];
  if (!hex) throw new Error(`token --${name} not found as a fixed #hex`);
  return hex.toLowerCase();
}

const MODES = ["light", "dark"] as const;

describe("brand accent (primary CTA + focus ring)", () => {
  const background = pair("background");
  const primary = pair("primary");
  const primaryFg = pair("primary-foreground");
  const ring = pair("ring");

  for (const mode of MODES) {
    it(`${mode}: CTA label clears WCAG AA (>= 4.5:1) on the accent`, () => {
      expect(contrast(primaryFg[mode], primary[mode])).toBeGreaterThanOrEqual(4.5);
    });

    it(`${mode}: accent reads as a component vs the page (>= 3:1)`, () => {
      expect(contrast(primary[mode], background[mode])).toBeGreaterThanOrEqual(3.0);
    });

    it(`${mode}: focus ring is a visible indicator vs the page (>= 3:1)`, () => {
      expect(contrast(ring[mode], background[mode])).toBeGreaterThanOrEqual(3.0);
    });
  }
});

describe("semantic UI status set (fixed family, icon + label)", () => {
  // The fixed family values (dataviz reference palette). Status colors are
  // reserved for state and never re-tuned per theme.
  const FAMILY = {
    good: "#0ca30c",
    warning: "#fab219",
    serious: "#ec835a",
    critical: "#d03b3b",
  } as const;

  const background = pair("background");
  const tokens = Object.fromEntries(
    Object.keys(FAMILY).map((role) => [role, fixed(`status-${role}`)]),
  ) as Record<keyof typeof FAMILY, string>;

  it("matches the fixed family values, declared once each (never themed)", () => {
    expect(tokens).toEqual(FAMILY);
  });

  it("every status color clears 3:1 on the dark surface", () => {
    for (const [role, hex] of Object.entries(tokens)) {
      expect(contrast(hex, background.dark), `${role} on dark`).toBeGreaterThanOrEqual(3.0);
    }
  });

  it("the loud states (good, critical) clear 3:1 on the light surface", () => {
    // warning + serious are deliberately sub-3:1 on light: the mandatory
    // icon + label pairing (dataviz relief rule) is their mitigation, so they
    // are NOT asserted here — asserting it would contradict the design.
    expect(contrast(tokens.good, background.light), "good on light").toBeGreaterThanOrEqual(3.0);
    expect(contrast(tokens.critical, background.light), "critical on light").toBeGreaterThanOrEqual(
      3.0,
    );
  });
});
