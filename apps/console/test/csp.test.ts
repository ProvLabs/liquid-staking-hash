import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectSrcFor } from "../scripts/csp";

describe("connectSrcFor — exact origin per profile", () => {
  it("pins the exact origin of the profile's LCD, nothing else", () => {
    expect(connectSrcFor("test", "https://lcd.test.provenance.io")).toBe(
      "'self' https://lcd.test.provenance.io",
    );
    expect(connectSrcFor("production", "https://lcd.provenance.io")).toBe(
      "'self' https://lcd.provenance.io",
    );
    // The origin is the ORIGIN — a path or trailing slash never leaks in.
    expect(connectSrcFor("test", "https://api.test.provenance.io/some/base/")).toBe(
      "'self' https://api.test.provenance.io",
    );
  });

  it("a test-profile pin does not carry the mainnet host and vice versa", () => {
    expect(connectSrcFor("test", "https://lcd.test.provenance.io")).not.toContain(
      "lcd.provenance.io ",
    );
    expect(connectSrcFor("production", "https://lcd.provenance.io")).not.toContain("test");
  });

  it("localhost joins ONLY the devnet profile", () => {
    expect(connectSrcFor("devnet", "http://localhost:1317")).toBe(
      "'self' http://localhost:1317 http://localhost:*",
    );
    expect(connectSrcFor("test", "https://lcd.test.provenance.io")).not.toContain("localhost");
    expect(connectSrcFor("production", "https://lcd.provenance.io")).not.toContain("localhost");
  });

  it("throws on every widening path — the build fails closed", () => {
    expect(() => connectSrcFor("test", "https:")).toThrow();
    expect(() => connectSrcFor("test", "https://*")).toThrow(/wildcard/);
    expect(() => connectSrcFor("test", "https://*.provenance.io")).toThrow(/wildcard/);
    expect(() => connectSrcFor("test", "not a url")).toThrow(/full http\(s\) URL/);
    expect(() => connectSrcFor("test", "")).toThrow();
    expect(() => connectSrcFor("test", "ftp://lcd.provenance.io")).toThrow();
    expect(() => connectSrcFor("test", "wss://lcd.provenance.io")).toThrow();
  });
});

describe("index.html carries the token, never a hand-pinned host list", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  it("the source HTML has the token and no literal LCD host", () => {
    expect(html).toContain("__CSP_CONNECT_SRC__");
    expect(html).not.toContain("lcd.provenance.io");
    expect(html).not.toContain("lcd.test.provenance.io");
  });
});

describe("the BUILT HTML pins the profile's origin (reads dist/, not a stand-in)", () => {
  const distHtml = new URL("../dist/index.html", import.meta.url);
  it.skipIf(!existsSync(distHtml))(
    "the test build carries the test LCD origin and NOT the mainnet one",
    () => {
      const built = readFileSync(distHtml, "utf8");
      expect(built).not.toContain("__CSP_CONNECT_SRC__");
      expect(built).toContain("connect-src 'self' https://lcd.test.provenance.io");
      expect(built).not.toContain("https://lcd.provenance.io");
      expect(built).not.toContain("localhost");
    },
  );
});
