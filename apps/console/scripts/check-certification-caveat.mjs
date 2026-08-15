// Certification-caveat build assertion (plan 8.4 §2.7.2; §4 invariant 9): a
// PROVISIONAL fixture corpus must produce a bundle that CARRIES the
// pre-certification caveat, and a certified corpus one that does not — the
// public pilot never claims a certification the corpus does not have. Runs
// after every build (CI console job + the console image build).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const distDir = new URL("../dist", import.meta.url).pathname;
const manifest = JSON.parse(
  readFileSync(
    new URL("../../../packages/fixtures/fixtures/manifest.json", import.meta.url),
    "utf8",
  ),
);
const certified = !String(manifest.status ?? "PROVISIONAL").startsWith("PROVISIONAL");

const CAVEAT = "pre-certification build";

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (!path.endsWith(".map")) out.push(path);
  }
  return out;
}

const present = walk(distDir).some((file) => readFileSync(file, "utf8").includes(CAVEAT));

if (certified && present) {
  console.error(
    "check-certification-caveat: the corpus is certified but the bundle still carries the caveat — stale build or a broken define",
  );
  process.exit(1);
}
if (!certified && !present) {
  console.error(
    "check-certification-caveat: the corpus is PROVISIONAL but the bundle carries NO caveat — the public pilot would claim a certification it does not have (D22)",
  );
  process.exit(1);
}
console.log(
  `check-certification-caveat: ok (corpus ${certified ? "certified, caveat absent" : "PROVISIONAL, caveat present"})`,
);
