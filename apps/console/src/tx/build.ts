// Transaction encoding — MIRROR-TRACKED against apps/web/app/tx/build.ts (the
// source of truth for every canonical form here; update both in the same
// change). First-party and dependency-free (PR 8.4b §2.4 / §7 Q3: the
// SECURITY.md reviewed-dependency event resolved to "no dependency added" —
// re-importing any `@cosmjs/*` re-enters the recorded `elliptic` advisory
// chain and is a NEW reviewed event).
//
// THE INVARIANT (§12, gated by test/sign-binding.test.ts): the bytes handed
// to the wallet are encoded from the EXACT message object the confirm sheet
// displayed. Nothing here re-derives, reorders, or augments a message after
// render.

import { ProtoWriter } from "@/tx/proto";
import type { ExecuteMsg } from "@/tx/messages";

export const MSG_EXECUTE_CONTRACT = "/cosmwasm.wasm.v1.MsgExecuteContract";
export const PUBKEY_TYPE_URL = "/cosmos.crypto.secp256k1.PubKey";
const SIGN_MODE_DIRECT = 1n;

/** Uint128 ceiling (the contract's amount type). Same local-copy convention
 *  as apps/web/app/tx/build.ts — greppable as one thing. */
const U128_MAX = (1n << 128n) - 1n;

export interface Fee {
  gasLimit: bigint;
  /** nhash, base units */
  amount: bigint;
  denom: string;
}

/** Signer facts fetched at sign time (auth account + config). */
export interface SignerContext {
  chainId: string;
  accountNumber: bigint;
  sequence: bigint;
  /** base64, 33-byte compressed secp256k1 (from the connected extension). */
  pubkeyBase64: string;
}

export interface Coin {
  denom: string;
  amount: string;
}

// ── base64 (browser-native; no Buffer in this bundle) ────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Encoders (canonical proto3; see proto.ts) ─────────────────────────────

function encodeCoin(denom: string, amount: bigint): Uint8Array {
  return new ProtoWriter().string(1, denom).string(2, amount.toString()).finish();
}

function encodeAny(typeUrl: string, value: Uint8Array): Uint8Array {
  return new ProtoWriter().string(1, typeUrl).bytes(2, value).finish();
}

/** The two payable variants — funds attach ONLY here (spec §10.2 step 1);
 *  every other variant must carry none, enforced below rather than assumed. */
function isPayable(message: ExecuteMsg): boolean {
  return "pay_commission" in message || "pay_tip" in message;
}

/**
 * Encode `MsgExecuteContract` (sender=1, contract=2, msg=3, funds=5) over the
 * exact rendered message object. Funds discipline is enforced at this
 * boundary: a fundless variant with funds, a payment without exactly one
 * positive Uint128 nhash coin, or a non-positive amount all THROW before
 * anything reaches the wallet.
 */
export function encodeExecuteContract(
  sender: string,
  contractAddress: string,
  message: ExecuteMsg,
  funds: readonly Coin[],
): Uint8Array {
  if (isPayable(message)) {
    if (funds.length !== 1) throw new Error("a payment must attach exactly one coin");
    const amount = BigInt(funds[0]!.amount);
    if (amount <= 0n || amount > U128_MAX) {
      throw new Error("a payment requires a positive Uint128 amount");
    }
  } else if (funds.length !== 0) {
    throw new Error("this action must not carry funds");
  }
  const writer = new ProtoWriter()
    .string(1, sender)
    .string(2, contractAddress)
    .bytes(3, new TextEncoder().encode(JSON.stringify(message)));
  for (const coin of funds) {
    writer.message(5, encodeCoin(coin.denom, BigInt(coin.amount)), true);
  }
  return writer.finish();
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
    new ProtoWriter().bytes(1, base64ToBytes(signer.pubkeyBase64)).finish(),
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

// ── Auth account (number/sequence at sign time) ──────────────────────────

/**
 * Decode `GET /cosmos/auth/v1beta1/accounts/{addr}` defensively: the account
 * may arrive as a bare BaseAccount or wrapped with a `base_account` inside
 * (module/vesting/smart-account wrappers). [VERIFY] on devnet which wrappers
 * this chain returns for extension-held accounts — settled at the first live
 * drill run, not by reading (chain-facts rule).
 */
export function decodeAuthAccount(body: unknown): { accountNumber: bigint; sequence: bigint } {
  const root =
    typeof body === "object" && body !== null
      ? ((body as Record<string, unknown>).account ?? body)
      : null;
  if (typeof root !== "object" || root === null) {
    throw new Error("auth account: unexpected response shape");
  }
  const o = root as Record<string, unknown>;
  const base =
    typeof o.base_account === "object" && o.base_account !== null
      ? (o.base_account as Record<string, unknown>)
      : o;
  const number = base.account_number;
  const sequence = base.sequence ?? "0";
  if (typeof number !== "string" || !/^\d+$/.test(number)) {
    throw new Error("auth account: no account_number");
  }
  if (typeof sequence !== "string" || !/^\d+$/.test(sequence)) {
    throw new Error("auth account: malformed sequence");
  }
  return { accountNumber: BigInt(number), sequence: BigInt(sequence) };
}
