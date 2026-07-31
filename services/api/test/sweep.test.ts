// Regression: the rate limiter's window map grew unbounded
// because nothing in the long-lived entry point ever called `sweep()`. The fix
// wires `scheduleWindowSweep` into `main()`. This proves the helper actually
// sweeps on its interval and returns an unref'd timer (so it never by itself
// keeps the process alive).

import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimiter, scheduleWindowSweep } from "../src/index.ts";

describe("scheduleWindowSweep (long-lived limiter hygiene)", () => {
  afterEach(() => vi.useRealTimers());

  it("sweeps expired windows on each interval tick", () => {
    vi.useFakeTimers();
    let t = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 1_000, now: () => t });
    const sweepSpy = vi.spyOn(limiter, "sweep");
    const timer = scheduleWindowSweep(limiter, 1_000);
    try {
      limiter.hit("idle-client"); // records a window that will go stale
      t = 5_000; // both intervals below fall after it expired
      vi.advanceTimersByTime(2_000);
      expect(sweepSpy).toHaveBeenCalledTimes(2); // periodic, not one-shot
    } finally {
      clearInterval(timer);
    }
  });

  it("returns an unref'd timer so it cannot hold the event loop open", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000 });
    const timer = scheduleWindowSweep(limiter, 60_000);
    try {
      expect(timer.hasRef()).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });
});
