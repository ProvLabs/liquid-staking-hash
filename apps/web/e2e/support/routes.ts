// Registry-derived page-route enumeration: a new page route joins the axe
// scan by existing; a dynamic segment without a binding fails
// test/a11y-routes.test.ts.

import routes from "../../app/routes";

/** One corpus-derived instance per `:param` route, keyed by full path under `:lang?`. */
export const DYNAMIC_BINDINGS: Record<string, string> = {
  "governance/:proposalId": "governance/4",
};

/** One entry of the route registry as `app/routes.ts` declares it. */
export interface RouteEntry {
  readonly path?: string;
  readonly index?: boolean;
  readonly file: string;
  readonly children?: readonly RouteEntry[];
}

/** All page paths under `:lang?` (nested children flattened, leading slash);
 * throws on a dynamic segment with no binding. `registry` defaults to the app's. */
export function pageRoutePaths(registry?: readonly RouteEntry[]): string[] {
  const entries = registry ?? (routes as unknown as readonly RouteEntry[]);
  const lang = entries.find((entry) => entry.path === ":lang?");
  if (lang?.children === undefined) {
    throw new Error("route registry: no :lang? subtree found — the enumeration contract broke");
  }
  return collectPagePaths(lang.children, "");
}

function collectPagePaths(entries: readonly RouteEntry[], prefix: string): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    const segment = entry.index === true ? "" : (entry.path ?? "");
    const joined = [prefix, segment].filter((part) => part !== "").join("/");
    if (entry.children !== undefined) {
      paths.push(...collectPagePaths(entry.children, joined));
      continue;
    }
    paths.push(`/${bindDynamic(joined)}`);
  }
  return paths;
}

function bindDynamic(path: string): string {
  if (!path.includes(":")) return path;
  const bound = DYNAMIC_BINDINGS[path];
  if (bound === undefined) {
    throw new Error(
      `route registry: dynamic page route '${path}' has no DYNAMIC_BINDINGS entry — ` +
        "bind a corpus-derived instance so it joins the axe scan",
    );
  }
  return bound;
}
