// Proposal-message decoding (app-spec §8.7, §12.1). PURE — no I/O,
// no clock, no config beyond the program contract address passed in.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a decoded summary is produced from a
// CLOSED union of message shapes whose field semantics are pinned to a source of
// truth, and everything else renders as a tagged `unknown` — "unrecognized
// message type" plus the exact payload. There is no heuristic third case.
// §12.1 forbids presenting an invented meaning, and a confident wrong summary of
// a governance proposal is worse than no summary at all: it is the one failure
// mode that would make a member vote for something other than what they read.
//
// The union is deliberately SMALL, and each arm names what pins it:
//
//   * `/cosmos.bank.v1beta1.MsgSend` — the shape every drill proposal carries
//     (`packages/fixtures/fixtures/queries/group/proposals-*.json`), so it is
//     pinned by captured data.
//   * `/cosmwasm.wasm.v1.MsgExecuteContract` against the CONFIGURED program
//     contract — pinned by `contracts/src/msg.rs` for the bodies and by
//     `app/tx/build.ts` for the variant vocabulary, which is IMPORTED rather
//     than restated so this reader and 7.4's composer cannot describe the same
// action differently ("one vocabulary for one action").
//
// x/group's own messages (`MsgUpdateGroupMembers` and friends) are deliberately
// ABSENT: no fixture pins their shape on this build, and adding an arm from
// proto knowledge alone is exactly the confident-wrong summary invariant 2's
// disproof line names (R3).

import { ADMIN_VARIANTS, KEEPER_VARIANTS, OPERATOR_VARIANTS } from "~/tx/build";
import { formatBaseAmount, HASH_EXPONENT } from "~/learn/amounts";
import { t, type Locale, type MessageKey } from "~/i18n";

export const MSG_SEND_TYPE_URL = "/cosmos.bank.v1beta1.MsgSend";
export const MSG_EXECUTE_CONTRACT_TYPE_URL = "/cosmwasm.wasm.v1.MsgExecuteContract";

/**
 * Display cap on the exact-JSON block. A proposal's messages are USER-AUTHORED
 * on a permissionless chain and `services/api` bounds their COUNT but not the
 * size of any one of them, so an unbounded render would let a proposer decide
 * how much of the page they own. Over the cap the block is trimmed and the
 * trim is STATED (`jsonTruncated`) — a quietly shortened payload would break
 * the promise the block exists to keep.
 */
export const MAX_MESSAGE_JSON_CHARS = 20_000;

/** The program's own contract variants, one vocabulary, three authorities. */
export const PROGRAM_VARIANT_AUTHORITY = {
  ...Object.fromEntries(OPERATOR_VARIANTS.map((v) => [v, "operator" as const])),
  ...Object.fromEntries(ADMIN_VARIANTS.map((v) => [v, "admin" as const])),
  ...Object.fromEntries(KEEPER_VARIANTS.map((v) => [v, "keeper" as const])),
} as Record<string, "operator" | "admin" | "keeper" | undefined>;

export type ProgramVariantAuthority = "operator" | "admin" | "keeper";

/** Why a message could not be summarized. Each is a distinct thing to say. */
export type UnknownReason =
  /** A type URL the union does not carry. */
  | "unknown-type"
  /** `MsgExecuteContract` against some other contract — not this program's. */
  | "other-contract"
  /** This program's contract, but a variant the build does not know. */
  | "unknown-variant"
  /** The right type URL with a body that does not parse as its shape. */
  | "malformed";

export interface DecodedCoinVM {
  denom: string;
  /** Verbatim base-unit string, as it appeared on the wire. */
  amount: string;
  /** HASH display for the program denom; null for any other denom. */
  hash: string | null;
}

/** A `key: value` line rendered beside a summary. Values are display strings. */
export interface DecodedField {
  key: string;
  value: string;
}

interface DecodedBase {
  /** The `@type` as it appeared, or null when absent/not a string. */
  typeUrl: string | null;
  /** The exact payload, pretty-printed. Present on EVERY arm (§8.7 ordering). */
  json: string;
  jsonTruncated: boolean;
}

export type DecodedMessage =
  | (DecodedBase & {
      kind: "send";
      typeUrl: string;
      from: string;
      to: string;
      coins: DecodedCoinVM[];
    })
  | (DecodedBase & {
      kind: "program-action";
      typeUrl: string;
      contract: string;
      variant: string;
      authority: ProgramVariantAuthority;
      fields: DecodedField[];
      /** Funds attached to the call. `pay_commission`/`pay_tip` carry their whole
       * amount here and nowhere else, so a surface that dropped this would show
       * a payment proposal without the sum being paid. */
      funds: DecodedCoinVM[];
      /** `set_halted` only — the one variant whose meaning inverts on a field. */
      halted: boolean | null;
    })
  | (DecodedBase & { kind: "unknown"; reason: UnknownReason });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pretty-print for display, bounded. Never throws — a value that cannot be
 * serialized still has to render as something the reader can see. */
