// In-memory fixed-window rate limiter (SECURITY.md: "APIs are read-only and
// defensive … rate-limit"; app-spec §9.4). A first-party limiter keeps the
// scaffold's dependency surface minimal (SECURITY.md dependency discipline).
//
// Scaffold scope: process-local counting is correct for a single instance and
// for CI. A shared store (e.g. Redis) for multi-instance deployments is a
// deployment-time concern (PR 8.2 load-test + tuning), not a scaffold decision;
// the interface here does not change when that lands.

/** Injectable clock so tests advance time deterministically (no wall-clock). */
export type Clock = () => number;

export interface RateLimitResult {
  allowed: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** Ceiling for the window (echoed as the `RateLimit-Limit` header). */
  limit: number;
  /** Epoch ms at which the current window resets. */
  resetAt: number;
}

interface WindowState {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  /** Max requests per window per key. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Time source; defaults to `Date.now`. */
  now?: Clock;
}

/**
 * Fixed-window limiter keyed by an opaque client identifier. The key is a
 * coarse network identifier (see `clientKey`), never linked to a wallet address
 * or persisted — data minimization holds for rate limiting too (SECURITY.md).
 */
export class RateLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: Clock;
  readonly #windows = new Map<string, WindowState>();

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.max) || options.max < 1) {
      throw new RangeError(`rate limit max must be a positive integer, got ${options.max}`);
    }
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1) {
      throw new RangeError(`rate limit windowMs must be a positive integer, got ${options.windowMs}`);
    }
    this.#max = options.max;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
  }

  /** Account one request for `key` and report whether it is allowed. */
  hit(key: string): RateLimitResult {
    const now = this.#now();
    const existing = this.#windows.get(key);
    let state: WindowState;
    if (existing === undefined || now >= existing.resetAt) {
      state = { count: 0, resetAt: now + this.#windowMs };
      this.#windows.set(key, state);
    } else {
      state = existing;
    }

    if (state.count >= this.#max) {
      return { allowed: false, remaining: 0, limit: this.#max, resetAt: state.resetAt };
    }
    state.count += 1;
    return {
      allowed: true,
      remaining: this.#max - state.count,
      limit: this.#max,
      resetAt: state.resetAt,
    };
  }

  /** Drop expired windows; call periodically if long-lived. Returns count kept. */
  sweep(): number {
    const now = this.#now();
    for (const [key, state] of this.#windows) {
      if (now >= state.resetAt) this.#windows.delete(key);
    }
    return this.#windows.size;
  }
}
