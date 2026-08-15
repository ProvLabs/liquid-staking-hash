#!/usr/bin/env node
// Bundle-secret gate (SECURITY.md: "Everything shipped to the browser is
// public"; plan §4 security-executable layer, standing from PR 1.3).
//
// Mechanism: build the app with a unique sentinel value in every server-only
// env var (scripts/server-only-env.json), then scan every byte of the client
// bundle (build/client/**) for any sentinel. Nothing beyond the app-spec §7
// client-safe subset may appear in the client bundle — a hit fails CI with
// the offending file and key. This catches both build-time inlining (vite
// `define` / import.meta.env) and any accidental static embedding; runtime
// serialization is covered by the toClientConfig allowlist test and the e2e
// leak assertion.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const classification = JSON.parse(
  readFileSync(join(appDir, "scripts/server-only-env.json"), "utf8"),
);

const sentinels = new Map(
  classification.serverOnly.map((key) => [key, `NVHASH_SERVER_ONLY_${key}_SENTINEL_MUST_NOT_SHIP`]),
);

// --scan-only (PR 8.4, §4 invariant 11): skip the instrumented rebuild and
// scan an EXISTING build/client — the images job extracts the bundle the
// production image actually ships and runs this over it. The sentinel-env
// leak check is only meaningful on the instrumented build; scan-only covers
// the forbidden literals plus any extra markers passed in EXTRA_BUNDLE_SCAN
// (the images job passes its layer-scan sentinel, so a decoy .env inlined at
// image build time is caught here as well as in the layer scan).
const scanOnly = process.argv.includes("--scan-only");

if (!scanOnly) {
  console.log(
    `[check-bundle-secrets] building with sentinels in: ${[...sentinels.keys()].join(", ")}`,
  );

  const build = spawnSync("corepack", ["pnpm", "exec", "react-router", "build"], {
    cwd: appDir,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      ...Object.fromEntries([...sentinels.entries()].map(([k, v]) => [k, v])),
    },
  });
  if (build.status !== 0) {
    console.error(`[check-bundle-secrets] FAIL — build exited ${build.status}`);
    process.exit(build.status ?? 1);
  }
}

const clientDir = join(appDir, "build/client");
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
})(clientDir);

if (files.length === 0) {
  console.error("[check-bundle-secrets] FAIL — build/client is empty; nothing was scanned");
  process.exit(1);
}

// PR 5.2: the e2e-live test signer (e2e-live/signer.ts) must never reach the
// client bundle. It is never imported by app code; this literal scan makes
// that an enforced mechanism rather than a review assumption.
const FORBIDDEN_LITERALS = ["NVHASH_TEST_SIGNER_MUST_NOT_SHIP"];
if (process.env.EXTRA_BUNDLE_SCAN) FORBIDDEN_LITERALS.push(process.env.EXTRA_BUNDLE_SCAN);

const hits = [];
for (const file of files) {
  const content = readFileSync(file, "latin1");
  for (const [key, sentinel] of sentinels) {
    if (content.includes(sentinel)) hits.push({ file: relative(appDir, file), key });
  }
  for (const literal of FORBIDDEN_LITERALS) {
    if (content.includes(literal)) hits.push({ file: relative(appDir, file), key: literal });
  }
}

if (hits.length > 0) {
  console.error("[check-bundle-secrets] FAIL — server-only values reached the client bundle:");
  for (const hit of hits) console.error(`  ${hit.key} leaked into ${hit.file}`);
  process.exit(1);
}

console.log(
  `[check-bundle-secrets] PASS — scanned ${files.length} client files; ` +
    `no server-only value (${sentinels.size} keys) appears in the client bundle`,
);
