// Bundle guard (PR 8.4b §2.7; the apps/web `check:bundle` precedent): the
// built test/production bundle must contain NO devnet-key/mock-identity
// material — this converts console-spec §10.1's "compile-time excluded" from
// prose to a CI gate. Run AFTER `npm run build:test` (or build); scans dist/.
//
// The markers are the literals of src/tx/devnet-keys.ts, which the wallet
// references only under the `import.meta.env.MODE === "devnet"` static
// condition — Vite's dead-code elimination removes the module, and this
// script proves it stayed removed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist", import.meta.url).pathname;

// Literals from src/tx/devnet-keys.ts — the module the static condition must
// eliminate. The addresses are the strongest markers (unique, un-minifiable);
// the identity labels back them up. (The chrome picker's caption strings are
// NOT markers: that branch is runtime-gated on a wallet fact and stays in the
// bundle inert — the exclusion target is the identities module itself.)
const MARKERS = [
  "pb1adminadminadminadminadminadminadmin00",
  "pb1operatoroperatoroperatoroperatorop000",
  "pb1keeperkeeperkeeperkeeperkeeperkeep0000",
  "admin (Ada)",
  "operator (Pat)",
  "keeper (Kai)",
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (!path.endsWith(".map")) out.push(path);
  }
  return out;
}

let files;
try {
  files = walk(DIST);
} catch {
  console.error(`check-bundle: no dist/ at ${DIST} — run a build first`);
  process.exit(1);
}

const hits = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const marker of MARKERS) {
    if (content.includes(marker)) hits.push(`${file}: contains "${marker}"`);
  }
}

if (hits.length > 0) {
  console.error(
    "check-bundle: devnet/mock material reached a non-devnet bundle — the §10.1 compile-time exclusion is broken:",
  );
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log(`check-bundle: ${files.length} files clean of devnet/mock markers`);
