// Unit: the fixed-window limiter counts per key, refuses over the ceiling, and
// resets when the window rolls over. Deterministic via an injected clock.

import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rate-limit.ts";

describe("RateLimiter", () => {
  it("allows up to max then refuses within a window", () => {
    const t = 1_000;
    const limiter = new RateLimiter({ max: 2, windowMs: 1_000, now: () => t });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(true);
    const third = limiter.hit("a");
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it("tracks keys independently", () => {
    const t = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 1_000, now: () => t });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("b").allowed).toBe(true); // different key, own budget
    expect(limiter.hit("a").allowed).toBe(false);
  });

  it("resets after the window elapses", () => {
    let t = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 1_000, now: () => t });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
    t = 1_000; // window rolled over
    expect(limiter.hit("a").allowed).toBe(true);
  });

  it("reports a decreasing remaining and a reset time", () => {
    const limiter = new RateLimiter({ max: 3, windowMs: 2_000, now: () => 500 });
    const first = limiter.hit("a");
    expect(first.remaining).toBe(2);
    expect(first.limit).toBe(3);
    expect(first.resetAt).toBe(2_500);
  });

  it("rejects nonsensical construction", () => {
    expect(() => new RateLimiter({ max: 0, windowMs: 1_000 })).toThrow(RangeError);
    expect(() => new RateLimiter({ max: 1, windowMs: 0 })).toThrow(RangeError);
  });

  it("sweeps expired windows", () => {
    let t = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 1_000, now: () => t });
    limiter.hit("a");
    limiter.hit("b");
    t = 2_000;
    expect(limiter.sweep()).toBe(0);
  });
});
