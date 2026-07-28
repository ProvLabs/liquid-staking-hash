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

import { VALOPER_RE } from "~/lib/bech32";
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
/**
 * `MsgExecuteContract` is the operator actions' carrier (M6.4 §2.5). It is
 * NOT a plain allowlist entry: on its own this type URL would open the relay
 * to ARBITRARY contract calls on any contract on chain, which is the exact
 * opposite of a closed allowlist. Its membership here is valid only together
 * with `guardOperatorExecute` below, which the relay runs for this type URL
 * and no other. Removing or bypassing that second level re-opens the relay —
 * `test/broadcast-guard.test.ts` holds the rejection matrix that proves it
 * closed, and extending EITHER level is a design-review event.
 */
export const MSG_EXECUTE_CONTRACT = "/cosmwasm.wasm.v1.MsgExecuteContract";
/** The §10.2 v1 message set. Governance types join with M7 (spec §10.3). */
export const ALLOWED_MSG_TYPE_URLS = [MSG_SWAP_IN, MSG_SWAP_OUT, MSG_EXECUTE_CONTRACT] as const;

/**
 * The CLOSED set of contract execute variants the relay will carry — the
 * operator actions of §14.6, and nothing else. Every admin/keeper variant
 * (`set_halted`, `update_config`, `pause_vault`, `unpause_vault`,
 * `clear_pending_delegations`, `run_epoch`, `claim_rewards`,
 * `service_redemptions`, `capture_uptime_signal`) is deliberately ABSENT and
 * provably rejected. Adding one is a design-review event, not an edit.
 */
export const OPERATOR_VARIANTS = [
  "pay_commission",
  "pay_tip",
  "register_participation",
  "unregister_participation",
  "report_jailed_validator",
  "purge_jailed_validator",
] as const;
export type OperatorVariant = (typeof OPERATOR_VARIANTS)[number];

/** The two variants that carry funds. Every other variant MUST be fundless. */
export const FUNDED_VARIANTS: ReadonlySet<string> = new Set<OperatorVariant>([
  "pay_commission",
  "pay_tip",
]);

/**
 * The program's underlying denom (contract `Config.underlying_denom`), the
 * only denom a payment may attach. The contract's own `must_pay` enforces this
 * too; bounding it here keeps a wrong-denom payment from reaching the chain at
 * all. A program on a different underlying denom changes this constant — a
 * deliberate code change, not configuration.
 */
export const PROGRAM_UNDERLYING_DENOM = "nhash";

/** Canonical unsigned integer, bounded to Uint128 (the contract's amount type). */
const UINT_RE = /^(0|[1-9][0-9]*)$/;
/**
 * Uint128 ceiling. Kept local rather than imported from `@nvhash/chain-client`'s
 * `U128_MAX` on purpose — this module's import surface is deliberately narrow
 * (`./proto` and one hash), and the relay decodes untrusted bytes through it,
 * so it does not pull in the chain client. Same call the indexer's
 * `decode/attributes.ts` makes. The NAME matches that convention so the three
 * copies are greppable as one thing.
 */
const U128_MAX = (1n << 128n) - 1n;

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

/**
 * An operator action (M6.4 §2.4): one `MsgExecuteContract` against the program
 * contract carrying one of the six `OPERATOR_VARIANTS`. `amount` is the nhash
 * attached to a payment and MUST be 0 for every fundless variant — the guard
 * rejects funds on those, and the encoder emits none.
 */
export interface OperatorIntent {
  kind: "operator";
  variant: OperatorVariant;
  /** The acting account; the relay binds this to the session address. */
  sender: string;
  contractAddress: string;
  valoper: string;
  /** `purge_jailed_validator` only; omitted from the payload when null. */
  claimantValoper: string | null;
  /** base units (nhash); 0n for every variant outside FUNDED_VARIANTS. */
  amount: bigint;
  denom: string;
}

export type TxIntent = SwapInIntent | SwapOutIntent | OperatorIntent;

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

/**
 * The CANONICAL inner execute payload for an operator variant — the ONE place
 * this JSON is produced. Both the builder and the relay guard call it: the
 * guard re-encodes what it parsed and requires byte equality, so the only
 * inner payload the relay will carry is one this function would have produced.
 * That is what makes key reordering, duplicate keys, whitespace padding, and
 * unicode-escaped variant names non-issues rather than a parser arms race.
 */
export function operatorInnerJson(
  variant: OperatorVariant,
  valoper: string,
  claimantValoper: string | null = null,
): string {
  const body: Record<string, string> = { valoper };
  if (variant === "purge_jailed_validator" && claimantValoper !== null) {
    body["claimant_valoper"] = claimantValoper;
  }
  return JSON.stringify({ [variant]: body });
}

