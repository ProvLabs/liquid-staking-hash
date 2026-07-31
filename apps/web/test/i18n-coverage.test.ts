// i18n coverage (placeholder gate added after the
// "exit.native-typical-withheld" {days} regression): every locale catalog
// carries exactly the reference (`en`) key set, every `t(locale, "key")` call
// site in app code references a defined key, and every message's
// {placeholders} are satisfied by the params supplied at each call site. A
// missing translation or an unsubstituted placeholder fails CI, not a user.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { catalogs, SUPPORTED_LOCALES } from "~/i18n";
import en from "~/i18n/locales/en";

const APP_DIR = join(__dirname, "../app");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

describe("i18n key coverage", () => {
  const enKeys = Object.keys(en).sort();

  it("reference catalog is non-empty with well-formed keys", () => {
    expect(enKeys.length).toBeGreaterThan(0);
    for (const key of enKeys) expect(key).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  });

  it("every supported locale carries exactly the en key set", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(catalogs[locale]).sort(), `locale "${locale}"`).toEqual(enKeys);
    }
  });

  it("every t() call site in app code uses a defined key", () => {
    const usage = new Map<string, string[]>();
    for (const file of sourceFiles(APP_DIR)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bt\(\s*[^,()]+,\s*["']([^"']+)["']\s*[,)]/g)) {
        const key = match[1]!;
        usage.set(key, [...(usage.get(key) ?? []), file]);
      }
    }
    // Guard the scanner itself: if the regex rots and finds nothing, fail.
    expect(usage.size, "expected t() call sites in app code").toBeGreaterThan(0);
    for (const [key, files] of usage) {
      expect(enKeys, `key "${key}" used in ${files.join(", ")}`).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Placeholder coverage. t() leaves an unknown {placeholder} verbatim (visible
// bug over silent blank), so a message whose placeholders aren't supplied at a
// call site ships literal "{days}" to users. The scan below parses every
// t() call in app code (outside app/i18n/) and proves each message's
// placeholder set is covered by the params passed wherever it can be used.

const EN: Record<string, string> = en;

/** Placeholder names in a catalog message — the same {word} shape t() fills. */
function placeholdersOf(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

const KEY_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

type Part = { text: string; start: number; end: number };

/**
 * Split `source` from `start` into top-level comma-separated parts, tracking
 * strings, template literals (incl. `${}` nesting), comments, and bracket
 * depth. `terminated` mode stops at the call's closing `)` (argument lists);
 * otherwise it runs to end of input (object-literal bodies). Null when the
 * input never balances.
 */
function splitTopLevel(
  source: string,
  start: number,
  terminated: boolean,
): { parts: Part[]; end: number } | null {
  const parts: Part[] = [];
  const stack: string[] = [];
  let partStart = start;
  const pushPart = (endIdx: number) => {
    const raw = source.slice(partStart, endIdx);
    const offset = raw.length - raw.trimStart().length;
    parts.push({ text: raw.trim(), start: partStart + offset, end: endIdx });
  };
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    const top = stack[stack.length - 1];
    if (top === '"' || top === "'" || top === "`") {
      if (ch === "\\") i++;
      else if (ch === top) stack.pop();
      else if (top === "`" && ch === "$" && source[i + 1] === "{") {
        i++;
        stack.push("${");
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i + 2);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`" || ch === "(" || ch === "[" || ch === "{") {
      stack.push(ch);
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.length > 0) {
        stack.pop();
        continue;
      }
      if (terminated && ch === ")") {
        if (source.slice(partStart, i).trim() !== "") pushPart(i);
        return { parts, end: i };
      }
      return null;
    }
    if (ch === "," && stack.length === 0) {
      pushPart(i);
      partStart = i + 1;
    }
  }
  if (terminated) return null;
  if (source.slice(partStart).trim() !== "") pushPart(source.length);
  return { parts, end: source.length };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Catalog keys a t() key argument may resolve to. A quoted literal names one
 * key; a template literal (`chrome.env-${appEnv}`) expands each `${…}` hole
 * against the catalog ([] = matches nothing, asserted on by the caller); any
 * other expression (conditionals) contributes every key-shaped string literal
 * inside it, or null when it has none (a variable key — those flow through
 * the indirect-reference check instead).
 */
function resolveKeys(expr: string, allKeys: readonly string[]): string[] | null {
  const literal = expr.match(/^["']([^"']*)["']$/);
  if (literal) return [literal[1]!];
  const template = expr.match(/^`([^`]*)`$/);
  if (template) {
    const body = template[1]!;
    if (!body.includes("${")) return [body];
    const pattern = new RegExp(
      `^${body.split(/\$\{[^}]*\}/).map(escapeRegExp).join("[a-z0-9-]+")}$`,
    );
    return allKeys.filter((k) => pattern.test(k));
  }
  const inside = [...expr.matchAll(/["']([^"'`]+)["']/g)]
    .map((m) => m[1]!)
    .filter((s) => KEY_SHAPE.test(s));
  return inside.length > 0 ? inside : null;
}

/**
 * Top-level property names of an object-literal params argument. Null when the
 * expression isn't an object literal this scan can read (variable, spread,
 * computed key) — callers treat that as unverifiable and fail if the message
 * needs placeholders.
 */
function paramNames(expr: string): string[] | null {
  if (!expr.startsWith("{") || !expr.endsWith("}")) return null;
  const split = splitTopLevel(expr.slice(1, -1), 0, false);
  if (split === null) return null;
  const names: string[] = [];
  for (const part of split.parts) {
    const m = part.text.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][A-Za-z0-9_$]*))\s*(?::|$)/);
    if (m === null) return null;
    names.push(m[1] ?? m[2] ?? m[3]!);
  }
  return names;
}

type CallSite = {
  where: string;
  keyExpr: string;
  /** Catalog keys this site may reference ([] = dynamic key matched nothing). */
  keys: string[];
  hasParamsArg: boolean;
  /** Top-level param names; null = not a statically analyzable object literal. */
  paramKeys: string[] | null;
};

type Scan = {
  sites: CallSite[];
  /** Key-shaped catalog-key literals outside a direct t() key argument. */
  indirectRefs: Array<{ key: string; where: string }>;
};

let scanCache: Scan | undefined;

function scanApp(): Scan {
  if (scanCache) return scanCache;
  const allKeys = Object.keys(EN);
  const sites: CallSite[] = [];
  const indirectRefs: Array<{ key: string; where: string }> = [];
  const i18nDir = join(APP_DIR, "i18n");
  for (const file of sourceFiles(APP_DIR)) {
    if (file.startsWith(i18nDir)) continue;
    const source = readFileSync(file, "utf8");
    const whereOf = (idx: number) =>
      `app/${relative(APP_DIR, file)}:${source.slice(0, idx).split("\n").length}`;
    const keyArgSpans: Array<{ start: number; end: number }> = [];
    for (const match of source.matchAll(/\bt\(/g)) {
      const idx = match.index!;
      // Skip a `function t(` declaration (e.g. a local test double).
      if (/function\s+$/.test(source.slice(Math.max(0, idx - 20), idx))) continue;
      const parsed = splitTopLevel(source, idx + 2, true);
      if (parsed === null || parsed.parts.length < 2) continue;
      const keyPart = parsed.parts[1]!;
      keyArgSpans.push({ start: keyPart.start, end: keyPart.end });
      const keys = resolveKeys(keyPart.text, allKeys);
      if (keys === null) continue;
      const paramsPart = parsed.parts[2];
      sites.push({
        where: whereOf(idx),
        keyExpr: keyPart.text,
        keys,
        hasParamsArg: paramsPart !== undefined,
        paramKeys: paramsPart === undefined ? [] : paramNames(paramsPart.text),
      });
    }
    for (const m of source.matchAll(/["'`]([a-z0-9-]+(?:\.[a-z0-9-]+)+)["'`]/g)) {
      const key = m[1]!;
      if (!(key in EN)) continue;
      if (keyArgSpans.some((s) => m.index! >= s.start && m.index! < s.end)) continue;
      indirectRefs.push({ key, where: whereOf(m.index!) });
    }
  }
  scanCache = { sites, indirectRefs };
  return scanCache;
}

// Keys reaching t() through MessageKey-typed variables (status/label tables)
// can't have their params checked statically, so they must need none. A
// placeholder-bearing key may be exempted here only with every call site
// hand-verified to supply its params.
//
// The six below are the valoper-bearing program-action summaries in
// `app/governance/decode.ts`. They reach t() through
// `VARIANT_SUMMARY_KEYS`, which exists so the summary set is TOTAL over the
// variant vocabulary `app/tx/build.ts` exports — that totality is itself a
// gating property (invariant 3), so the table is not replaceable by literal
// call sites without losing it.
//
// HAND-VERIFIED: there is exactly ONE call site for the table,
// `summarizeMessage`'s final `t(locale, key, { valoper })`, which always
// supplies `valoper`. `test/governance-decode.test.ts` asserts the substituted
// output of all six against golden strings, so an unfilled placeholder here
// fails that suite rather than reaching a user.
//
// `governance.msg-update-config` (M7.4) joins for a stronger reason than the
// six above: `templateSummaryKey` in `app/governance/templates.ts` returns the
// key AND its params as ONE value, so a caller cannot take the key without the
// params — the pairing is enforced by the return type rather than by review.
// The registry deliberately holds no runtime i18n import (it is imported by the
// relay guard's module graph), which is why it returns a key at all.
//
// HAND-VERIFIED: both call sites spread `.params` into `t()`
// (`app/routes/governance.new.tsx`'s confirm line and the round-trip case in
// `test/governance-templates.test.ts`). That round trip asserts the SUBSTITUTED
// output equals `decode.ts`'s own summary for the same message, so a dropped
// `fields` param fails there rather than reaching a user.
const INDIRECT_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  "governance.msg-update-config",
  "governance.msg-pay-commission",
  "governance.msg-pay-tip",
  "governance.msg-register-participation",
  "governance.msg-unregister-participation",
  "governance.msg-report-jailed",
  "governance.msg-purge-jailed",
]);

describe("i18n placeholder coverage", () => {
  const enKeys = Object.keys(EN).sort();

  it("at least one message declares a placeholder (scanner self-check)", () => {
    expect(enKeys.some((k) => placeholdersOf(EN[k]!).length > 0)).toBe(true);
  });

  it("every locale message carries exactly the en placeholder set", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const catalog: Record<string, string> = catalogs[locale];
      for (const key of enKeys) {
        expect(
          placeholdersOf(catalog[key]!).sort(),
          `placeholders of "${key}" in locale "${locale}"`,
        ).toEqual(placeholdersOf(EN[key]!).sort());
      }
    }
  });

  it("every t() call site supplies the placeholders its message needs", () => {
    const { sites } = scanApp();
    expect(sites.length, "expected t() call sites in app code").toBeGreaterThan(0);
    expect(
      sites.some((s) => s.hasParamsArg),
      "expected at least one t() call site passing params",
    ).toBe(true);
    for (const site of sites) {
      expect(
        site.keys.length,
        `dynamic key ${site.keyExpr} at ${site.where} matches no catalog key`,
      ).toBeGreaterThan(0);
      for (const key of site.keys) {
        expect(enKeys, `key "${key}" at ${site.where}`).toContain(key);
        const needed = placeholdersOf(EN[key] ?? "");
        if (needed.length === 0) continue;
        expect(
          site.paramKeys,
          `"${key}" needs {${needed.join("}, {")}} but the params at ${site.where} are not a plain object literal this test can analyze — inline them`,
        ).not.toBeNull();
        for (const name of needed) {
          expect(
            site.paramKeys!,
            `placeholder {${name}} of "${key}" is not supplied at ${site.where}`,
          ).toContain(name);
        }
      }
    }
  });

  it("keys referenced outside a literal t() key argument are placeholder-free", () => {
    const { indirectRefs } = scanApp();
    // Guard the scanner: the MessageKey label tables must be found.
    expect(indirectRefs.length, "expected indirect MessageKey references").toBeGreaterThan(0);
    for (const ref of indirectRefs) {
      if (INDIRECT_KEY_ALLOWLIST.has(ref.key)) continue;
      expect(
        placeholdersOf(EN[ref.key]!),
        `"${ref.key}" is referenced indirectly at ${ref.where}, where its params can't be checked statically`,
      ).toEqual([]);
    }
  });
});
