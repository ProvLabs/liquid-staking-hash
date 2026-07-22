// Unit: configuration is validated and bounded at the boundary (SECURITY.md).
// An out-of-range value is an error, never a silent clamp.

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("accepts a postgres DATABASE_URL and rejects other schemes (bounded)", () => {
    const url = "postgresql://api_reader:pw@postgres:5432/nvhash?schema=indexed";
    expect(loadConfig({ DATABASE_URL: url }).databaseUrl).toBe(url);
    expect(loadConfig({ DATABASE_URL: "postgres://u:p@h:5432/db" }).databaseUrl).toBeDefined();
    expect(() => loadConfig({ DATABASE_URL: "mysql://u:p@h/db" })).toThrow(/configuration/i);
    expect(() => loadConfig({ DATABASE_URL: "not a url" })).toThrow(/configuration/i);
  });

  it("leaves databaseUrl unset when absent (dataless is a valid state)", () => {
    expect(loadConfig({}).databaseUrl).toBeUndefined();
  });

  it("applies safe defaults on an empty environment", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      appEnv: "development",
      port: 8080,
      rateLimitMax: 120,
      rateLimitWindowMs: 60_000,
      trustProxy: false,
    });
  });

  it("parses and coerces provided values", () => {
    const config = loadConfig({ APP_ENV: "production", PORT: "3000", RATE_LIMIT_MAX: "10", RATE_LIMIT_WINDOW_MS: "5000", TRUST_PROXY: "true" });
    expect(config).toEqual({ appEnv: "production", port: 3000, rateLimitMax: 10, rateLimitWindowMs: 5000, trustProxy: true });
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadConfig({ PORT: "70000" })).toThrow(/Invalid API configuration/);
    expect(() => loadConfig({ PORT: "0" })).toThrow(/Invalid API configuration/);
  });

  it("rejects a non-integer / non-positive rate limit", () => {
    expect(() => loadConfig({ RATE_LIMIT_MAX: "0" })).toThrow(/Invalid API configuration/);
    expect(() => loadConfig({ RATE_LIMIT_WINDOW_MS: "10" })).toThrow(/Invalid API configuration/); // below 1s floor
  });

  it("rejects an unknown APP_ENV", () => {
    expect(() => loadConfig({ APP_ENV: "prod" })).toThrow(/Invalid API configuration/);
  });
});