/** Encode `MsgExecuteContract` (sender=1, contract=2, msg=3, funds=5). */
function encodeExecuteContract(intent: OperatorIntent): Uint8Array {
  // THE INVARIANT: this encoder never produces a message `guardOperatorExecute`
  // would refuse. The two must agree on funds discipline in BOTH directions,
  // because the relay is the last stop before the chain and a disagreement is
  // only discovered AFTER the user has signed — the worst place to find one
  // (2026-07-28 review: a `pay_tip` at amount 0 used to encode with no funds
  // and was then rejected at the relay as "a payment must attach exactly one
  // coin"). Preflight blocks a zero payment earlier and the route schema
  // rejects it at the boundary; this throw is the backstop that keeps the
  // invariant true no matter how the intent was constructed.
  const funded = FUNDED_VARIANTS.has(intent.variant);
  if (funded && (intent.amount <= 0n || intent.amount > U128_MAX)) {
    throw new Error(`${intent.variant} requires a positive Uint128 amount`);
  }
  if (!funded && intent.amount !== 0n) {
    throw new Error(`${intent.variant} must not carry funds`);
  }

  const writer = new ProtoWriter()
    .string(1, intent.sender)
    .string(2, intent.contractAddress)
    .bytes(
      3,
      new TextEncoder().encode(
        operatorInnerJson(intent.variant, intent.valoper, intent.claimantValoper),
      ),
    );
  // Funds ride ONLY on the two payment variants; the fundless ones emit no
  // field 5 at all, which the guard then requires.
  if (funded) {
    writer.message(5, encodeCoin(intent.denom, intent.amount), true);
  }
  return writer.finish();
}

