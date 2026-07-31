// Cross-pinned assertion golden vectors (ADR-001 Decision 2
// 5.1). The web tier's minter (apps/web/app/lib/services/assertion.server.ts)
// and this service's verifier implement ONE wire contract; these literals
// are IDENTICAL to apps/web/test/assertion.test.ts. If either implementation
// drifts, exactly one of the two suites fails — the contract cannot move on
// one side silently.

import { describe, expect, it } from "vitest";
import { verifyAssertion } from "../src/auth.ts";

// ── SHARED GOLDEN VECTOR (cross-pinned with apps/web) ────────────────────
const VECTOR_KEY = "nvhash-assertion-golden-vector-key-0123456789abcdef";
const VECTOR_ADDRESS = "tp1l39wu7cht0zcycc5rkcd90sdd4ksjmxwdf388y";
const VECTOR_IAT = 1_750_000_000;
const VECTOR_HEADER =
  "Bearer eyJzY29wZSI6ImFkZHJlc3M6dHAxbDM5d3U3Y2h0MHpjeWNjNXJrY2Q5MHNkZDRrc2pteHdkZjM4OHkiLCJpYXQiOjE3NTAwMDAwMDAsImV4cCI6MTc1MDAwMDA2MH0.QgKm9gljB0IjyLvWnH60oT-J549e08V5UW3_SO3apIU";
// The internal:notifier golden vector, same key/iat/exp, scope-only —
// IDENTICAL literals to apps/web/test/assertion.test.ts (`mintInternalAssertion`).
const VECTOR_INTERNAL_HEADER =
  "Bearer eyJzY29wZSI6ImludGVybmFsOm5vdGlmaWVyIiwiaWF0IjoxNzUwMDAwMDAwLCJleHAiOjE3NTAwMDAwNjB9.4lQonJSxF49FCo2K7mV4YXnnSiiRZiUv0-1UCw7_DsQ";
// ─────────────────────────────────────────────────────────────────────────

describe("web-minted assertion verifies here (one contract, two ends)", () => {
  it("verifies the golden-vector header within its lifetime", () => {
    const result = verifyAssertion(VECTOR_HEADER, VECTOR_KEY, VECTOR_IAT + 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scope).toEqual({ kind: "address", address: VECTOR_ADDRESS });
    }
  });

  it("rejects it once expired (exp = iat + 60)", () => {
    expect(verifyAssertion(VECTOR_HEADER, VECTOR_KEY, VECTOR_IAT + 61).ok).toBe(false);
  });

  it("rejects it under a different key", () => {
    expect(
      verifyAssertion(VECTOR_HEADER, "some-other-key-0123456789abcdefghij", VECTOR_IAT + 1).ok,
    ).toBe(false);
  });
});

describe("web-minted internal:notifier assertion verifies here (M6.2)", () => {
  it("verifies the internal golden-vector header to the notifier scope", () => {
    const result = verifyAssertion(VECTOR_INTERNAL_HEADER, VECTOR_KEY, VECTOR_IAT + 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scope).toEqual({ kind: "internal", service: "notifier" });
    }
  });

  it("rejects the internal vector once expired and under a different key", () => {
    expect(verifyAssertion(VECTOR_INTERNAL_HEADER, VECTOR_KEY, VECTOR_IAT + 61).ok).toBe(false);
    expect(
      verifyAssertion(VECTOR_INTERNAL_HEADER, "some-other-key-0123456789abcdefghij", VECTOR_IAT + 1)
        .ok,
    ).toBe(false);
  });
});
