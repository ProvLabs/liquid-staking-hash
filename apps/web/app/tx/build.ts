// Message building + SIGN_MODE_DIRECT encoding (app plan PR 5.2; app-spec
// §10.2 steps 1/4/5). ONE construction site serves three consumers:
//
//   * the confirm step's EXACT-JSON disclosure (§10.2 step 4) renders
//     `disclosureJson` — produced from the same `TxPlan` the sign doc is
//     encoded from, so the user signs exactly what they saw
//     (test/tx-confirm.test.ts pins byte-equality via decode);
//   * the wallet adapter's `signDirect` receives the sign-doc bytes;
//   * the broadcast relay DECODES a submitted TxRaw with the same module to
//     enforce its guards (closed msg allowlist, sole-signer binding).
//
// Byte-golden discipline (§14.2 stage 1): the encoders reproduce the exact
// bytes the chain accepted for the captured corpus transactions —
// sha256(TxRaw) must equal the captured txhash (test/tx-build.test.ts).
// PR 8.0 re-vets against the formal vault release.
//
// Amount discipline: bigint end to end; strings only at the wire/JSON
// boundary. No floats, ever (spec §3 decision 8).

import { sha256 } from "@noble/hashes/sha256";

import {
  bytesField,
  bytesFields,
  ProtoWriter,
  readFields,
  stringField,
} from "./proto";

// ── The closed message allowlist (relay guard + builder domain) ──────────

export const MSG_SWAP_IN = "/provlabs.vault.v1.MsgSwapInRequest";
export const MSG_SWAP_OUT = "/provlabs.vault.v1.MsgSwapOutRequest";
/** The §10.2 v1 message set. Governance types join with M7 (spec §10.3). */
export const ALLOWED_MSG_TYPE_URLS = [MSG_SWAP_IN, MSG_SWAP_OUT] as const;

export const PUBKEY_TYPE_URL = "/cosmos.crypto.secp256k1.PubKey";
const SIGN_MODE_DIRECT = 1n;

// ── Intents ──────────────────────────────────────────────────────────────

export interface SwapInIntent {
  kind: "swap_in";
  owner: string;
  vaultAddress: string;
  /** base units (nhash) */
  amount: bigint;
  denom: string;
}

export interface SwapOutIntent {
  kind: "swap_out";
  owner: string;
  vaultAddress: string;
  /** base units (nvhash shares) */
  amount: bigint;
  denom: string;
  redeemDenom: string;
}

export type TxIntent = SwapInIntent | SwapOutIntent;

export interface Fee {
  gasLimit: bigint;
  /** nhash, base units */
  amount: bigint;
  denom: string;
}

/** Signer facts the server preflight supplies (auth account + config). */
export interface SignerContext {
  chainId: string;
  accountNumber: bigint;
  sequence: bigint;
  /** base64, 33-byte compressed secp256k1 (from the connected wallet). */
  pubkeyBase64: string;
}

// ── Encoders (canonical proto3; see proto.ts) ────────────────────────────

function encodeCoin(denom: string, amount: bigint): Uint8Array {
  return new ProtoWriter().string(1, denom).string(2, amount.toString()).finish();
}

function encodeAny(typeUrl: string, value: Uint8Array): Uint8Array {
  return new ProtoWriter().string(1, typeUrl).bytes(2, value).finish();
}

/** Encode the intent's message (MsgSwapInRequest / MsgSwapOutRequest). */
export function encodeIntentMsg(intent: TxIntent): { typeUrl: string; value: Uint8Array } {
  const writer = new ProtoWriter()
    .string(1, intent.owner)
    .string(2, intent.vaultAddress)
    .message(3, encodeCoin(intent.denom, intent.amount), true);
  if (intent.kind === "swap_out") {
    writer.string(4, intent.redeemDenom); // omitted when "" (canonical)
    return { typeUrl: MSG_SWAP_OUT, value: writer.finish() };
  }
  return { typeUrl: MSG_SWAP_IN, value: writer.finish() };
}

export function encodeTxBody(
  messages: ReadonlyArray<{ typeUrl: string; value: Uint8Array }>,
  memo = "",
): Uint8Array {
  const writer = new ProtoWriter();
  for (const msg of messages) writer.message(1, encodeAny(msg.typeUrl, msg.value), true);
  writer.string(2, memo);
  return writer.finish();
}

export function encodeAuthInfo(signer: SignerContext, fee: Fee): Uint8Array {
  const pubkey = encodeAny(
    PUBKEY_TYPE_URL,
    new ProtoWriter().bytes(1, Uint8Array.from(Buffer.from(signer.pubkeyBase64, "base64"))).finish(),
  );
  const modeInfo = new ProtoWriter()
    .message(1, new ProtoWriter().uint(1, SIGN_MODE_DIRECT).finish(), true)
    .finish();
  const signerInfo = new ProtoWriter()
    .message(1, pubkey, true)
    .message(2, modeInfo, true)
    .uint(3, signer.sequence)
    .finish();
  const feeMsg = new ProtoWriter()
    .message(1, encodeCoin(fee.denom, fee.amount), true)
    .uint(2, fee.gasLimit)
    .finish();
  return new ProtoWriter().message(1, signerInfo, true).message(2, feeMsg, true).finish();
}

