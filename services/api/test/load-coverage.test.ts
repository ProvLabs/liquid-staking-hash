// Registry ↔ load-scenario coverage (8.2 invariant 7): a route added to
// routes.ts without a load-suite scenario fails HERE, in unit CI — the
// registry-derived-harness idiom (api-design-notes) applied to the load
// suite. The manifest is the suite's own declaration of which scenario owns
// which route; the scenario files live in infra/load/ and are k6 JS, so this
// test checks the map and the files' existence, not k6 semantics.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { API_BASE, routes } from "../src/routes.ts";

const loadDir = resolve(__dirname, "../../../infra/load");
const manifest = JSON.parse(readFileSync(join(loadDir, "manifest.json"), "utf8")) as {
  routes: Record<string, string>;
};

describe("load-suite coverage of the route registry", () => {
  it("every registered route has a scenario in the manifest", () => {
    const uncovered = routes
      .map((route) => route.path.slice(API_BASE.length))
      .filter((path) => !(path in manifest.routes));
    expect(
      uncovered,
      `routes with no load scenario (add them to infra/load/manifest.json AND a scenario file): ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  it("the manifest names no route the registry lacks (no fiction)", () => {
    const registered = new Set(routes.map((route) => route.path.slice(API_BASE.length)));
    const stale = Object.keys(manifest.routes).filter((path) => !registered.has(path));
    expect(stale, `manifest rows for unregistered routes: ${stale.join(", ")}`).toEqual([]);
  });

  it("every named scenario file exists", () => {
    const scenarios = new Set(Object.values(manifest.routes));
    for (const scenario of scenarios) {
      expect(
        existsSync(join(loadDir, `${scenario}.js`)),
        `infra/load/${scenario}.js is named by the manifest but does not exist`,
      ).toBe(true);
    }
  });
});
