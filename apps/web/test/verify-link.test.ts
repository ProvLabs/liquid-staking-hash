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
    // Paths confirmed against apps/console/src/App.tsx. `governance` joined
    // in PR 8.4b TOGETHER with the console's panel (the D8 pair rule) — the
    // former not.toContain("governance") assertion is INVERTED, not deleted:
    // the absence rule retired the day the panel shipped, and this equality
    // still fails any target added without its console path.
    expect(CONSOLE_VIEW_PATHS).toEqual({
      overview: "",
      "epoch-ops": "epoch",
      validators: "validators",
      redemptions: "redemptions",
      governance: "governance",
    });
    expect(TARGETS).toContain("governance");
  });
});

// ── Entity anchors (app-spec §14.13; grammar authority: console-spec §14
//    item 9). GOLDEN STRINGS cross-pinned with apps/console/test/anchors.test.ts
//    — the two codebases cannot share code, so both suites pin the same
//    strings and drift fails whichever side moved. ─────────────────────────

const CONSOLE = "https://console.example";
const VALOPER = "pbvaloper1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5z5tpwxqergd3c8g4vgu5rmfd7";

describe("verify-link entity anchors (§14.13)", () => {
  it("formats the four golden fragments", () => {
    expect(verifyHref(CONSOLE, "redemptions", { requestId: 7 })).toBe(
      `${CONSOLE}/redemptions#req-7`,
    );
    expect(verifyHref(CONSOLE, "validators", { valoper: VALOPER })).toBe(
      `${CONSOLE}/validators#val-${VALOPER}`,
    );
    expect(verifyHref(CONSOLE, "overview", { epochIndex: 12 })).toBe(`${CONSOLE}/#epoch-12`);
    expect(verifyHref(CONSOLE, "governance", { proposalId: "4" })).toBe(
      `${CONSOLE}/governance#prop-4`,
    );
  });

  it("an anchored href stays strictly under the console origin", () => {
    // Fragments append AFTER the path; the environment lock (§12.2) is
    // untouched — nothing an anchor value contains may escape the origin.
    for (const href of [
      verifyHref(CONSOLE, "redemptions", { requestId: 7 }),
      verifyHref(CONSOLE, "governance", { proposalId: "4" }),
      verifyHref(CONSOLE, "validators", { valoper: VALOPER }),
      verifyHref(CONSOLE, "overview", { epochIndex: 3 }),
    ]) {
      expect(new URL(href).origin).toBe(new URL(CONSOLE).origin);
      expect(href).not.toContain("..");
    }
  });

  it("a value outside the grammar yields the PLAIN href, never a malformed fragment", () => {
    // A page-level link is honest; a broken anchor string is not. These
    // values cannot arise from chain-derived callers, but the boundary is
    // bounded anyway (SECURITY.md: validate at the boundary).
    expect(verifyHref(CONSOLE, "governance", { proposalId: "4/evil" })).toBe(
      `${CONSOLE}/governance`,
    );
    expect(verifyHref(CONSOLE, "governance", { proposalId: "" })).toBe(`${CONSOLE}/governance`);
    expect(verifyHref(CONSOLE, "validators", { valoper: "UPPER#bad" })).toBe(
      `${CONSOLE}/validators`,
    );
    expect(verifyHref(CONSOLE, "redemptions", { requestId: Number.NaN })).toBe(
      `${CONSOLE}/redemptions`,
    );
    expect(verifyHref(CONSOLE, "overview", { epochIndex: -1 })).toBe(`${CONSOLE}/`);
  });

  it("no anchor argument means the plain view href, unchanged from pre-8.4b", () => {
    expect(verifyHref(CONSOLE, "redemptions")).toBe(`${CONSOLE}/redemptions`);
  });
});
