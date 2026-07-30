// Unit: the ONE tested place for the pinned "extra JSON-string quoting layer"
// fact (packages/fixtures/manifest.json). Fixtures here are minimal inline
// events reproducing the exact quirks the real corpus pins — vault values are
// JSON-quoted (`"nvhash"`, `"3"`, `"36852482nhash"`), cosmos-sdk values are
// bare (`EndBlock`).

import { describe, expect, it } from "vitest";
import {
  attr,
  coinAttr,
  DecodeError,
  dequote,
  findEvent,
  findEvents,
  optionalAttr,
  parseCoinString,
  parseU128,
  type RawEvent,
} from "../../src/decode/attributes.ts";

// Shaped after the real EventSwapOutCompleted (block_results) — vault values
// quoted, plus a bare cosmos-sdk `mode`.
const swapOutCompleted: RawEvent = {
  type: "provlabs.vault.v1.EventSwapOutCompleted",
  attributes: [
    { key: "assets", value: '"36852482nhash"', index: true },
    { key: "owner", value: '"tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0"', index: true },
    { key: "request_id", value: '"3"', index: true },
    { key: "mode", value: "EndBlock", index: true },
  ],
};

describe("dequote", () => {
  it("strips one JSON-string layer from quoted values", () => {
    expect(dequote('"nvhash"')).toBe("nvhash");
    expect(dequote('"3"')).toBe("3");
    expect(dequote('"36852482nhash"')).toBe("36852482nhash");
  });

  it("leaves bare values untouched", () => {
    expect(dequote("EndBlock")).toBe("EndBlock");
    expect(dequote("3")).toBe("3");
    expect(dequote("")).toBe("");
  });

  it("leaves a non-JSON value that merely starts with a quote untouched", () => {
    expect(dequote('"unterminated')).toBe('"unterminated');
  });
});

describe("attr / optionalAttr", () => {
  it("returns the de-quoted required attribute", () => {
    expect(attr(swapOutCompleted, "owner")).toBe("tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0");
    expect(attr(swapOutCompleted, "request_id")).toBe("3");
    expect(attr(swapOutCompleted, "mode")).toBe("EndBlock");
  });

  it("throws a DecodeError for a missing required attribute", () => {
    expect(() => attr(swapOutCompleted, "nope")).toThrow(DecodeError);
  });

  it("returns undefined for a missing optional attribute", () => {
    expect(optionalAttr(swapOutCompleted, "nope")).toBeUndefined();
    expect(optionalAttr(swapOutCompleted, "request_id")).toBe("3");
  });
});

describe("coinAttr / parseCoinString", () => {
  it("splits <amount><denom> into a bigint amount and denom", () => {
    expect(coinAttr(swapOutCompleted, "assets")).toEqual({ amount: 36852482n, denom: "nhash" });
    expect(parseCoinString("310000000000000000nvhash")).toEqual({
      amount: 310000000000000000n,
      denom: "nvhash",
    });
    expect(parseCoinString("0nhash")).toEqual({ amount: 0n, denom: "nhash" });
  });

  it("rejects a malformed coin string", () => {
    expect(() => parseCoinString("nhash")).toThrow(DecodeError);
    expect(() => parseCoinString("12")).toThrow(DecodeError);
    expect(() => parseCoinString("01nhash")).toThrow(DecodeError);
  });
});

describe("parseU128", () => {
  it("accepts canonical unsigned integers to Uint128", () => {
    expect(parseU128("0")).toBe(0n);
    expect(parseU128(((1n << 128n) - 1n).toString())).toBe((1n << 128n) - 1n);
  });

  it("rejects non-canonical or out-of-range values", () => {
    expect(() => parseU128("-1")).toThrow(DecodeError);
    expect(() => parseU128("007")).toThrow(DecodeError);
    expect(() => parseU128((1n << 128n).toString())).toThrow(DecodeError);
  });
});

describe("findEvents / findEvent", () => {
  const events: RawEvent[] = [
    { type: "wasm", attributes: [{ key: "action", value: "run_epoch" }] },
    { type: "wasm", attributes: [{ key: "action", value: "service_redemptions" }] },
    swapOutCompleted,
  ];

  it("returns every event of a type in order", () => {
    expect(findEvents(events, "wasm")).toHaveLength(2);
    expect(findEvents(events, "missing")).toHaveLength(0);
  });

  it("returns the first event of a type, or undefined", () => {
    expect(findEvent(events, "wasm")?.attributes[0]?.value).toBe("run_epoch");
    expect(findEvent(events, "missing")).toBeUndefined();
  });
});
