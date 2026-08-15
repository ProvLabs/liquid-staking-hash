// CSP `connect-src` generation (PR 8.4b §2.5). ONE source: the same
// VITE_LCD_URL the app itself queries (src/data/lcd.ts), so a wrong CSP pin
// and a wrong data plane are the same visible defect, never two drifting
// lists. The build FAILS CLOSED — an unparseable URL, a wildcard, or a
// blanket scheme throws here rather than shipping a wide or wrong pin
// (SECURITY.md: injected code must not be able to exfiltrate to arbitrary
// hosts from a publicly reachable page users connect wallets to, D22).

/**
 * The `connect-src` value for one build profile: `'self'` + the EXACT origin
 * of the profile's LCD, plus `http://localhost:*` ONLY for the devnet
 * profile (the dev node and Vite's own proxy live there).
 *
 * Throws on: an unparseable `lcdUrl`, any wildcard in the host, a bare
 * scheme (`https:`), or a non-http(s) scheme — every path that would widen
 * the pin fails the build instead.
 */
export function connectSrcFor(mode: string, lcdUrl: string): string {
  if (lcdUrl.includes("*")) {
    throw new Error(`CSP: wildcard in VITE_LCD_URL is not a pin: ${lcdUrl}`);
  }
  let origin: string;
  try {
    const url = new URL(lcdUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`non-http(s) scheme ${url.protocol}`);
    }
    if (url.host === "") throw new Error("no host");
    origin = url.origin;
  } catch (cause) {
    throw new Error(
      `CSP: VITE_LCD_URL must be a full http(s) URL with a host; got "${lcdUrl}" (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    );
  }
  // `new URL("https:")` and friends can yield the literal "null" origin —
  // a blanket scheme is exactly the widening this generator exists to refuse.
  if (origin === "null" || origin.endsWith("://")) {
    throw new Error(`CSP: "${lcdUrl}" resolves to no exact origin`);
  }
  const sources = ["'self'", origin];
  if (mode === "devnet") sources.push("http://localhost:*");
  return sources.join(" ");
}
