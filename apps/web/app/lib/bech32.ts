// Bech32 SHAPE predicates — the ONE definition of what a valoper string may
// look like in this app (2026-07-28 review: the same literal had been copied to
// five places under `app/`, so a change to the pattern could land in one and
// miss four).
//
// Client-safe on purpose. The pattern is needed by a client component (the
// enroll input on `/validators/mine`), a route loader, two server route
// schemas, and the relay's transaction guard, so it CANNOT live in
// `adr36-verify.server.ts` — that module holds the app's bech32 primitives but
// is server-only (it carries the @noble/@scure signature surface). Shape lives
// here; anything needing a decoded payload still goes there.
//
// Shape only, deliberately NOT a checksum verification — the same posture
// `services/api`'s `bech32ValoperSchema` takes: a well-formed address that
// does not exist simply matches nothing, while malformed input is rejected at
// the boundary before any read or build runs. `services/api` keeps its own
// copy because it is a separate service with no shared package; that is the one
// duplicate this module does not remove.

/**
 * Bech32 VALIDATOR-operator address. The `valoper` HRP suffix is required, so
 * an ACCOUNT address can never be accepted where a validator operator address
 * is meant. Charset excludes `b`/`i`/`o`/`1`; total length is bounded by the
 * spec's 90-char ceiling.
 */
export const VALOPER_RE = /^[a-z]{1,10}valoper1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,83}$/;

/** True when `value` has the shape of a bech32 valoper address. */
export function isValoperAddress(value: string): boolean {
  return VALOPER_RE.test(value);
}
