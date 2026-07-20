// Auto/Light/Dark theming (app plan PR 1.3). The preference is a cookie so SSR
// renders the right theme on first paint; "auto" means no `data-theme`
// attribute and the CSS `color-scheme: light dark` + `light-dark()` tokens
// follow the OS preference. The cookie holds one of three enum values and
// nothing else — it is bounded input like any other (SECURITY.md), and it is
// not identity: no session or address ever rides on it.

export const THEMES = ["auto", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "auto";
export const THEME_COOKIE = "nvhash-theme";

export function isTheme(value: string | undefined): value is Theme {
  return value !== undefined && (THEMES as readonly string[]).includes(value);
}

/** Parse the theme from a Cookie header; anything unrecognized is "auto". */
export function themeFromCookieHeader(header: string | null): Theme {
  if (!header) return DEFAULT_THEME;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== THEME_COOKIE) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return DEFAULT_THEME;
    }
    return isTheme(value) ? value : DEFAULT_THEME;
  }
  return DEFAULT_THEME;
}

export function nextTheme(current: Theme): Theme {
  const i = THEMES.indexOf(current);
  return THEMES[(i + 1) % THEMES.length] ?? DEFAULT_THEME;
}

/** Client-side apply + persist (SSR reads the cookie back on next request). */
export function applyTheme(theme: Theme) {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  document.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
