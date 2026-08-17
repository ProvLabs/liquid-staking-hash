// Shared module for the k6 load scenarios (8.2 §2.3). Plain JS executed by
// the k6 runtime (not Node): joins no pnpm workspace, adds no npm dependency.
//
// Assertion minting mirrors services/api/test/assertions.ts exactly —
// Bearer base64url({scope,iat,exp}) "." base64url(HMAC-SHA256(key, payloadB64))
// — so the harness exercises the API's real in-process verification path
// (ADR-001 Decision 2) without the web tier. C6: assertions are minted per
// request (exp − iat ≤ 60 s), so a long-running VU never carries a stale one.

import crypto from "k6/crypto";
import encoding from "k6/encoding";

/** In-network API base — the runner refuses anything else (invariant 3). */
export const BASE = __ENV.API_BASE_URL || "http://api:8080";
export const API = `${BASE}/api/v1`;

const KEY = __ENV.API_SERVICE_ASSERTION_KEY || "";

export function mintAssertion(scope) {
  const now = Math.floor(Date.now() / 1000);
  const payload = encoding.b64encode(JSON.stringify({ scope, iat: now, exp: now + 55 }), "rawurl");
  const sig = crypto.hmac("sha256", KEY, payload, "base64rawurl");
  return `Bearer ${payload}.${sig}`;
}

/** Request params carrying a freshly minted scoped assertion + endpoint tag. */
export function scoped(scope, endpointTag) {
  return {
    headers: { Authorization: mintAssertion(scope) },
    tags: { endpoint: endpointTag },
  };
}

/** Request params with the endpoint tag only (public routes). */
export function tagged(endpointTag) {
  return { tags: { endpoint: endpointTag } };
}

/** The bech32 data charset — synthetic per-VU addresses, valid-shape only. */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** Deterministic synthetic address per (vu, seed) — never a real one. */
export function vuAddress(vu) {
  let s = "";
  let x = (vu * 2654435761) >>> 0;
  for (let i = 0; i < 38; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    s += CHARSET[x % CHARSET.length];
  }
  return `pb1${s}`;
}

/** The seeded heavy identities (printed by seed:load; exported by run.sh). */
export const HEAVY_ADDRESS = __ENV.HEAVY_ADDRESS || "";
export const HEAVY_VALOPER = __ENV.HEAVY_VALOPER || "";
