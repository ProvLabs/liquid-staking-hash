// Test-side assertion minting — the exact wire format the web tier's session
// layer will produce (ADR-001 Decision 2; recorded in app-spec §9.4):
//   Bearer base64url({scope,iat,exp}) "." base64url(HMAC-SHA256(key, payloadB64))
// Kept in one helper so every suite mints identically and a format change is
// one edit here plus the spec revision it requires.

import { createHmac } from "node:crypto";

/** ≥32 chars per the config bound; fixed so failures reproduce. */
export const TEST_ASSERTION_KEY = "m3-test-assertion-key-0123456789abcdef";

export interface MintOptions {
  readonly iat?: number;
  readonly exp?: number;
  /** Sign with a different key (bad-signature cases). */
  readonly key?: string;
}

export function mintAssertion(scope: string, opts: MintOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const iat = opts.iat ?? now;
  const exp = opts.exp ?? iat + 55;
  const payload = Buffer.from(JSON.stringify({ scope, iat, exp })).toString("base64url");
  const sig = createHmac("sha256", opts.key ?? TEST_ASSERTION_KEY)
    .update(payload)
    .digest("base64url");
  return `Bearer ${payload}.${sig}`;
}
