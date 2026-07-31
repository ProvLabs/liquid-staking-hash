// ADR-36 (Cosmos arbitrary-data signing) — the sign-doc construction shared
// by BOTH sides of the session login (app-spec §3 decision 5):
// the wallet layer builds this exact document and hands it to the vendor
// adapter's `signArbitrary`; the server rebuilds the same document to verify
// the signature. One construction site, two callers — drift is impossible.
//
// This module is deliberately pure JSON/string work with zero dependencies:
// it is safe in the client bundle. Signature VERIFICATION (secp256k1, address
// derivation) is server-only and lives in adr36-verify.server.ts.
//
// ADR-36 fixes the amino StdSignDoc fields: empty chain id, zero account
// number/sequence, empty fee, a single sign/MsgSignData message carrying the
// base64 payload and the signer address. Sign bytes are the SHA-256 of the
// canonical (sorted-key, no-whitespace) JSON serialization.

/** The exact challenge string the wallet signs (and the user sees). */
export function loginChallenge(chainId: string, nonce: string): string {
  // Human-readable on wallets that render ADR-36 payloads as text: states the
  // action and binds the environment's chain id alongside the server nonce.
  return `nvHASH session login\nchain: ${chainId}\nnonce: ${nonce}`;
}

export interface Adr36SignDoc {
  account_number: "0";
  chain_id: "";
  fee: { amount: readonly never[]; gas: "0" };
  memo: "";
  msgs: readonly [
    {
      type: "sign/MsgSignData";
      value: { data: string; signer: string };
    },
  ];
  sequence: "0";
}

/** Build the ADR-36 StdSignDoc for `signer` over utf8 `data` (as base64). */
export function buildAdr36SignDoc(signer: string, dataBase64: string): Adr36SignDoc {
  return {
    account_number: "0",
    chain_id: "",
    fee: { amount: [], gas: "0" },
    memo: "",
    msgs: [{ type: "sign/MsgSignData", value: { data: dataBase64, signer } }],
    sequence: "0",
  };
}

/**
 * Canonical amino-JSON serialization: keys sorted lexicographically at every
 * depth, no whitespace. This is the byte string wallets hash and sign.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Runtime-portable utf8 → base64 (Node and browser). */
export function utf8ToBase64(text: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(text, "utf8").toString("base64");
  // Loop, not spread: spreading a typed array into String.fromCharCode hits
  // engine argument-count limits on large inputs — this
  // utility must be safe regardless of payload size.
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
