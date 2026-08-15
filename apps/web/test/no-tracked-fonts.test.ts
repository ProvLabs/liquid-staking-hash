// No-binaries gate for the §11 type stack (plan 8.4 §4 invariant 10): fonts
// are FETCHED at build time (scripts/fetch-fonts.mjs, checksum-pinned) into
// the gitignored public/fonts/ — a committed font binary anywhere in the app
// tree is a repo-policy violation. Walks the source tree directly (no git
// dependency, so it runs identically in the container CI).
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FONT_EXTENSIONS = /\.(ttf|otf|woff2?|eot)$/i;
// The ONE permitted location, and it is gitignored — files here are build
// products, not tracked content.
const ALLOWED = join("public", "fonts");
const SKIPPED = new Set(["node_modules", "build", "test-results", "playwright-report"]);

function fontFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const rel = relative(APP_ROOT, path);
    if (SKIPPED.has(entry) || rel === ALLOWED) continue;
    if (statSync(path).isDirectory()) out.push(...fontFiles(path));
    else if (FONT_EXTENSIONS.test(entry)) out.push(rel.split(sep).join("/"));
  }
  return out;
}

describe("no tracked font binaries (plan 8.4 §2.8)", () => {
  it("the app tree carries no font file outside the gitignored public/fonts/", () => {
    expect(fontFiles(APP_ROOT)).toEqual([]);
  });
});
