// Verify-link gate (app-spec §12.2): every target in the CLOSED
// VerifyTarget union resolves to an href strictly prefixed by the booted
// consoleUrl (whose chain id the boot check proved matches ours), and the
// figure→view map is total; a target without a path is a compile error via
// the `satisfies` in app/components/verify-link.tsx.

import { describe, expect, it } from "vitest";

import { CONSOLE_VIEW_PATHS, verifyHref, type VerifyTarget } from "~/components/verify-link";

const TARGETS = Object.keys(CONSOLE_VIEW_PATHS) as VerifyTarget[];

describe("verify links (§12.2 environment lock)", () => {
  it("covers a non-empty closed target set", () => {
    // The union is closed by the type; this guards the runtime map against
    // accidentally becoming empty in a refactor.
    expect(TARGETS.length).toBeGreaterThanOrEqual(4);
  });

  it.each(TARGETS)("target %s resolves strictly under the booted console origin", (target) => {
    const consoleUrl = "https://console.example";
    const href = verifyHref(consoleUrl, target);
    expect(href.startsWith(`${consoleUrl}/`)).toBe(true);
    // Nothing may escape the origin: no scheme swap, no protocol-relative
    // trick, no traversal out of the console's own addressing.
    expect(href).not.toContain("..");
    expect(new URL(href).origin).toBe(new URL(consoleUrl).origin);
  });

  it.each(TARGETS)("target %s tolerates a trailing-slash console origin", (target) => {
    const href = verifyHref("https://console.example/", target);
    expect(href.startsWith("https://console.example/")).toBe(true);
    // No doubled slash may survive normalization (scheme's :// excepted).
    expect(href).not.toMatch(/[^:]\/\//);
  });

  it("maps each figure family to its confirmed console view", () => {
    // Paths confirmed against apps/console/src/App.tsx. `governance`
    // is deliberately absent until the console grows that panel.
    expect(CONSOLE_VIEW_PATHS).toEqual({
      overview: "",
      "epoch-ops": "epoch",
      validators: "validators",
      redemptions: "redemptions",
    });
    expect(TARGETS).not.toContain("governance");
  });
});
