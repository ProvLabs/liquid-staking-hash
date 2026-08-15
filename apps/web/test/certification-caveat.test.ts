// The pre-certification caveat gate (plan 8.4 §2.7.2, §4 invariant 9): the
// public pilot NEVER claims certification. The caveat is keyed to the fixture
// manifest status — not a config flag — so no deployment can assert a
// certification the corpus does not have, and it retires only in the same
// commit that flips the manifest (8.0's re-capture).
import manifest from "@nvhash/fixtures/manifest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CORPUS_CERTIFIED, corpusCertified } from "~/chrome/certification";
import { TrustPosture } from "~/components/learn/trust-posture";

describe("certification caveat (D22/D27)", () => {
  it("the corpus is currently PROVISIONAL, so the caveat is live", () => {
    // This cell flips in the SAME commit as 8.0's manifest re-capture — that
    // is the design, not a stale assertion: when 8.0 certifies the corpus,
    // this becomes `true` and the render case below inverts with it.
    expect(String(manifest.status).startsWith("PROVISIONAL")).toBe(true);
    expect(CORPUS_CERTIFIED).toBe(false);
  });

  it("the rule: only a non-PROVISIONAL manifest status certifies", () => {
    expect(corpusCertified("PROVISIONAL — captured against a pre-release build")).toBe(false);
    expect(corpusCertified("CERTIFIED 2026-xx-xx against vault vX.Y.Z")).toBe(true);
  });

  it("the Learn trust panel renders the caveat while uncertified", () => {
    const html = renderToString(createElement(TrustPosture, { locale: "en" }));
    if (CORPUS_CERTIFIED) {
      expect(html).not.toContain("data-certification-caveat");
    } else {
      expect(html).toContain("data-certification-caveat");
      expect(html).toContain("pre-certification");
    }
  });

  it("both public surfaces consume the ONE derivation (no second flag to lie with)", async () => {
    // Source-read (the funnel-counters idiom): the footer and the trust panel
    // must key on CORPUS_CERTIFIED from ~/chrome/certification — a
    // per-environment flag would be exactly the config-to-forget §2.7.2 bars.
    const { readFileSync } = await import("node:fs");
    for (const file of [
      "app/components/chrome/freshness-footer.tsx",
      "app/components/learn/trust-posture.tsx",
    ]) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source, file).toContain("CORPUS_CERTIFIED");
      expect(source, file).toContain('from "~/chrome/certification"');
    }
  });
});
