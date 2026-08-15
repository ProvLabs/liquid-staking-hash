// Consistency gate between the machine-readable audit ignore lists and the
// human register (SECURITY.md "Dependencies and supply chain"; run by the
// `audit` jobs in both CI workflows). Fails in BOTH directions:
//   - an id ignored in contracts/.cargo/audit.toml or pnpm-workspace.yaml's
//     `auditConfig` with no register row (an unowned exception), and
//   - a register row whose id is in no machine list (a register rotting into
//     fiction).
// The register carries what JSON/TOML cannot: owner, reason, review-by date.
// Node-only, zero dependencies; not a shell script (shellcheck-exempt).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const ADVISORY_ID = /(?:RUSTSEC-\d{4}-\d{4}|CVE-\d{4}-\d{4,}|GHSA-[23456789cfghjmpqrvwx-]{14,19})/g;

/** Ids in the `ignore = [...]` array of the cargo-audit config. */
function cargoIgnores() {
  const source = readFileSync(join(repoRoot, "contracts/.cargo/audit.toml"), "utf8");
  // Strip TOML comments so a commented-out id is not read as active.
  const active = source
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  const list = active.match(/ignore\s*=\s*\[([^\]]*)\]/);
  if (list === null) {
    throw new Error("contracts/.cargo/audit.toml: no `ignore = [...]` array found");
  }
  return (list[1] ?? "").match(ADVISORY_ID) ?? [];
}

/**
 * Ids in pnpm-workspace.yaml's `auditConfig` lists (the pnpm-11 settings
 * home — pnpm no longer reads `package.json#pnpm`). Line-oriented parse of
 * exactly the shape this repo commits: a top-level `auditConfig:` block whose
 * `ignoreCves:`/`ignoreGhsas:` lists hold quoted or bare advisory ids.
 */
function pnpmIgnores() {
  const source = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const block = source.match(/^auditConfig:\n((?:[ \t]+.*\n?|\n)*)/m);
  if (block === null) {
    throw new Error("pnpm-workspace.yaml: no top-level `auditConfig:` block found");
  }
  const active = (block[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  return active.match(ADVISORY_ID) ?? [];
}

/** Ids carried by register table rows (first cell of each data row). */
function registerIds() {
  const source = readFileSync(
    join(repoRoot, "docs/security/dependency-audit-exceptions.md"),
    "utf8",
  );
  const ids = [];
  for (const line of source.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const first = cells[1] ?? "";
    ADVISORY_ID.lastIndex = 0;
    const match = first.match(ADVISORY_ID);
    if (match !== null) ids.push(...match);
  }
  return ids;
}

const machine = new Map([
  ...cargoIgnores().map((id) => [id, "contracts/.cargo/audit.toml"]),
  ...pnpmIgnores().map((id) => [id, "pnpm-workspace.yaml auditConfig"]),
]);
const register = new Set(registerIds());

const failures = [];
for (const [id, source] of machine) {
  if (!register.has(id)) {
    failures.push(
      `${id} is ignored in ${source} but has no row in docs/security/dependency-audit-exceptions.md (owner, reason, review-by required)`,
    );
  }
}
for (const id of register) {
  if (!machine.has(id)) {
    failures.push(
      `${id} has a register row but is in no machine ignore list — remove the stale row or restore the ignore`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`audit-exceptions: ${failure}`);
  process.exit(1);
}
console.log(
  `audit-exceptions: consistent (${machine.size} machine ignore${machine.size === 1 ? "" : "s"}, ${register.size} register row${register.size === 1 ? "" : "s"})`,
);
