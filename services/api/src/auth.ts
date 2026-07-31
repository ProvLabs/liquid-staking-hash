// In-process service-assertion verification (ADR-001 Decision 2). The web
// tier's session layer mints a short-lived HMAC assertion per
// request; this module verifies it INSIDE the API process — never a caller
// or network-topology assumption. The cross-address-rejection contract tests
// (test/cross-address.test.ts) are a standing CI gate for this service.
//
// Wire format (recorded in ADR-001 Decision 2 and app-spec §9.4 in the same
// change as this file — both sides implement ONE contract):
//
//   Authorization: Bearer <base64url(payload JSON)>.<base64url(hmac)>
//
//   payload = { "scope": "address:<bech32>" | "internal:notifier"
//                        | "admin:<bech32>",
//               "iat": <unix seconds>, "exp": <unix seconds> }
//   hmac    = HMAC-SHA256(API_SERVICE_ASSERTION_KEY, base64url(payload JSON))
//
// Verification, all failures → 401 with no distinguishing detail (an
// attacker learns nothing about WHICH check failed):
//   1. key configured (absent key = fail closed — no assertion can verify)
//   2. header shape + base64url decode + payload zod bounds
//   3. constant-time signature compare (timingSafeEqual over equal-length
//      digests — never a string comparison)
//   4. freshness: exp not passed; exp − iat ≤ 60 s (ADR-001); iat not in
//      the future beyond a small clock-skew allowance ([R7d])
//   5. scope parse into the closed union below
// The scope↔target-address equality (403) is NOT here: it needs the
// zod-parsed query, so the handler enforces it after query validation
// ([R4] pipeline order).

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { bech32AddressSchema } from "./query.ts";

/** ADR-001: `exp − iat ≤ 60 s`. */
export const MAX_ASSERTION_LIFETIME_SECONDS = 60;
/** [R7d] tolerated forward clock skew on `iat`. */
export const MAX_CLOCK_SKEW_SECONDS = 10;

/**
 * Verified scopes, as a closed union (never a raw string past this module).
 *
 * `admin` carries an address like `address` does, but it is NOT a personal
 * grant and the handler never matches it against a `?address=` target: §8.8
 * data is program-wide. The address rides so an admin request is attributable,
 * and so the two kinds can never be conflated by structural equality.
 */
export type VerifiedScope =
  | { readonly kind: "address"; readonly address: string }
  | { readonly kind: "internal"; readonly service: "notifier" }
  | { readonly kind: "admin"; readonly address: string };

export type VerifyResult =
  | { readonly ok: true; readonly scope: VerifiedScope }
  | { readonly ok: false };

const FAIL: VerifyResult = { ok: false };

/** Payload bounds (SECURITY.md: validate at the boundary; reject, not clamp). */
const payloadSchema = z.object({
  scope: z.string().min(1).max(128),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
});

function parseScope(raw: string): VerifiedScope | null {
  if (raw === "internal:notifier") return { kind: "internal", service: "notifier" };
  if (raw.startsWith("address:")) {
    const address = raw.slice("address:".length);
    if (bech32AddressSchema.safeParse(address).success) return { kind: "address", address };
  }
  // ADR-001 Decision 2, amendment 2026-07-28. The address is bounded by the
  // same bech32 schema as `address:` — this service verifies the scope's SHAPE;
  // that the address is genuinely an admin was established by the web tier's
  // fresh on-chain read before minting, which is why the API keeps no chain
  // client (it has none by design).
  if (raw.startsWith("admin:")) {
    const address = raw.slice("admin:".length);
    if (bech32AddressSchema.safeParse(address).success) return { kind: "admin", address };
  }
  return null;
}

function b64urlDecode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
}

/**
 * Verify an `Authorization` header value against the configured key at time
 * `nowSeconds`. Pure over its inputs (clock injected) — deterministic in
 * tests. Returns the verified scope or a reasonless failure (401).
 */
export function verifyAssertion(
  header: string | undefined,
  key: string | undefined,
  nowSeconds: number,
): VerifyResult {
  // Fail closed: with no key configured, no assertion can ever verify.
  if (key === undefined || key.length === 0) return FAIL;
  if (header === undefined) return FAIL;

  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header);
  if (match === null) return FAIL;
  const [, payloadB64, sigB64] = match;
  if (payloadB64 === undefined || sigB64 === undefined) return FAIL;

  // Signature first (constant-time), so nothing about payload validity is
  // observable for an unsigned guess.
  const expected = createHmac("sha256", key).update(payloadB64).digest();
  const provided = b64urlDecode(sigB64);
  if (provided === null || provided.length !== expected.length) return FAIL;
  if (!timingSafeEqual(expected, provided)) return FAIL;

  const payloadBytes = b64urlDecode(payloadB64);
  if (payloadBytes === null) return FAIL;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return FAIL;
  }
  const payload = payloadSchema.safeParse(parsedJson);
  if (!payload.success) return FAIL;
  const { scope: rawScope, iat, exp } = payload.data;

  if (exp <= nowSeconds) return FAIL; // expired
  if (exp - iat > MAX_ASSERTION_LIFETIME_SECONDS) return FAIL; // over-long lifetime
  if (exp < iat) return FAIL; // malformed window
  if (iat > nowSeconds + MAX_CLOCK_SKEW_SECONDS) return FAIL; // [R7d] minted in the future

  const scope = parseScope(rawScope);
  if (scope === null) return FAIL;
  return { ok: true, scope };
}
