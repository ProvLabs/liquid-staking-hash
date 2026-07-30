// ADR-36 signature verification — SERVER-ONLY (app-spec §3
// decision 5). Verifies that the wallet's secp256k1 signature covers the
// exact challenge the server minted, and that the presented public key is
// the claimed bech32 address (pubkey → sha256 → ripemd160 → bech32).
//
// No key material is ever handled here (SECURITY.md): inputs are the PUBLIC
// key, a signature, and public strings. Dependencies are the audited,
// zero-install-script @noble/@scure family.
//
// Every input is bounded by the caller's zod schema before reaching this
// module; parsing failures here return `false`, never throw into a 500 — an
// attacker learns nothing about which check failed (the services/api auth.ts
// precedent).

import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";
import { bech32 } from "@scure/base";

import { buildAdr36SignDoc, canonicalJson, utf8ToBase64 } from "./adr36";

/** Derive the bech32 account address for a compressed secp256k1 pubkey. */
export function pubkeyToBech32(pubkey: Uint8Array, prefix: string): string {
  const hash = ripemd160(sha256(pubkey));
  return bech32.encode(prefix, bech32.toWords(hash));
}

/** The bech32 human-readable prefix of an address ("" if malformed). */
export function bech32Prefix(address: string): string {
  const sep = address.lastIndexOf("1");
  return sep > 0 ? address.slice(0, sep) : "";
}

/**
 * True when two bech32 strings carry the SAME data payload, differing only in
 * their HRP. This is the exact predicate `contracts/src/validators.rs`
 * `is_operator` applies: a validator's operator account and its valoper
 * address share one key payload, so comparing decoded payloads proves the
 * caller controls the validator with no extra state and no chain read.
 * Malformed input, or an empty payload, is false — never an accidental match.
 */
export function sameBech32Payload(a: string, b: string): boolean {
  try {
    const left = bech32.decode(a as `${string}1${string}`);
    const right = bech32.decode(b as `${string}1${string}`);
    if (left.words.length === 0) return false;
    return (
      left.words.length === right.words.length && left.words.every((w, i) => w === right.words[i])
    );
  } catch {
    return false;
  }
}

export interface Adr36Verification {
  /** bech32 address the session would be scoped to. */
  address: string;
  /** utf8 challenge text that must have been signed. */
  challengeText: string;
  /** base64, 33-byte compressed secp256k1 public key from the wallet. */
  pubkeyBase64: string;
  /** base64, 64-byte r||s signature from the wallet. */
  signatureBase64: string;
}

/**
 * Verify an ADR-36 signature over `challengeText` for `address`. True only
 * when (1) the signature verifies over the canonical sign-doc bytes with the
 * presented pubkey and (2) the pubkey derives exactly the claimed address.
 */
export function verifyAdr36(input: Adr36Verification): boolean {
  let pubkey: Uint8Array;
  let signature: Uint8Array;
  try {
    pubkey = Uint8Array.from(Buffer.from(input.pubkeyBase64, "base64"));
    signature = Uint8Array.from(Buffer.from(input.signatureBase64, "base64"));
  } catch {
    return false;
  }
  if (pubkey.length !== 33 || signature.length !== 64) return false;

  // (2) first — pubkey→address binding; a failure here makes the signature
  // check moot and the combined result is the same undifferentiated `false`.
  const prefix = bech32Prefix(input.address);
  if (prefix.length === 0) return false;
  let derived: string;
  try {
    derived = pubkeyToBech32(pubkey, prefix);
  } catch {
    return false;
  }
  if (derived !== input.address) return false;

  // (1) signature over the canonical ADR-36 sign doc for this exact text.
  const doc = buildAdr36SignDoc(input.address, utf8ToBase64(input.challengeText));
  const signBytes = sha256(new TextEncoder().encode(canonicalJson(doc)));
  try {
    return secp256k1.verify(signature, signBytes, pubkey);
  } catch {
    return false;
  }
}
