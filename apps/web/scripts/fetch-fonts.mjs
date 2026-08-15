// Webfont build-time fetch (plan 8.4 §2.8, CO-27). The §11 type stack
// (Funnel Sans body / Space Grotesk display / Geist Mono for addresses) is
// self-hosted WITHOUT committing binaries (repo policy): this script fetches
// each family at build time from a COMMIT-PINNED upstream URL, verifies a
// PINNED sha256, and writes into the gitignored public/fonts/. The @font-face
// rules live in app/theme/fonts.css with `font-display: swap` and the system
// stack as fallback.
//
// Fail-closed rules:
//   * `--require` (the production/image build): a fetch failure or checksum
//     mismatch EXITS NON-ZERO — an unpinned font on every page of the public
//     App is a supply-chain injection vector (§4 invariant 10).
//   * default (dev): warns and leaves the system-font fallback — offline
//     development keeps working.
//
// License provenance: Funnel Sans and Space Grotesk are OFL-1.1 (fetched
// from google/fonts' ofl/ tree at the pinned commit); Geist Mono is OFL-1.1
// (vercel/geist-font at the pinned commit). Pinned 2026-08-14.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "fonts");

// Commit-pinned URLs (never a moving ref: `main` moving upstream must not be
// able to change what this build ships) + per-file sha256.
const FONTS = [
  {
    file: "FunnelSans[wght].ttf",
    url: "https://github.com/google/fonts/raw/352f6b7d9d6cc4fa9e242b931291d31b21a6dc84/ofl/funnelsans/FunnelSans%5Bwght%5D.ttf",
    sha256: "652c9834434bc01835c4e75a73d3c7e42ff2e4beb261cc851cb911e889af6a77",
  },
  {
    file: "SpaceGrotesk[wght].ttf",
    url: "https://github.com/google/fonts/raw/352f6b7d9d6cc4fa9e242b931291d31b21a6dc84/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf",
    sha256: "acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72",
  },
  {
    file: "GeistMono[wght].ttf",
    url: "https://github.com/vercel/geist-font/raw/10dc7658f13c38a474cde201bb09a4617267545b/fonts/GeistMono/variable/GeistMono%5Bwght%5D.ttf",
    sha256: "87c2aff9723544a9adaea19d92e42a33705c9723624801b6e0224c2206a6af0d",
  },
];

const required = process.argv.includes("--require");

function bail(message) {
  if (required) {
    console.error(`fetch-fonts: ${message} — production builds fail closed (plan 8.4 §2.8)`);
    process.exit(1);
  }
  console.warn(`fetch-fonts: ${message} — dev falls back to the system font stack`);
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });

for (const font of FONTS) {
  const target = join(OUT_DIR, font.file);
  if (existsSync(target)) {
    const existing = createHash("sha256").update(readFileSync(target)).digest("hex");
    if (existing === font.sha256) {
      console.log(`fetch-fonts: ${font.file} present and pinned`);
      continue;
    }
    // A wrong on-disk file is replaced, never trusted.
  }
  let bytes;
  try {
    const response = await fetch(font.url, { redirect: "follow" });
    if (!response.ok) bail(`${font.file}: upstream ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    bail(`${font.file}: fetch failed (${error instanceof Error ? error.message : error})`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== font.sha256) {
    // Never written to disk: a checksum mismatch is a tampered or moved
    // upstream artifact, and dev must not silently serve it either.
    console.error(`fetch-fonts: ${font.file} sha256 mismatch (got ${digest})`);
    process.exit(1);
  }
  writeFileSync(target, bytes);
  console.log(`fetch-fonts: ${font.file} fetched and verified`);
}
