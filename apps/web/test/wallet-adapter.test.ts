// Gate (plan 5.1 §4.1): signing exists only behind the CLOSED wallet adapter
// registry — exactly the §14.1-decided v1 vendor set, with the decided
// transports. A vendor addition/removal or a transport change fails here
// until app-spec §14.1 is amended alongside (spec-recorded, never a config
// toggle).

import { describe, expect, it } from "vitest";

import { isVendorId, VENDOR_IDS, WALLET_VENDORS } from "~/wallet/adapter";
import { normalizePubkey } from "~/wallet/wc";

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
  const keyBytes = Buffer.alloc(33, 7);

  it("accepts 33-byte hex and base64, normalizing to base64", () => {
    const b64 = keyBytes.toString("base64");
    expect(normalizePubkey(keyBytes.toString("hex"))).toBe(b64);
    expect(normalizePubkey(b64)).toBe(b64);
  });

  it("rejects wrong lengths and garbage", () => {
    expect(normalizePubkey(Buffer.alloc(32, 7).toString("base64"))).toBeNull();
    expect(normalizePubkey(Buffer.alloc(64, 7).toString("hex"))).toBeNull();
    expect(normalizePubkey("not base64!!")).toBeNull();
    expect(normalizePubkey("")).toBeNull();
  });
});
