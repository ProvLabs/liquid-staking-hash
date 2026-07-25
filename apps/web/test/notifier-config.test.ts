// Notifier config boundary (plan 6.2 §4.2): every input bounded at entry, and
// the two required secrets fail-fast (a notifier without its store or its
// minting key is worse than one that never boots).

import { describe, expect, it } from "vitest";
import { loadNotifierConfig } from "../notifier/config.ts";

const BASE = {
  DATABASE_URL: "postgresql://app_writer:app-dev@localhost:5433/nvhash?schema=app",
  API_SERVICE_ASSERTION_KEY: "a".repeat(32),
  API_BASE_URL: "http://api.test",
} as NodeJS.ProcessEnv;

describe("loadNotifierConfig", () => {
  it("parses a valid env with the documented defaults", () => {
    const config = loadNotifierConfig(BASE);
    expect(config.tickSeconds).toBe(60);
    expect(config.factLimit).toBe(200);
    expect(config.apiBaseUrl).toBe("http://api.test");
  });

  it("falls back to API_URL when API_BASE_URL is unset", () => {
    const { API_BASE_URL: _omit, ...rest } = BASE;
    const config = loadNotifierConfig({ ...rest, API_URL: "http://api.fallback" });
    expect(config.apiBaseUrl).toBe("http://api.fallback");
  });

  it("fails fast without DATABASE_URL (the store is required)", () => {
    const { DATABASE_URL: _omit, ...rest } = BASE;
    expect(() => loadNotifierConfig(rest)).toThrow(/notifier configuration/i);
  });

  it("fails fast on a too-short assertion key (< 32 chars)", () => {
    expect(() => loadNotifierConfig({ ...BASE, API_SERVICE_ASSERTION_KEY: "short" })).toThrow();
  });

  it("rejects out-of-range tick cadence and fact limit (bounded, never clamped)", () => {
    expect(() => loadNotifierConfig({ ...BASE, NOTIFIER_TICK_SECONDS: "5" })).toThrow(); // < 10
    expect(() => loadNotifierConfig({ ...BASE, NOTIFIER_TICK_SECONDS: "601" })).toThrow(); // > 600
    expect(() => loadNotifierConfig({ ...BASE, NOTIFIER_FACT_LIMIT: "501" })).toThrow(); // > 500
  });

  it("rejects a non-postgres DATABASE_URL and a non-http API base", () => {
    expect(() => loadNotifierConfig({ ...BASE, DATABASE_URL: "mysql://x" })).toThrow();
    expect(() => loadNotifierConfig({ ...BASE, API_BASE_URL: "ftp://x" })).toThrow();
  });
});
