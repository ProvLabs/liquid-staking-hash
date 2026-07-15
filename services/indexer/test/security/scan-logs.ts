// Static log-scrubbing scanner for the indexer source tree.
//
// SECURITY.md ("Backend services"): the indexer must not persist IP addresses
// or device identifiers linked to wallet addresses, "including in logs — scrub
// or aggregate". The indexer processes only public chain data, so these
// identifiers have no legitimate place in its source at all. This scanner
// enforces that: it fails if any IP/device/identity token appears in an
// executable source line (comments are exempted so this file and the logger's
// own documentation can name the very things they forbid).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const SRC_DIR = join(here, "..", "..", "src");

// Identifier patterns for IP addresses and device/user identifiers. Word-bounded
// so ordinary words that merely contain the letters (e.g. "skip", "description")
// do not match.
export const FORBIDDEN_LOG_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "ip (standalone identifier)", re: /\bip\b/i },
  { label: "ipAddress", re: /ip[_-]?address/i },
  { label: "ipAddr", re: /ip[_-]?addr/i },
  { label: "remoteAddress", re: /remote[_-]?addr(ess)?/i },
  { label: "x-forwarded-for", re: /x[_-]?forwarded[_-]?for/i },
  { label: "forwardedFor", re: /forwarded[_-]?for/i },
  { label: "userAgent", re: /user[_-]?agent/i },
  { label: "deviceId", re: /device[_-]?id/i },
  { label: "fingerprint", re: /fingerprint/i },
];

export interface LogScanHit {
  file: string;
  line: number;
  label: string;
  text: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Is this source line a comment (line- or block-style)? Comments are exempt. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** Scan every .ts file under src/ and return forbidden-token hits in code. */
export function scanSourceForForbiddenLogFields(root = SRC_DIR): LogScanHit[] {
  const hits: LogScanHit[] = [];
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (isComment(text)) return;
      for (const { label, re } of FORBIDDEN_LOG_PATTERNS) {
        if (re.test(text)) hits.push({ file, line: i + 1, label, text: text.trim() });
      }
    });
  }
  return hits;
}
