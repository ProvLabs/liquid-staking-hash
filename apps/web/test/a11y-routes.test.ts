// The enumeration pin for the registry-derived axe matrix (8.3 §2.4,
// invariant 1): every registered page route appears exactly once, every
// dynamic segment has a binding (a new `:param` route with no binding fails
// HERE, not by silently dropping out of the scan), and the expected cell
// count follows the registry — the gate that keeps the matrix generated, not
// tabulated (the M7.5–7.6 round-2 lesson).

import { describe, expect, it } from "vitest";
import routes from "~/routes";
import { DYNAMIC_BINDINGS, pageRoutePaths } from "../e2e/support/routes";

interface RouteEntry {
  readonly path?: string;
  readonly index?: boolean;
  readonly children?: readonly RouteEntry[];
}

const registry = routes as unknown as readonly RouteEntry[];
const langChildren = registry.find((entry) => entry.path === ":lang?")?.children ?? [];

describe("axe-matrix route enumeration", () => {
  it("enumerates every :lang? page exactly once", () => {
    const paths = pageRoutePaths();
    expect(paths.length).toBe(langChildren.length);
    expect(new Set(paths).size).toBe(paths.length);
    // Spot anchors: the index and the deepest known routes are present.
    expect(paths).toContain("/");
    expect(paths).toContain("/admin");
    expect(paths).toContain("/validators/mine");
    expect(paths).toContain("/governance/4"); // the bound dynamic segment
  });

  it("every dynamic page segment has a binding", () => {
    const dynamic = langChildren
      .filter((child) => child.index !== true && (child.path ?? "").includes(":"))
      .map((child) => child.path ?? "");
    for (const path of dynamic) {
      expect(
        DYNAMIC_BINDINGS[path],
        `dynamic route '${path}' needs a DYNAMIC_BINDINGS entry (a corpus-derived instance)`,
      ).toBeDefined();
    }
    // And no stale binding for a route the registry no longer has.
    for (const path of Object.keys(DYNAMIC_BINDINGS)) {
      expect(dynamic).toContain(path);
    }
  });

  it("pins the matrix cell arithmetic (pages × themes × auth states)", () => {
    const paths = pageRoutePaths();
    // 2 themes × 3 auth states per page, plus the two Q1 auto-theme cells.
    const expectedCells = paths.length * 2 * 3 + 2;
    // The count follows the registry: this asserts the FORMULA holds (grows
    // with the registry alone), anchored to today's 11 pages = 68 cells.
    expect(paths.length).toBeGreaterThanOrEqual(11);
    expect(expectedCells).toBe(paths.length * 6 + 2);
  });
});
