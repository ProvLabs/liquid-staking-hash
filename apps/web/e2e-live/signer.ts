// e2e-live test signer — a throwaway DEVNET key living
// ENTIRELY in the Playwright test process. It is NOT a wallet adapter and
// is never imported by anything under `app/`: the App keeps no devnet key
// mode (app-spec §10.1) and needed no test-injection seam — the live suite
// drives the server's own HTTP surface and signs here, outside the app.
// `check:bundle` additionally scans the client bundle for the sentinel
// below, so even an accidental future import fails CI.
//
// SECURITY.md (devnet): keys used here are disposable test material from
// the devnet keyring; never a real-network key. The suite refuses to run
// without an explicitly provided key — there is no baked-in default.

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

import { buildAdr36SignDoc, canonicalJson, utf8ToBase64 } from "../app/lib/adr36";

export const TEST_SIGNER_SENTINEL = "NVHASH_TEST_SIGNER_MUST_NOT_SHIP";

// Minimal bech32 encode (BIP-173), local to the test process.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) if ((b >> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}
function hrpExpand(hrp: string): number[] {
  const out = [...hrp].map((c) => c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
function toWords(bytes: Uint8Array): number[] {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  return words;
}
export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const words = toWords(bytes);
  const values = [...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

/** ripemd160 via @noble/hashes (same dependency family as the app). */
import { ripemd160 } from "@noble/hashes/ripemd160";

export class DevnetTestSigner {
  readonly address: string;
  readonly pubkeyBase64: string;
  private readonly priv: Uint8Array;

  constructor(privHex: string, prefix = "tp") {
    if (!/^[0-9a-fA-F]{64}$/.test(privHex)) {
      throw new Error(`${TEST_SIGNER_SENTINEL}: E2E_LIVE_SIGNER_KEY must be 32 hex bytes`);
    }
    this.priv = Uint8Array.from(Buffer.from(privHex, "hex"));
    const pub = secp256k1.getPublicKey(this.priv, true);
    this.pubkeyBase64 = Buffer.from(pub).toString("base64");
    this.address = bech32Encode(prefix, ripemd160(sha256(pub)));
  }

  /** ADR-36 signature over the session-login challenge text. */
  signChallenge(challengeText: string): string {
    const doc = buildAdr36SignDoc(this.address, utf8ToBase64(challengeText));
    const digest = sha256(new TextEncoder().encode(canonicalJson(doc)));
    return Buffer.from(secp256k1.sign(digest, this.priv).toCompactRawBytes()).toString("base64");
  }

  /** SIGN_MODE_DIRECT signature over raw sign-doc bytes. */
  signDirect(signDocBytes: Uint8Array): Uint8Array {
    return secp256k1.sign(sha256(signDocBytes), this.priv).toCompactRawBytes();
  }
}
