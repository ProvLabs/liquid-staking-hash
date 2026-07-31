// Notifier config boundary: every input bounded at entry, and
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

  it("push is optional: no VAPID → vapid undefined (in-app only, §10.4)", () => {
    expect(loadNotifierConfig(BASE).vapid).toBeUndefined();
  });

  // Well-formed VAPID values (the shapes real `web-push generate-vapid-keys`
  // output takes: base64url, P-256 point / scalar lengths).
  const VAPID_OK = {
    WEB_PUSH_VAPID_PUBLIC_KEY: `B${"x".repeat(86)}`,
    WEB_PUSH_VAPID_PRIVATE_KEY: "y".repeat(43),
    WEB_PUSH_VAPID_SUBJECT: "mailto:ops@example.com",
  };

  it("assembles the VAPID triple when all three are set", () => {
    const config = loadNotifierConfig({ ...BASE, ...VAPID_OK });
    expect(config.vapid).toEqual({
      publicKey: VAPID_OK.WEB_PUSH_VAPID_PUBLIC_KEY,
      privateKey: VAPID_OK.WEB_PUSH_VAPID_PRIVATE_KEY,
      subject: "mailto:ops@example.com",
    });
  });

  it("a MALFORMED VAPID value is a boot error, not a per-send failure (fail-fast)", () => {
    // The web config bounds these shapes at boot (config.server.ts); the
    // notifier — the process that actually signs — must too, or a bad value
    // degrades to an every-send scrubbed drop that looks like transport trouble.
    expect(() =>
      loadNotifierConfig({ ...BASE, ...VAPID_OK, WEB_PUSH_VAPID_PUBLIC_KEY: "not-a-key" }),
    ).toThrow();
    expect(() =>
      loadNotifierConfig({ ...BASE, ...VAPID_OK, WEB_PUSH_VAPID_PRIVATE_KEY: "!" }),
    ).toThrow();
    expect(() =>
      loadNotifierConfig({ ...BASE, ...VAPID_OK, WEB_PUSH_VAPID_SUBJECT: "ops@example.com" }),
    ).toThrow();
  });

  it("a PARTIAL VAPID config is a boot error (all-or-none)", () => {
    expect(() => loadNotifierConfig({ ...BASE, WEB_PUSH_VAPID_PUBLIC_KEY: "pub" })).toThrow(
      /all set|all unset/,
    );
    expect(() =>
      loadNotifierConfig({
        ...BASE,
        WEB_PUSH_VAPID_PUBLIC_KEY: "pub",
        WEB_PUSH_VAPID_PRIVATE_KEY: "priv",
      }),
    ).toThrow(/all set|all unset/);
  });
});
