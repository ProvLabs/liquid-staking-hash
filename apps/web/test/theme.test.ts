// Theme cookie parsing: bounded input like any other — anything that is not
// one of the three enum values resolves to "auto", never an error or a
// pass-through of attacker-controlled cookie content.

import { describe, expect, it } from "vitest";

import { nextTheme, themeFromCookieHeader, THEMES } from "~/theme/theme";

describe("theme cookie", () => {
  it("parses each supported theme", () => {
    for (const theme of THEMES) {
      expect(themeFromCookieHeader(`nvhash-theme=${theme}`)).toBe(theme);
    }
  });

  it("defaults to auto on absent, foreign, or malformed cookies", () => {
    expect(themeFromCookieHeader(null)).toBe("auto");
    expect(themeFromCookieHeader("")).toBe("auto");
    expect(themeFromCookieHeader("other=1; nvhash-theme=neon")).toBe("auto");
    expect(themeFromCookieHeader("nvhash-theme")).toBe("auto");
    expect(themeFromCookieHeader("nvhash-theme=%00%01")).toBe("auto");
  });

  it("picks the named cookie among others", () => {
    expect(themeFromCookieHeader("a=b; nvhash-theme=dark; c=d")).toBe("dark");
  });

  it("cycles auto → light → dark → auto", () => {
    expect(nextTheme("auto")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("auto");
  });
});
