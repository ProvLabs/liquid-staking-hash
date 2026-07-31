// The Portfolio `?page=` boundary (SECURITY.md: reject, never
// clamp). Absent -> 0; malformed or out-of-range -> a 400 Response.

import { describe, expect, it } from "vitest";

import { MAX_PAGE, parsePageParam } from "~/portfolio/page-param";

describe("parsePageParam", () => {
  it("treats an absent param as page 0", () => {
    expect(parsePageParam(null)).toBe(0);
  });

  it("parses a plain integer", () => {
    expect(parsePageParam("0")).toBe(0);
    expect(parsePageParam("3")).toBe(3);
    expect(parsePageParam(String(MAX_PAGE))).toBe(MAX_PAGE);
  });

  const rejected: Array<[string, string]> = [
    ["non-numeric", "abc"],
    ["above the ceiling", String(MAX_PAGE + 1)],
    ["empty string", ""],
    ["fractional", "1.5"],
    ["negative", "-1"],
  ];
  it.each(rejected)("rejects %s with a 400 Response", (_label, raw) => {
    try {
      parsePageParam(raw);
      throw new Error("expected a thrown 400 Response");
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBe(400);
    }
  });
});