function toJsonBlock(value: unknown): { json: string; jsonTruncated: boolean } {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > MAX_MESSAGE_JSON_CHARS
    ? { json: text.slice(0, MAX_MESSAGE_JSON_CHARS), jsonTruncated: true }
    : { json: text, jsonTruncated: false };
}

const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;

/** The program's underlying denom gets a HASH display; nothing else does — a
 * fabricated exponent for an unknown denom would misstate an amount. */
const PROGRAM_DENOM = "nhash";

function parseCoins(value: unknown): DecodedCoinVM[] | null {
  if (!Array.isArray(value)) return null;
  const coins: DecodedCoinVM[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return null;
    const denom = entry["denom"];
    const amount = entry["amount"];
    if (typeof denom !== "string" || denom === "") return null;
    if (typeof amount !== "string" || !CANONICAL_UINT.test(amount)) return null;
    coins.push({
      denom,
      amount,
      hash: denom === PROGRAM_DENOM ? formatBaseAmount(BigInt(amount), HASH_EXPONENT, 4) : null,
    });
  }
  return coins;
}

/**
 * Read `MsgExecuteContract.msg` in either encoding the wire may carry: the raw
 * JSON object (wasmd's `RawContractMessage`) or base64-encoded bytes (the plain
 * proto-JSON encoding of a `bytes` field). Returns null for anything that is not
 * an object either way — including a base64 string that decodes to valid JSON
 * which is not an object, since a bare array or number is not an `ExecuteMsg`.
 *
 * Bounded: an over-long base64 string is refused before it is decoded, so a
 * hostile proposal cannot make this allocate.
 */
