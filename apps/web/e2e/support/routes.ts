// Registry-derived page-route enumeration (8.3 §2.4): the axe matrix imports
// the app's OWN route registry instead of a hand-maintained list, so a new
// page route joins the scan by existing (nothing to forget), and a dynamic
// segment without a binding fails the unit pin (test/a11y-routes.test.ts) —
// never a silent drop from the scan.

import routes from "../../app/routes";

/**
 * Bindings for dynamic segments: one concrete, corpus-derived instance per
 * `:param` route. `/governance/4` is the existing choice with its recorded
 * rationale — the detail page has table, disclosure and time semantics the
 * list does not, and id 4 exists in the mirrored corpus.
 */
export const DYNAMIC_BINDINGS: Record<string, string> = {
  "governance/:proposalId": "governance/4",
};

interface RouteEntry {
  readonly path?: string;
  readonly index?: boolean;
  readonly file: string;
  readonly children?: readonly RouteEntry[];
}

/** The page paths under `:lang?` (default-locale form, leading slash).
 * Resource routes and healthz sit OUTSIDE `:lang?` and are excluded
 * structurally, not by list. Throws on a dynamic segment with no binding so
 * the unit pin (and any scan importing this) fails loudly. */
export function pageRoutePaths(): string[] {
  const entries = routes as unknown as readonly RouteEntry[];
  const lang = entries.find((entry) => entry.path === ":lang?");
  if (lang?.children === undefined) {
    throw new Error("route registry: no :lang? subtree found — the enumeration contract broke");
  }
  return lang.children.map((child) => {
    if (child.index === true) return "/";
    const path = child.path ?? "";
    if (path.includes(":")) {
      const bound = DYNAMIC_BINDINGS[path];
      if (bound === undefined) {
        throw new Error(
          `route registry: dynamic page route '${path}' has no DYNAMIC_BINDINGS entry — ` +
            "bind a corpus-derived instance so it joins the axe scan",
        );
      }
      return `/${bound}`;
    }
    return `/${path}`;
  });
}
