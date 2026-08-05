// biome-ignore-all lint/suspicious/noExportsInTest: these vectors are the
// SHARED half of a cross-suite pin — services/api/test/assertion-vectors.test.ts
// imports them so both sides assert the same bytes rather than two copies.
// Assertion-minting gate (ADR-001 Decision 2): the web tier
// mints EXACTLY what services/api verifies — one contract, two
// implementations. The golden vectors below are CROSS-PINNED: the identical
// literals live in services/api/test/assertion-vectors.test.ts, verified by
// the API's own verifyAssertion. A change to either implementation fails one
// side until both move together.
//
// The vector key is a test literal, not a secret (SECURITY.md: devnet/test
// material only).

import { describe, expect, it } from "vitest";

import {
  ASSERTION_LIFETIME_SECONDS,
  mintAddressAssertion,
  mintAdminAssertion,
  mintInternalAssertion,
  personalApiHeaders,
} from "~/lib/services/assertion.server";

// ── SHARED GOLDEN VECTOR (cross-pinned with services/api) ────────────────
export const VECTOR_KEY = "nvhash-assertion-golden-vector-key-0123456789abcdef";
export const VECTOR_ADDRESS = "tp1l39wu7cht0zcycc5rkcd90sdd4ksjmxwdf388y";
export const VECTOR_IAT = 1_750_000_000;
export const VECTOR_HEADER =
  "Bearer eyJzY29wZSI6ImFkZHJlc3M6dHAxbDM5d3U3Y2h0MHpjeWNjNXJrY2Q5MHNkZDRrc2pteHdkZjM4OHkiLCJpYXQiOjE3NTAwMDAwMDAsImV4cCI6MTc1MDAwMDA2MH0.QgKm9gljB0IjyLvWnH60oT-J549e08V5UW3_SO3apIU";
// The internal:notifier vector — IDENTICAL to the literal in
// services/api/test/assertion-vectors.test.ts.
export const VECTOR_INTERNAL_HEADER =
  "Bearer eyJzY29wZSI6ImludGVybmFsOm5vdGlmaWVyIiwiaWF0IjoxNzUwMDAwMDAwLCJleHAiOjE3NTAwMDAwNjB9.4lQonJSxF49FCo2K7mV4YXnnSiiRZiUv0-1UCw7_DsQ";
// The admin:<bech32> vector (ADR-001 Decision 2, amendment 2026-07-28) —
// IDENTICAL to the literal in services/api/test/assertion-vectors.test.ts.
export const VECTOR_ADMIN_HEADER =
  "Bearer eyJzY29wZSI6ImFkbWluOnRwMWwzOXd1N2NodDB6Y3ljYzVya2NkOTBzZGQ0a3NqbXh3ZGYzODh5IiwiaWF0IjoxNzUwMDAwMDAwLCJleHAiOjE3NTAwMDAwNjB9.tMsTx8S-yCi74FfCttrEJoaqn8qWIUixrhjxLmfUQYc";
// ─────────────────────────────────────────────────────────────────────────

describe("service-assertion minting (ADR-001 Decision 2)", () => {
  it("mints the exact golden-vector header", () => {
    expect(mintAddressAssertion(VECTOR_KEY, VECTOR_ADDRESS, VECTOR_IAT)).toBe(VECTOR_HEADER);
  });

  it("lifetime is pinned to the verifier's 60 s bound", () => {
    expect(ASSERTION_LIFETIME_SECONDS).toBe(60);
    const header = mintAddressAssertion(VECTOR_KEY, VECTOR_ADDRESS, VECTOR_IAT);
    const payload = JSON.parse(
      Buffer.from(header.slice("Bearer ".length).split(".")[0]!, "base64url").toString("utf8"),
    ) as { iat: number; exp: number; scope: string };
    expect(payload.exp - payload.iat).toBe(60);
    expect(payload.scope).toBe(`address:${VECTOR_ADDRESS}`);
  });

  it("personalApiHeaders is null without a configured key (degrade honestly)", () => {
    expect(personalApiHeaders({ apiServiceAssertionKey: undefined }, VECTOR_ADDRESS)).toBeNull();
    const headers = personalApiHeaders(
      { apiServiceAssertionKey: VECTOR_KEY },
      VECTOR_ADDRESS,
      VECTOR_IAT,
    );
    expect(headers).toEqual({ Authorization: VECTOR_HEADER });
  });

  it("mints the internal:notifier golden-vector header (M6.2, cross-pinned)", () => {
    expect(mintInternalAssertion(VECTOR_KEY, VECTOR_IAT)).toBe(VECTOR_INTERNAL_HEADER);
    const payload = JSON.parse(
      Buffer.from(
        VECTOR_INTERNAL_HEADER.slice("Bearer ".length).split(".")[0]!,
        "base64url",
      ).toString("utf8"),
    ) as { iat: number; exp: number; scope: string };
    expect(payload.scope).toBe("internal:notifier");
    expect(payload.exp - payload.iat).toBe(60);
  });

  it("mints the admin:<bech32> golden-vector header (cross-pinned)", () => {
    expect(mintAdminAssertion(VECTOR_KEY, VECTOR_ADDRESS, VECTOR_IAT)).toBe(VECTOR_ADMIN_HEADER);
    const payload = JSON.parse(
      Buffer.from(VECTOR_ADMIN_HEADER.slice("Bearer ".length).split(".")[0]!, "base64url").toString(
        "utf8",
      ),
    ) as { iat: number; exp: number; scope: string };
    // The envelope is UNCHANGED by the new scope: same field order, same
    // 60 s lifetime. Only the scope literal differs.
    expect(payload.scope).toBe(`admin:${VECTOR_ADDRESS}`);
    expect(payload.exp - payload.iat).toBe(ASSERTION_LIFETIME_SECONDS);
  });
});
