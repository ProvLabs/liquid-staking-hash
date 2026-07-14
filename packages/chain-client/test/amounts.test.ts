import { describe, expect, it } from "vitest";
import {
  DecodeError,
  U128_MAX,
  parseCoin,
  parseInt128,
  parseU64Number,
  parseU64String,
  parseUint128,
} from "../src/amounts.ts";

describe("parseUint128", () => {
  it("parses canonical strings to bigint", () => {
    expect(parseUint128("0")).toBe(0n);
    expect(parseUint128("315387632233")).toBe(315387632233n);
    expect(parseUint128(U128_MAX.toString())).toBe(U128_MAX);
  });

  it("rejects everything that is not a canonical unsigned integer string", () => {
    for (const bad of ["", "-1", "1.5", "01", "0x10", " 1", "1n", 5, null, undefined, {}, "+1", "1e9"]) {
      expect(() => parseUint128(bad)).toThrow(DecodeError);
    }
  });

  it("rejects values past the Uint128 ceiling", () => {
    expect(() => parseUint128((U128_MAX + 1n).toString())).toThrow(DecodeError);
  });
});

describe("parseInt128", () => {
  it("parses signed values (snapshot net_deposits)", () => {
    expect(parseInt128("-1949")).toBe(-1949n);
    expect(parseInt128("0")).toBe(0n);
  });
  it("rejects non-canonical forms", () => {
    for (const bad of ["-0", "--1", "-01", "1.0", ""]) {
      expect(() => parseInt128(bad)).toThrow(DecodeError);
    }
  });
});

describe("parseU64String / parseU64Number", () => {
  it("parses proto-JSON string uint64", () => {
    expect(parseU64String("1173")).toBe(1173n);
    expect(() => parseU64String(1173)).toThrow(DecodeError);
    expect(() => parseU64String((1n << 64n).toString())).toThrow(DecodeError);
  });
  it("bounds contract u64 numbers to safe integers", () => {
    expect(parseU64Number(10000)).toBe(10000);
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "5", NaN]) {
      expect(() => parseU64Number(bad)).toThrow(DecodeError);
    }
  });
});

describe("parseCoin", () => {
  it("returns bigint amounts — never numbers", () => {
    const c = parseCoin({ denom: "nhash", amount: "315387608006" });
    expect(c.denom).toBe("nhash");
    expect(typeof c.amount).toBe("bigint");
    expect(c.amount).toBe(315387608006n);
  });
  it("rejects numeric amounts (silent precision loss upstream)", () => {
    expect(() => parseCoin({ denom: "nhash", amount: 315387608006 })).toThrow(DecodeError);
  });
});
