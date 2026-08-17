// Footer age = the data's age when reported, the response clock only when
// none exists — the wrong source renders a dead indexer as "(0s ago)".

import type { FreshnessMeta } from "@nvhash/api-types";
import { describe, expect, it } from "vitest";
import { describeFreshness, formatAge } from "~/chrome/freshness";

const NOW_MS = Date.parse("2026-08-14T12:00:00Z");

function meta(over: Partial<FreshnessMeta> = {}): FreshnessMeta {
  return {
    chain_height: 1200,
    indexed_height: 1197,
    generated_at: "2026-08-14T12:00:00Z", // the response clock: "now"
    source: "indexed",
    ...over,
  };
}

describe("describeFreshness age sources", () => {
  it("uses reconciled_at (the data's age) when the API reports one", () => {
    // Data reconciled 10 minutes ago; response generated now. The footer must
    // say 600s, not 0s — the response clock is not the data's age.
    const display = describeFreshness(meta(), NOW_MS, "2026-08-14T11:50:00Z");
    expect(display).toEqual({ kind: "indexed", height: 1197, ageSeconds: 600 });
  });

  it("falls back to generated_at when no reconciled_at exists (older API / cold start)", () => {
    const display = describeFreshness(meta({ generated_at: "2026-08-14T11:59:30Z" }), NOW_MS, null);
    expect(display).toEqual({ kind: "indexed", height: 1197, ageSeconds: 30 });
  });

  it("renders n/a on null meta or a null indexed height, never a fabricated age", () => {
    expect(describeFreshness(null, NOW_MS, "2026-08-14T11:50:00Z")).toEqual({ kind: "na" });
    expect(describeFreshness(meta({ indexed_height: null }), NOW_MS, null)).toEqual({ kind: "na" });
  });

  it("clamps a future stamp to zero and formats compactly", () => {
    const display = describeFreshness(meta(), NOW_MS, "2026-08-14T12:00:05Z");
    expect(display).toMatchObject({ ageSeconds: 0 });
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(600)).toBe("10m");
  });
});