/** Encode the intent's message (the two vault msgs, or an operator execute). */
export function encodeIntentMsg(intent: TxIntent): { typeUrl: string; value: Uint8Array } {
  if (intent.kind === "operator") {
    return { typeUrl: MSG_EXECUTE_CONTRACT, value: encodeExecuteContract(intent) };
  }
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

/**
 * The account that must sign an intent — the vault msgs' `owner`, an operator
 * execute's `sender`. One accessor so the wallet call, the relay's session
 * binding, and any future message shape cannot drift apart on "who signs".
 */
export function intentSigner(intent: TxIntent): string {
  return intent.kind === "operator" ? intent.sender : intent.owner;
}

/** Proto-JSON view of an intent's message (the disclosure body). */
export function intentToProtoJson(intent: TxIntent): Record<string, unknown> {
  if (intent.kind === "operator") {
    // The disclosure shows the DECODED inner payload — an operator confirming
    // a privileged write must see the execute variant and its arguments, not
    // an opaque base64 blob (§10.2 step 4, §17.1 confirmation rigor).
    const json = operatorInnerJson(intent.variant, intent.valoper, intent.claimantValoper);
    return {
      "@type": MSG_EXECUTE_CONTRACT,
      sender: intent.sender,
      contract: intent.contractAddress,
      msg: JSON.parse(json) as Record<string, unknown>,
      funds:
        FUNDED_VARIANTS.has(intent.variant) && intent.amount > 0n
          ? [{ denom: intent.denom, amount: intent.amount.toString() }]
          : [],
    };
  }
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

export interface DecodedCoin {
  denom: string;
  amount: string;
}

export interface DecodedMsg {
  typeUrl: string;
  /** Field 1: the vault msgs' `owner`, or an execute msg's `sender`. */
  owner: string;
  /** Field 2: the vault msgs' `vault_address`, or an execute's `contract`. */
  vaultAddress: string;
  /** `MsgExecuteContract` field 3 — the raw inner payload bytes, or null. */
  execMsgBytes: Uint8Array | null;
  /** `MsgExecuteContract` field 5 — the attached funds (empty when none). */
  execFunds: DecodedCoin[];
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
      // Decoded uniformly for every message; only the guard's execute branch
      // interprets them. (On the vault msgs field 3 is the `assets` coin and
      // field 5 is absent — read, unused, and never trusted as a payload.)
      execMsgBytes: bytesField(msg, 3),
      execFunds: bytesFields(msg, 5).map((coinBytes) => {
        const coin = readFields(coinBytes);
        return { denom: stringField(coin, 1), amount: stringField(coin, 2) };
      }),
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

// ── The operator-execute deep guard (M6.4 §2.5) ──────────────────────────
//
// `MsgExecuteContract` in the allowlist would, by itself, let the relay carry
// ANY call to ANY contract. This is the second level that makes it closed, and
// it runs for that type URL ALONE. Five independent conditions, each of which
// must hold:
//
//   1. the target is the configured program contract — never another contract;
//   2. the inner payload is an object with EXACTLY ONE top-level key, and that
//      key is one of the six operator variants (admin/keeper variants are not
//      in the set and are provably rejected);
//   3. the variant's body carries only its allowed keys, each a well-formed
//      valoper — no extra keys, no wrong-shaped values;
//   4. funds discipline — the two payment variants carry exactly one coin of
//      the program's underlying denom with a bounded positive amount, and
//      every other variant carries NO funds at all;
//   5. the payload is byte-identical to `operatorInnerJson`'s canonical output
//      for what was just validated.
//
// (5) is what makes the rest robust rather than a parser arms race: whatever
// the guard *believes* it validated, the bytes going to the chain are the
// bytes this module would itself have produced. Duplicate keys, reordering,
// padding whitespace, `pay_commission` escapes, and a trailing second
// object all fail it, because none of them re-serialize to the canonical form.
//
// The contract re-checks all of this (it is the enforcement boundary); the
// guard's job is that the relay is not a general contract-call service for
// anyone holding a session.

export type OperatorGuardResult =
  | { ok: true; variant: OperatorVariant }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function guardOperatorExecute(
  msg: DecodedMsg,
  expected: { contractAddress: string },
): OperatorGuardResult {
  // 1 — the configured program contract, and nothing else on chain.
  if (msg.vaultAddress !== expected.contractAddress) {
    return { ok: false, reason: "unexpected contract address" };
  }
  if (msg.execMsgBytes === null) {
    return { ok: false, reason: "missing execute payload" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(msg.execMsgBytes));
  } catch {
    return { ok: false, reason: "execute payload is not JSON" };
  }

  // 2 — exactly one top-level key, drawn from the closed variant set.
  if (!isPlainObject(parsed)) return { ok: false, reason: "execute payload is not an object" };
  const keys = Object.keys(parsed);
  if (keys.length !== 1) {
    return { ok: false, reason: "execute payload must carry exactly one variant" };
  }
  const variant = keys[0]!;
  if (!(OPERATOR_VARIANTS as readonly string[]).includes(variant)) {
    return { ok: false, reason: "execute variant not allowed" };
  }
  const typed = variant as OperatorVariant;

  // 3 — per-variant body: only the allowed keys, each a well-formed valoper.
  const body = parsed[variant];
  if (!isPlainObject(body)) return { ok: false, reason: "execute variant body is not an object" };
  const allowedKeys =
    typed === "purge_jailed_validator" ? ["valoper", "claimant_valoper"] : ["valoper"];
  for (const key of Object.keys(body)) {
    if (!allowedKeys.includes(key)) return { ok: false, reason: "unexpected field in execute body" };
  }
  const valoper = body["valoper"];
  if (typeof valoper !== "string" || !VALOPER_RE.test(valoper)) {
    return { ok: false, reason: "valoper is not a validator operator address" };
  }
  let claimantValoper: string | null = null;
  if ("claimant_valoper" in body) {
    const claimant = body["claimant_valoper"];
    // A present claimant must be a well-formed valoper. An explicit
    // `"claimant_valoper": null` reaches condition 5 with claimantValoper still
    // null, and condition 5 then REJECTS it — the canonical form omits the key
    // entirely, so the submitted bytes cannot match. That is intended (there is
    // exactly one accepted encoding), and it is why this branch does not need
    // to reject explicit null itself. Pinned by the canonical-form case in
    // test/broadcast-guard.test.ts.
    if (claimant !== null) {
      if (typeof claimant !== "string" || !VALOPER_RE.test(claimant)) {
        return { ok: false, reason: "claimant_valoper is not a validator operator address" };
      }
      claimantValoper = claimant;
    }
  }

  // 4 — funds discipline.
  if (FUNDED_VARIANTS.has(typed)) {
    if (msg.execFunds.length !== 1) {
      return { ok: false, reason: "a payment must attach exactly one coin" };
    }
    const coin = msg.execFunds[0]!;
    if (coin.denom !== PROGRAM_UNDERLYING_DENOM) {
      return { ok: false, reason: "payment denom is not the program's underlying denom" };
    }
    if (!UINT_RE.test(coin.amount)) {
      return { ok: false, reason: "payment amount is not a canonical integer" };
    }
    const amount = BigInt(coin.amount);
    if (amount <= 0n || amount > U128_MAX) {
      return { ok: false, reason: "payment amount out of range" };
    }
  } else if (msg.execFunds.length !== 0) {
    // Funds smuggling onto an action that moves no value.
    return { ok: false, reason: "this action must not carry funds" };
  }

  // 5 — canonical byte equality with what this module would have built.
  const canonical = new TextEncoder().encode(
    operatorInnerJson(typed, valoper, claimantValoper),
  );
  if (
    canonical.length !== msg.execMsgBytes.length ||
    !canonical.every((byte, i) => byte === msg.execMsgBytes![i])
  ) {
    return { ok: false, reason: "execute payload is not in canonical form" };
  }

  return { ok: true, variant: typed };
}
