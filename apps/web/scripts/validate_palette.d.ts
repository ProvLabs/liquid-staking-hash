// Types for the shared dataviz validator (validate_palette.js) so the TS gates
// (test/brand-tokens.test.ts) can consume its `contrast` helper without
// reimplementing the WCAG math. The .js stays the single source of the method.

type Mode = "light" | "dark";
type Report = { report: Array<[string, unknown, string]>; ok: boolean };

/** WCAG relative-luminance contrast ratio between two `#rrggbb` colors. */
export function contrast(a: string, b: string): number;

export function validate(
  palette: string[],
  opts?: { mode?: Mode; surface?: string; pairs?: "adjacent" | "all" },
): Report;

export function validateOrdinal(
  palette: string[],
  opts?: { mode?: Mode; surface?: string },
): Report;
