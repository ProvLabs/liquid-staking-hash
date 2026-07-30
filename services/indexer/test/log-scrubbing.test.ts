// Security-executable gate (b): the indexer source never logs (or otherwise
// references) IP/device identifiers alongside addresses. Standing in CI from
// On (runs under `pnpm -r test`). Planting a log line such as
// `logger.info("tx", { address, ip })` makes this suite — and CI — fail.

import { describe, expect, it } from "vitest";
import { scanSourceForForbiddenLogFields } from "./security/scan-logs.ts";
import { SAFE_FIELDS } from "../src/logger.ts";

describe("log scrubbing (SECURITY.md: no IP/device identifiers in logs)", () => {
  it("no source line references an IP/device/identity token", () => {
    const hits = scanSourceForForbiddenLogFields();
    const report = hits.map((h) => `${h.file}:${h.line} [${h.label}] ${h.text}`).join("\n");
    expect(hits, `forbidden IP/device identifiers in indexer source:\n${report}`).toEqual([]);
  });

  it("the logger's safe-field allowlist contains no IP/device/identity field", () => {
    // The logger can only ever emit these keys; assert none is identity-shaped.
    const forbidden = SAFE_FIELDS.filter((f) =>
      /(^ip$|ipaddr|remoteaddr|forwardedfor|useragent|device|fingerprint|email|phone)/i.test(f),
    );
    expect(forbidden, `logger SAFE_FIELDS leaks identity fields: ${forbidden.join(", ")}`).toEqual([]);
  });
});