function readExecutePayload(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string" || value.length > MAX_MESSAGE_JSON_CHARS) return null;
  let text: string;
  try {
    // `atob` + TextDecoder rather than `Buffer`: this module is imported by the
    // presentation components too (they call `summarizeMessage`), so it must
    // run unchanged in the browser bundle.
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Render one coin for a summary line: HASH for the program denom, else verbatim. */
export function formatCoin(coin: DecodedCoinVM): string {
  return coin.hash === null ? `${coin.amount} ${coin.denom}` : `${coin.hash} HASH`;
}

/**
 * Decode one proposal message.
 *
 * `programContract` is the configured contract address. It is REQUIRED rather
 * than optional: without it every `MsgExecuteContract` would have to be either
 * trusted or rejected, and the first is how a summary starts describing another
 * contract's call in this program's vocabulary.
 */
export function decodeMessage(message: unknown, programContract: string): DecodedMessage {
  const block = toJsonBlock(message);

  if (!isPlainObject(message)) {
    return { kind: "unknown", reason: "malformed", typeUrl: null, ...block };
  }
  const rawType = message["@type"];
  const typeUrl = typeof rawType === "string" && rawType !== "" ? rawType : null;
  if (typeUrl === null) {
    return { kind: "unknown", reason: "malformed", typeUrl: null, ...block };
  }

  if (typeUrl === MSG_SEND_TYPE_URL) {
    const from = message["from_address"];
    const to = message["to_address"];
    const coins = parseCoins(message["amount"]);
    if (typeof from !== "string" || typeof to !== "string" || coins === null) {
      return { kind: "unknown", reason: "malformed", typeUrl, ...block };
    }
    return { kind: "send", typeUrl, from, to, coins, ...block };
  }

  if (typeUrl === MSG_EXECUTE_CONTRACT_TYPE_URL) {
    const contract = message["contract"];
    if (typeof contract !== "string") {
      return { kind: "unknown", reason: "malformed", typeUrl, ...block };
    }
    // A call to any other contract is NOT summarized. This program's variant
    // names mean nothing there, and borrowing them would describe someone
    // else's call in our words.
    if (contract !== programContract) {
      return { kind: "unknown", reason: "other-contract", typeUrl, ...block };
    }
    // `MsgExecuteContract.msg` is proto `bytes`. wasmd's `RawContractMessage`
    // marshals it as the raw JSON object over grpc-gateway, but the plain proto
    // JSON encoding of a bytes field is base64 — and no fixture pins which one
    // this build serves inside a proposal (the drill corpus carries only
    // `MsgSend`). BOTH are accepted rather than assuming one:
    // guessing wrong would render every program-action proposal as `unknown`,
    // which is a safe failure but a needless one.
    const msg = readExecutePayload(message["msg"]);
    if (msg === null) {
      return { kind: "unknown", reason: "malformed", typeUrl, ...block };
    }
    const funds = parseCoins(message["funds"] ?? []) ?? [];
    const keys = Object.keys(msg);
    if (keys.length !== 1) {
      // Exactly one top-level key is the contract's own `ExecuteMsg` shape; two
      // keys is not a variant this build can name.
      return { kind: "unknown", reason: "unknown-variant", typeUrl, ...block };
    }
    const variant = keys[0]!;
    const authority = PROGRAM_VARIANT_AUTHORITY[variant];
    if (authority === undefined) {
      return { kind: "unknown", reason: "unknown-variant", typeUrl, ...block };
    }
    const body = msg[variant];
    if (!isPlainObject(body)) {
      return { kind: "unknown", reason: "malformed", typeUrl, ...block };
    }
    const fields: DecodedField[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (value === null || value === undefined) continue;
      // Scalars only. A nested object inside a variant body is not a shape
      // `contracts/src/msg.rs` defines, so it is shown in the JSON block and
      // not paraphrased into a field line.
      if (typeof value === "object") continue;
      fields.push({ key, value: String(value) });
    }
    const halted =
      variant === "set_halted" && typeof body["halted"] === "boolean" ? body["halted"] : null;
    return {
      kind: "program-action",
      typeUrl,
      contract,
      variant,
      authority,
      fields,
      funds,
      halted,
      ...block,
    };
  }

  return { kind: "unknown", reason: "unknown-type", typeUrl, ...block };
}

/** The i18n key each unknown reason renders as. Total over `UnknownReason`. */
const UNKNOWN_REASON_KEYS = {
  "unknown-type": "governance.msg-unknown-type",
  "other-contract": "governance.msg-unknown-contract",
  "unknown-variant": "governance.msg-unknown-variant",
  malformed: "governance.msg-malformed",
} as const satisfies Record<UnknownReason, MessageKey>;

/**
 * The i18n key each known program variant summarizes as. TOTAL over the three
 * imported vocabularies — a variant added to `build.ts` without a summary here
 * is a type error, not a message that silently renders as unknown.
 *
 * `set_halted` carries two keys because its meaning INVERTS on a boolean field:
 * one summary covering both would be the invented meaning §12.1 forbids.
 */
const VARIANT_SUMMARY_KEYS = {
  pay_commission: "governance.msg-pay-commission",
  pay_tip: "governance.msg-pay-tip",
  register_participation: "governance.msg-register-participation",
  unregister_participation: "governance.msg-unregister-participation",
  report_jailed_validator: "governance.msg-report-jailed",
  purge_jailed_validator: "governance.msg-purge-jailed",
  // Both of these are resolved BEFORE the map is consulted (their meaning turns
  // on a field), so the entries here are the placeholder-free fallbacks — which
  // also keeps every key reachable through this table free of placeholders the
  // i18n scan cannot verify at an indirect call site.
  set_halted: "governance.msg-set-halted-unknown",
  update_config: "governance.msg-update-config-generic",
  pause_vault: "governance.msg-pause-vault",
  unpause_vault: "governance.msg-unpause-vault",
  clear_pending_delegations: "governance.msg-clear-pending-delegations",
  run_epoch: "governance.msg-run-epoch",
  claim_rewards: "governance.msg-claim-rewards",
  service_redemptions: "governance.msg-service-redemptions",
  capture_uptime_signal: "governance.msg-capture-uptime-signal",
} as const satisfies Record<
  | (typeof OPERATOR_VARIANTS)[number]
  | (typeof ADMIN_VARIANTS)[number]
  | (typeof KEEPER_VARIANTS)[number],
  MessageKey
>;

/**
 * The human summary for a decoded message, in one locale. Locale-aware and
 * still pure: the only inputs are the decoded value and the catalog.
 *
 * Every branch either resolves to a key from the closed maps above or says the
 * message is not understood. There is no string built by concatenating a guess.
 */
export function summarizeMessage(locale: Locale, decoded: DecodedMessage): string {
  if (decoded.kind === "unknown") {
    return t(locale, UNKNOWN_REASON_KEYS[decoded.reason]);
  }

  if (decoded.kind === "send") {
    const amount =
      decoded.coins.length === 0
        ? t(locale, "governance.msg-send-no-coins")
        : decoded.coins.map(formatCoin).join(", ");
    return t(locale, "governance.msg-send", { amount, recipient: decoded.to });
  }

  const { variant } = decoded;
  if (variant === "set_halted") {
    if (decoded.halted === null) return t(locale, "governance.msg-set-halted-unknown");
    return t(
      locale,
      decoded.halted ? "governance.msg-set-halted-on" : "governance.msg-set-halted-off",
    );
  }
  if (variant === "update_config") {
    // The contract changes only the fields a proposal supplies, so NAMING the
    // supplied fields is a fact about the message. What each new value means
    // for the program is a diff view, and that is 7.4's (D19).
    const fields = decoded.fields.map((f) => f.key).join(", ");
    return fields === ""
      ? t(locale, "governance.msg-update-config-generic")
      : t(locale, "governance.msg-update-config", { fields });
  }

  const key = VARIANT_SUMMARY_KEYS[variant as keyof typeof VARIANT_SUMMARY_KEYS];
  const valoper = decoded.fields.find((f) => f.key === "valoper")?.value ?? "";
  return t(locale, key, { valoper });
}
