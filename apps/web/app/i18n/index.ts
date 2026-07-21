// $lang+ i18n (app-spec §8.0, nuva pattern): routes live under an optional
// locale segment; `en` is the launch locale (spec §14.9 — DECIDE, `en`
// assumed; confirmed at plan PR 8.5). Adding a locale = add a catalog with the
// exact `en` key set (gated by test/i18n-coverage.test.ts) and list it here.

import en from "./locales/en";

export const SUPPORTED_LOCALES = ["en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export type MessageKey = keyof typeof en;

export const catalogs: Record<Locale, Record<MessageKey, string>> = { en };

export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Resolve a route `:lang?` param: absent → default; unsupported → null. */
export function resolveLocale(param: string | undefined): Locale | null {
  if (param === undefined) return DEFAULT_LOCALE;
  return isLocale(param) ? param : null;
}

/**
 * Translate a key for a locale. Keys are typed against the `en` catalog.
 * `{name}` placeholders are filled from `params`; an unknown placeholder is
 * left verbatim (a visible bug beats a silent blank).
 */
export function t(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const message = catalogs[locale][key];
  if (params === undefined) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
