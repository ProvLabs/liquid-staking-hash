#!/usr/bin/env node
// Dataviz palette gate (ADR-001 Decision 4 / app-spec §14.8, plan §4
// visual/design layer, standing from PR 1.3): both theme token sets must pass
// the shared dataviz validation method (validate_palette.js — the same script
// the console's practice names) on every change.
//
// Parses app/theme/tokens.css for the contract documented there:
//   --viz-cat-<n>:  light-dark(#llllll, #dddddd)
//   --viz-surface:  light-dark(#llllll, #dddddd)
// and runs the validator once per mode against that mode's surface. Exit 1 on
// any hard FAIL (WARN bands are legal only with the secondary encodings the
// method mandates — chart PRs own that).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(appDir, "app/theme/tokens.css"), "utf8");

const pair = (name) => {
  const m = css.match(
    new RegExp(`--${name}:\\s*light-dark\\(\\s*(#[0-9a-fA-F]{6})\\s*,\\s*(#[0-9a-fA-F]{6})\\s*\\)`),
  );
  if (!m) {
    console.error(
      `[check-palette] FAIL — token --${name} not found as a light-dark(#hex, #hex) pair`,
    );
    process.exit(1);
  }
  return { light: m[1], dark: m[2] };
};

const surface = pair("viz-surface");
const slots = [];
for (let n = 1; ; n++) {
  if (!css.includes(`--viz-cat-${n}:`)) break;
  slots.push(pair(`viz-cat-${n}`));
}
if (slots.length < 2) {
  console.error("[check-palette] FAIL — expected at least 2 --viz-cat-* categorical slots");
  process.exit(1);
}

let failed = false;
for (const mode of ["light", "dark"]) {
  const palette = slots.map((s) => s[mode]).join(",");
  console.log(`\n[check-palette] ${mode}: ${slots.length} slots on surface ${surface[mode]}`);
  const run = spawnSync(
    process.execPath,
    [
      join(appDir, "scripts/validate_palette.js"),
      palette,
      "--mode",
      mode,
      "--surface",
      surface[mode],
    ],
    { stdio: "inherit" },
  );
  if (run.status !== 0) failed = true;
}

if (failed) {
  console.error("\n[check-palette] FAIL — a theme's palette failed validation");
  process.exit(1);
}
console.log("\n[check-palette] PASS — both theme palettes validate");
