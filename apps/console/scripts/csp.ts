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
  if (origin === "null" || origin.endsWith("://")) {
    throw new Error(`CSP: "${lcdUrl}" resolves to no exact origin`);
  }
  const sources = ["'self'", origin];
  if (mode === "devnet") sources.push("http://localhost:*");
  return sources.join(" ");
}
