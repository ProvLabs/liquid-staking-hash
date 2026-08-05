// The `admin:` assertion GATE (ADR-001 Decision 2, amendment 2026-07-28) — the
// only sanctioned caller of `mintAdminAssertion`, and the reason that function
// can stay pure.
//
// It is a separate module from `assertion.server.ts` for a concrete reason:
// `notifier/index.ts` imports the minting module directly under Node's
// strip-only TS, and it must not acquire a runtime dependency on the chain
// client to do so. Minting stays dependency-free; the precondition lives here,
// where it can read the chain.

import type { WebConfig } from "~/config/config.server";
import { mintAdminAssertion } from "./assertion.server";
import { verifyAdminUncached, type RoleDeps } from "./roles.server";

/** Why {@link adminApiHeaders} minted nothing — the caller renders the state. */
export type AdminHeadersDenial =
  /** No `API_SERVICE_ASSERTION_KEY`; the API fails closed on its side too. */
  | "unconfigured"
  /** The membership read failed. We do not know, so we do not grant (§12.1). */
  | "degraded"
  /** The read succeeded and this address is not a member. */
  | "not-admin";

export type AdminHeadersResult =
  | { readonly ok: true; readonly headers: { Authorization: string } }
  | { readonly ok: false; readonly reason: AdminHeadersDenial };

/**
 * Headers for a §8.8 admin read scoped to the session address — **the only
 * path by which an `admin:` assertion is minted.**
 *
 * The security-critical part is the ordering: membership is read FRESH from
 * chain (`verifyAdminUncached`, which neither consults nor populates the 60 s
 * role cache) and the assertion is minted only after that read succeeds AND
 * reports membership. A degraded read mints nothing — `{ ok: false, reason:
 * "degraded" }`, which the caller renders as "we could not check", never as a
 * grant and never as a denial of fact.
 *
 * What this does NOT do, stated because the ADR amendment must not overclaim:
 * it does not reduce the stale-admin window to zero. A revoked member's next
 * request fails, but an assertion already minted stays valid for its remaining
 * lifetime — so the residual window is the assertion's ≤ 60 s, not the cache's
 * 60 s **plus** the assertion's.
 *
 * `nowSeconds` is injectable for deterministic tests.
 */
export async function adminApiHeaders(
  config: WebConfig,
  sessionAddress: string,
  deps: RoleDeps = {},
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AdminHeadersResult> {
  if (config.apiServiceAssertionKey === undefined) return { ok: false, reason: "unconfigured" };
  const check = await verifyAdminUncached(config, sessionAddress, deps);
  if (check.degraded) return { ok: false, reason: "degraded" };
  if (!check.admin) return { ok: false, reason: "not-admin" };
  return {
    ok: true,
    headers: {
      Authorization: mintAdminAssertion(config.apiServiceAssertionKey, sessionAddress, nowSeconds),
    },
  };
}
