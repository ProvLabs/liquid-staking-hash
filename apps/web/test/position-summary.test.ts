// A genuine zero gain is neutral, not the green "up" state (§12.1: state never
// rides color alone, and zero is neither gain nor loss).

import { describe, expect, it } from "vitest";

import { gainDirection } from "~/components/portfolio/position-summary";

describe("gainDirection", () => {
  it("reads a genuine zero as flat", () => {
    expect(gainDirection("0")).toBe("flat");
    expect(gainDirection("0.0000")).toBe("flat");
    expect(gainDirection("-0.0000")).toBe("flat");
  });

  it("reads a positive amount as up", () => {
    expect(gainDirection("1.2500")).toBe("up");
    expect(gainDirection("0.0001")).toBe("up");
  });

  it("reads a negative amount as down", () => {
    expect(gainDirection("-1.2500")).toBe("down");
    expect(gainDirection("-0.0001")).toBe("down");
  });
});