export function encodeSignDoc(
  bodyBytes: Uint8Array,
  authInfoBytes: Uint8Array,
  chainId: string,
  accountNumber: bigint,
): Uint8Array {
  return new ProtoWriter()
    .bytes(1, bodyBytes)
    .bytes(2, authInfoBytes)
    .string(3, chainId)
    .uint(4, accountNumber)
    .finish();
}

export function encodeTxRaw(
  bodyBytes: Uint8Array,
  authInfoBytes: Uint8Array,
  signatures: readonly Uint8Array[],
): Uint8Array {
  const writer = new ProtoWriter().bytes(1, bodyBytes).bytes(2, authInfoBytes);
  for (const sig of signatures) writer.bytes(3, sig);
  return writer.finish();
}

/** Chain tx hash: uppercase hex sha256 of the TxRaw bytes. */
export function txHash(txRawBytes: Uint8Array): string {
  return Buffer.from(sha256(txRawBytes)).toString("hex").toUpperCase();
}

// ── The plan: one object, three consumers ────────────────────────────────

export interface TxPlan {
  intent: TxIntent;
  fee: Fee;
  signer: SignerContext;
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  signDocBytes: Uint8Array;
  /**
   * The EXACT-JSON disclosure (§10.2 step 4): proto-JSON of the message
   * list as the chain renders it. Produced from the same intent the sign
   * doc encodes — the single serialization site.
   */
  disclosureJson: string;
}

/** Proto-JSON view of an intent's message (the disclosure body). */
export function intentToProtoJson(intent: TxIntent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    "@type": intent.kind === "swap_in" ? MSG_SWAP_IN : MSG_SWAP_OUT,
    owner: intent.owner,
    vault_address: intent.vaultAddress,
    assets: { denom: intent.denom, amount: intent.amount.toString() },
  };
  if (intent.kind === "swap_out") base["redeem_denom"] = intent.redeemDenom;
  return base;
}

export function buildTxPlan(intent: TxIntent, fee: Fee, signer: SignerContext): TxPlan {
  const msg = encodeIntentMsg(intent);
  const bodyBytes = encodeTxBody([msg]);
  const authInfoBytes = encodeAuthInfo(signer, fee);
  const signDocBytes = encodeSignDoc(bodyBytes, authInfoBytes, signer.chainId, signer.accountNumber);
  return {
    intent,
    fee,
    signer,
    bodyBytes,
    authInfoBytes,
    signDocBytes,
    disclosureJson: JSON.stringify([intentToProtoJson(intent)], null, 2),
  };
}

// ── Decode (broadcast-relay guards; reject on anything unexpected) ───────

export interface DecodedMsg {
  typeUrl: string;
  owner: string;
  vaultAddress: string;
}

export interface DecodedTxRaw {
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  signatureCount: number;
  messages: DecodedMsg[];
  /** 33-byte compressed secp256k1 keys of every signer_info. */
  signerPubkeys: Uint8Array[];
}

/**
 * Decode a submitted TxRaw far enough for the relay guards: message type
 * URLs + owner/vault fields, signer pubkeys, signature count. Throws on any
 * malformation — the route maps that to 400, never a pass-through.
 */
export function decodeTxRaw(txRawBytes: Uint8Array): DecodedTxRaw {
  const raw = readFields(txRawBytes);
  const bodyBytes = bytesField(raw, 1);
  const authInfoBytes = bytesField(raw, 2);
  if (bodyBytes === null || authInfoBytes === null) throw new Error("malformed TxRaw");
  const signatureCount = bytesFields(raw, 3).length;

  const body = readFields(bodyBytes);
  const messages: DecodedMsg[] = bytesFields(body, 1).map((anyBytes) => {
    const any = readFields(anyBytes);
    const typeUrl = stringField(any, 1);
    const value = bytesField(any, 2);
    if (value === null) throw new Error("malformed Any");
    const msg = readFields(value);
    return {
      typeUrl,
      owner: stringField(msg, 1),
      vaultAddress: stringField(msg, 2),
    };
  });

  const authInfo = readFields(authInfoBytes);
  const signerPubkeys: Uint8Array[] = bytesFields(authInfo, 1).map((signerInfoBytes) => {
    const signerInfo = readFields(signerInfoBytes);
    const pubkeyAny = bytesField(signerInfo, 1);
    if (pubkeyAny === null) throw new Error("signer without pubkey");
    const any = readFields(pubkeyAny);
    if (stringField(any, 1) !== PUBKEY_TYPE_URL) throw new Error("unsupported pubkey type");
    const keyMsg = bytesField(any, 2);
    if (keyMsg === null) throw new Error("malformed pubkey Any");
    const key = bytesField(readFields(keyMsg), 1);
    if (key === null || key.length !== 33) throw new Error("malformed pubkey");
    return key;
  });

  return { bodyBytes, authInfoBytes, signatureCount, messages, signerPubkeys };
}
