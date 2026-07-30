// Deterministic display formatting for the governance center. PURE.
//
// Every function here produces the SAME string on the server and in the
// browser. That is not a style preference: these values are rendered during SSR
// and hydrated, so a locale- or clock-dependent format would produce a
// hydration mismatch — and, worse for this page, a time that differs between
// two readers of the same proposal.

import { t, type Locale } from "~/i18n";

/** `2026-07-29T23:27:10.340Z` → `2026-07-29 23:27 UTC`. UTC is explicit rather
 * than local: a governance deadline read in the wrong timezone is a missed
 * vote, and the zone must therefore be on the page rather than assumed. */
export function formatInstant(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A coarse duration for the SECONDARY countdown hint (§7 Q2). Deliberately
 * coarse and deliberately approximate: it is computed against the server clock,
 * and the absolute expiry beside it is the fact this hint is not.
 */
export function formatDuration(locale: Locale, seconds: number): string {
  if (seconds >= DAY) {
    const count = Math.floor(seconds / DAY);
    return count === 1
      ? t(locale, "governance.duration-day", { count })
      : t(locale, "governance.duration-days", { count });
  }
  if (seconds >= HOUR) {
    const count = Math.floor(seconds / HOUR);
    return count === 1
      ? t(locale, "governance.duration-hour", { count })
      : t(locale, "governance.duration-hours", { count });
  }
  if (seconds >= MINUTE) {
    const count = Math.floor(seconds / MINUTE);
    return count === 1
      ? t(locale, "governance.duration-minute", { count })
      : t(locale, "governance.duration-minutes", { count });
  }
  return seconds === 1
    ? t(locale, "governance.duration-second", { count: seconds })
    : t(locale, "governance.duration-seconds", { count: seconds });
}

/** Middle-truncate a bech32 address for a dense table cell. The full value is
 * always available as the element's `title`, so nothing is only truncated. */
export function shortAddress(address: string): string {
  return address.length <= 20 ? address : `${address.slice(0, 10)}…${address.slice(-6)}`;
}
