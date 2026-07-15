// Loads corpus files from the sibling @nvhash/fixtures package. Read via fs
// (not module resolution) so fixtures stay plain data — no export-map
// gymnastics, and a missing file fails the test loudly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../fixtures/fixtures",
);

export function fixture(relPath: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, relPath), "utf8"));
}

/** The LCD smart-query envelope's data payload. */
export function smartData(relPath: string): unknown {
  const o = fixture(relPath) as { data?: unknown };
  return o.data;
}
