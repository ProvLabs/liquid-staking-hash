// Gate: signing exists only behind the CLOSED wallet adapter
// registry — exactly the §14.1-decided v1 vendor set, with the decided
// transports. A vendor addition/removal or a transport change fails here
// until app-spec §14.1 is amended alongside (spec-recorded, never a config
// toggle).

import { describe, expect, it } from "vitest";

import { isVendorId, VENDOR_IDS, WALLET_VENDORS } from "~/wallet/adapter";
import { normalizePubkey, normalizeSignature } from "~/wallet/wc";

describe("closed wallet vendor registry (§14.1)", () => {
  it("holds exactly the decided v1 vendor set", () => {
    expect([...VENDOR_IDS].sort()).toEqual(["arculus", "figure-extension", "figure-mobile"]);
  });

  it("pins the decided transport per vendor", () => {
    expect(WALLET_VENDORS["figure-mobile"].transport).toBe("walletconnect");
    expect(WALLET_VENDORS["figure-extension"].transport).toBe("injected");
    expect(WALLET_VENDORS["arculus"].transport).toBe("walletconnect");
  });

  it("every descriptor id matches its registry key", () => {
    for (const id of VENDOR_IDS) {
      expect(WALLET_VENDORS[id].id).toBe(id);
    }
  });

  it("rejects anything outside the registry", () => {
    expect(isVendorId("keplr")).toBe(false); // fast-follow, NOT v1 (§14.1)
    expect(isVendorId("leap")).toBe(false);
    expect(isVendorId("")).toBe(false);
    expect(isVendorId("figure-mobile")).toBe(true);
  });
});

describe("pubkey normalization (vendor responses vary; server re-verifies)", () => {
  // 0xfb-filled bytes force `-`/`_` characters into the base64url form, so
  // the url-safe branch is genuinely exercised (0x07-filled bytes would
  // encode identically in both alphabets).
  const keyBytes = Buffer.alloc(33, 0xfb);

  it("accepts 33-byte hex and base64, normalizing to base64", () => {
    const b64 = keyBytes.toString("base64");
    expect(normalizePubkey(keyBytes.toString("hex"))).toBe(b64);
    expect(normalizePubkey(b64)).toBe(b64);
  });

  it("accepts base64url (padded and unpadded), normalizing to standard base64", () => {
    const b64 = keyBytes.toString("base64");
    const b64url = keyBytes.toString("base64url");
    expect(b64url).not.toBe(b64); // the fixture really differs
    expect(normalizePubkey(b64url)).toBe(b64);
    expect(normalizePubkey(`${b64url}=`)).toBe(b64); // padded url-safe variant
  });

  it("rejects wrong lengths and garbage", () => {
    expect(normalizePubkey(Buffer.alloc(32, 7).toString("base64"))).toBeNull();
    expect(normalizePubkey(Buffer.alloc(64, 7).toString("hex"))).toBeNull();
    expect(normalizePubkey("not base64!!")).toBeNull();
    expect(normalizePubkey("")).toBeNull();
  });
});

describe("signature normalization (same encoding drift; boundary schemas require standard base64)", () => {
  const sigBytes = Buffer.alloc(64, 0xfe);

  it("accepts 64-byte base64, base64url, and hex", () => {
    const b64 = sigBytes.toString("base64");
    expect(normalizeSignature(b64)).toBe(b64);
    expect(normalizeSignature(sigBytes.toString("base64url"))).toBe(b64);
    expect(normalizeSignature(sigBytes.toString("hex"))).toBe(b64);
  });

  it("rejects wrong lengths", () => {
    expect(normalizeSignature(Buffer.alloc(63, 1).toString("base64"))).toBeNull();
    expect(normalizeSignature(Buffer.alloc(33, 1).toString("base64"))).toBeNull();
    expect(normalizeSignature("")).toBeNull();
  });
});
