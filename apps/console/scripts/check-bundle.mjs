import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist", import.meta.url).pathname;

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
