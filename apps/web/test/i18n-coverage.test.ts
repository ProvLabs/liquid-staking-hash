// i18n key coverage (plan PR 1.3): every locale catalog carries exactly the
// reference (`en`) key set, and every `t(locale, "key")` call site in app code
// references a defined key. A missing translation fails CI, not a user.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
