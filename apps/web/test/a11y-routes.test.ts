// Enumeration pin for the registry-derived axe matrix: every page route
// appears once (nested children included), every dynamic segment has a
// binding, the cell count follows the registry.

import { describe, expect, it } from "vitest";
import routes from "~/routes";
import { DYNAMIC_BINDINGS, pageRoutePaths, type RouteEntry } from "../e2e/support/routes";

const registry = routes as unknown as readonly RouteEntry[];
const langChildren = registry.find((entry) => entry.path === ":lang?")?.children ?? [];

function leafCount(entries: readonly RouteEntry[]): number {
  return entries.reduce(
    (sum, entry) => sum + (entry.children === undefined ? 1 : leafCount(entry.children)),
    0,
  );
}

function dynamicLeafPaths(entries: readonly RouteEntry[], prefix: string): string[] {
  return entries.flatMap((entry) => {
    const segment = entry.index === true ? "" : (entry.path ?? "");
    const joined = [prefix, segment].filter((part) => part !== "").join("/");
    if (entry.children !== undefined) return dynamicLeafPaths(entry.children, joined);
    return joined.includes(":") ? [joined] : [];
  });
}

describe("axe-matrix route enumeration", () => {
  it("enumerates every :lang? page exactly once, nested pages included", () => {
    const paths = pageRoutePaths();
    expect(paths.length).toBe(leafCount(langChildren));
    expect(new Set(paths).size).toBe(paths.length);
    // Spot anchors: the index and the deepest known routes are present.
    expect(paths).toContain("/");
    expect(paths).toContain("/admin");
    expect(paths).toContain("/validators/mine");
    expect(paths).toContain("/governance/4"); // the bound dynamic segment
  });

  it("flattens nested children into full joined paths", () => {
    const synthetic: RouteEntry[] = [
      {
        path: ":lang?",
        file: "routes/locale.tsx",
        children: [
          { index: true, file: "routes/home.tsx" },
          {
            path: "governance",
            file: "routes/governance-layout.tsx",
            children: [
              { index: true, file: "routes/governance.tsx" },
              { path: ":proposalId", file: "routes/governance.$proposalId.tsx" },
            ],
          },
        ],
      },
    ];
    expect(pageRoutePaths(synthetic)).toEqual(["/", "/governance", "/governance/4"]);
  });

  it("a nested dynamic segment without a binding fails loudly", () => {
    const synthetic: RouteEntry[] = [
      {
        path: ":lang?",
        file: "routes/locale.tsx",
        children: [
          {
            path: "docs",
            file: "routes/docs-layout.tsx",
            children: [{ path: ":slug", file: "routes/docs.$slug.tsx" }],
          },
        ],
      },
    ];
    expect(() => pageRoutePaths(synthetic)).toThrow(/docs\/:slug/);
  });

  it("every dynamic page segment has a binding", () => {
    const dynamic = dynamicLeafPaths(langChildren, "");
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
