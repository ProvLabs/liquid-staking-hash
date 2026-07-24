// Service-assertion minting (ADR-001 Decision 2; plan 5.1 §3). The OTHER
// half of the one contract services/api verifies in `services/api/src/auth.ts`
// — same wire format, same bounds:
//
//   Authorization: Bearer <base64url(payload JSON)>.<base64url(hmac)>
//   payload = { "scope": "address:<bech32>", "iat": <s>, "exp": <s> }
//   hmac    = HMAC-SHA256(API_SERVICE_ASSERTION_KEY, base64url(payload JSON))
//
// Lifetime is pinned to the verifier's MAX_ASSERTION_LIFETIME_SECONDS (60 s);
// drift between the two implementations is caught by the SHARED golden
// vectors cross-pinned in both suites (test/assertion.test.ts here and
// services/api/test/assertion-vectors.test.ts) — a vector change fails both
// packages until they move together.
//
// The key is server-only (bundle-secret gate) and never reaches this module
// unbounded: config enforces ≥ 32 chars at the boundary. Assertions are
// minted per request, scoped to the SESSION address only — the session layer
// is the sole caller, so a cross-address assertion cannot be minted from
// user input (and the API's cross-address 403 gate stands regardless).

import { createHmac } from "node:crypto";

/** Mirror of services/api auth.ts MAX_ASSERTION_LIFETIME_SECONDS. */
export const ASSERTION_LIFETIME_SECONDS = 60;

/**
 * Mint the Authorization header value for an address-scoped read at
 * `nowSeconds`. Deterministic over its inputs (clock injected) — the golden
 * vectors pin exact output strings.
 */
export function mintAddressAssertion(
  key: string,
  address: string,
  nowSeconds: number,
): string {
  // Field order is fixed (scope, iat, exp) so the serialized payload — and
  // therefore the golden vectors — are byte-stable.
  const payload = JSON.stringify({
    scope: `address:${address}`,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_LIFETIME_SECONDS,
  });
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = createHmac("sha256", key).update(payloadB64).digest("base64url");
  return `Bearer ${payloadB64}.${sig}`;
}

/**
 * Mint the Authorization header for the notifier's `internal:notifier` reads
 * (M6.2; ADR-001 Decision 3). Same wire format, field order, lifetime, and
 * key as {@link mintAddressAssertion} — only the scope literal differs
 * (`internal:notifier`, no address). Cross-address by nature and never granting
 * a personal endpoint (services/api enforces both). The internal golden vector
 * in test/assertion.test.ts pins this output byte-for-byte against the
 * verifier's cross-pinned vector.
 */
export function mintInternalAssertion(key: string, nowSeconds: number): string {
  const payload = JSON.stringify({
    scope: "internal:notifier",
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_LIFETIME_SECONDS,
  });
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = createHmac("sha256", key).update(payloadB64).digest("base64url");
  return `Bearer ${payloadB64}.${sig}`;
}

/**
 * Headers for a personal services/api read scoped to the session address.
 * Null when no minting key is configured: the caller degrades honestly
 * (the API fails closed on its side regardless — one contract, two ends).
 */
export function personalApiHeaders(
  config: { apiServiceAssertionKey?: string | undefined },
  sessionAddress: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { Authorization: string } | null {
  if (config.apiServiceAssertionKey === undefined) return null;
  return {
    Authorization: mintAddressAssertion(config.apiServiceAssertionKey, sessionAddress, nowSeconds),
  };
}
