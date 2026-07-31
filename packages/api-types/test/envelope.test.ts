// Unit: the shared envelope builder produces the exact `{ data, meta }` shape
// app-spec §9.4 mandates, defaults unknown heights to null (the honest cold
// state, §12.1), and bounds heights at the boundary.

import { describe, expect, it } from "vitest";
import { envelope, freshness } from "../src/index.ts";

const FIXED = new Date("2026-07-14T12:00:00.000Z");

describe("freshness()", () => {
  it("defaults both heights to null when omitted (unwired / cold state)", () => {
    const meta = freshness({ source: "indexed", generatedAt: FIXED });
    expect(meta).toEqual({
      chain_height: null,
      indexed_height: null,
      generated_at: "2026-07-14T12:00:00.000Z",
      source: "indexed",
    });
  });

  it("carries provided heights and renders generated_at as ISO-8601", () => {
    const meta = freshness({
      source: "live",
      chainHeight: 100,
      indexedHeight: 98,
      generatedAt: FIXED,
    });
    expect(meta.chain_height).toBe(100);
    expect(meta.indexed_height).toBe(98);
    expect(meta.generated_at).toBe("2026-07-14T12:00:00.000Z");
    expect(meta.source).toBe("live");
  });

  it("rejects a negative height (bounded at the boundary)", () => {
    expect(() => freshness({ source: "live", chainHeight: -1 })).toThrow(RangeError);
  });

  it("rejects a non-integer height", () => {
    expect(() => freshness({ source: "indexed", indexedHeight: 1.5 })).toThrow(RangeError);
  });
});

describe("envelope()", () => {
  it("wraps data alongside validated freshness meta", () => {
    const env = envelope({ items: [] as number[] }, { source: "indexed", generatedAt: FIXED });
    expect(env.data).toEqual({ items: [] });
    expect(env.meta.source).toBe("indexed");
    expect(env.meta.chain_height).toBeNull();
  });
});
