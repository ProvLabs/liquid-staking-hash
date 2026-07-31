// Unit: the shared pagination schema bounds every collection route's query
// params (SECURITY.md: validate and bound all query parameters). Out-of-range
// input is rejected, not clamped; defaults fill in when omitted.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_PAGE_OFFSET,
  paginationSchema,
  searchParamsToRecord,
} from "../src/query.ts";

function parse(input: Record<string, string>) {
  return paginationSchema.safeParse(input);
}

describe("paginationSchema", () => {
  it("applies defaults when omitted", () => {
    const result = parse({});
    expect(result.success && result.data).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
  });

  it("coerces string query values to bounded integers", () => {
    const result = parse({ limit: "25", offset: "5" });
    expect(result.success && result.data).toEqual({ limit: 25, offset: 5 });
  });

  it("accepts the boundary values", () => {
    expect(parse({ limit: "1" }).success).toBe(true);
    expect(parse({ limit: String(MAX_PAGE_LIMIT) }).success).toBe(true);
    expect(parse({ offset: String(MAX_PAGE_OFFSET) }).success).toBe(true);
  });

  it("rejects limit below 1 and above the ceiling", () => {
    expect(parse({ limit: "0" }).success).toBe(false);
    expect(parse({ limit: String(MAX_PAGE_LIMIT + 1) }).success).toBe(false);
  });

  it("rejects negative offset and non-integers", () => {
    expect(parse({ offset: "-1" }).success).toBe(false);
    expect(parse({ limit: "1.5" }).success).toBe(false);
    expect(parse({ limit: "abc" }).success).toBe(false);
  });
});

describe("searchParamsToRecord", () => {
  it("flattens URLSearchParams to a record (last value wins)", () => {
    const record = searchParamsToRecord(new URLSearchParams("limit=10&offset=2&limit=20"));
    expect(record).toEqual({ limit: "20", offset: "2" });
  });
});
