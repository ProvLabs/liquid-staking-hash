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
// `@nvhash/api-types` is a zero-runtime-dependency constants/types package, so
// importing it does not widen what the relay pulls in. The bounds MUST come
// from there rather than be literals here: M7.3–7.4 §4b C2 makes a guard bound
// written inline a review failure, because the composer, the guard and the
// reader must not be able to disagree about the same limit.
import {
  MAX_PROPOSAL_MESSAGES,
  MAX_PROPOSAL_METADATA_LEN,
  MAX_PROPOSAL_SUMMARY_LEN,
  MAX_PROPOSAL_TITLE_LEN,
} from "@nvhash/api-types";

import {
  matchTemplateInstance,
  templateInnerJson,
  type TemplateValues,
} from "~/governance/templates";
import { VALOPER_RE } from "~/lib/bech32";
import {
  bytesEqual,
  bytesField,
  bytesFields,
  hasField,
  ProtoWriter,
  readFields,
  stringField,
  stringFields,
  uintField,
  type WireField,
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

// ── The M7.3–7.4 governance types (app-spec §12.3 amendment) ─────────────
//
// THREE types join, and no others. Every other `cosmos.group.v1` message —
// `MsgUpdateGroupMembers`, `MsgUpdateGroupPolicyDecisionPolicy`,
// `MsgWithdrawProposal`, `MsgLeaveGroup` and the rest — stays rejected, and
// `MsgUpdateGroupMembers` in particular is the one worth naming: it changes WHO
// GOVERNS, which is the same authority by a different route.
//
// TWO GUARD CLASSES, because the payloads differ in kind (§2.2):
//
//   * `MsgVote` and `MsgExec` carry CLOSED SCALAR payloads embedding no other
//     message. Their guard is structural — type URL → signer ↔ session binding
//     → closed field set with bounded values → canonical re-encode.
//
//   * `MsgSubmitProposal` carries `messages []Any`. On its own its type URL
//     would let the relay carry arbitrary messages destined for the GROUP
//     POLICY ACCOUNT, WHICH IS THE CONTRACT'S ADMIN — strictly worse than the
//     `MsgExecuteContract` hole M6.4 closed. Its membership here is valid only
//     together with `guardSubmitProposal`'s six conditions below.
//
// Extending EITHER level is a design-review event, never an edit
// (`test/broadcast-guard.test.ts` holds the rejection matrix that proves the
// set closed).
export const MSG_GOV_VOTE = "/cosmos.group.v1.MsgVote";
export const MSG_GOV_EXEC = "/cosmos.group.v1.MsgExec";
export const MSG_GOV_SUBMIT_PROPOSAL = "/cosmos.group.v1.MsgSubmitProposal";

/** The three governance types, for the relay's per-type dispatch. */
export const GOVERNANCE_MSG_TYPE_URLS = [
  MSG_GOV_VOTE,
  MSG_GOV_EXEC,
  MSG_GOV_SUBMIT_PROPOSAL,
] as const;

/** The §10.2 v1 message set, plus the M7.3–7.4 governance types (spec §12.3). */
export const ALLOWED_MSG_TYPE_URLS = [
  MSG_SWAP_IN,
  MSG_SWAP_OUT,
  MSG_EXECUTE_CONTRACT,
  ...GOVERNANCE_MSG_TYPE_URLS,
] as const;

/**
 * `cosmos.group.v1.VoteOption`. `VOTE_OPTION_UNSPECIFIED` (0) is deliberately
 * ABSENT: it is a legal wire value and a meaningless vote, and proto3 omits a
 * zero varint, so admitting it would make "no option" and "unspecified"
 * indistinguishable on the wire.
 */
export const GOVERNANCE_VOTE_OPTION_NAMES = ["yes", "abstain", "no", "no_with_veto"] as const;
export type GovernanceVoteOption = (typeof GOVERNANCE_VOTE_OPTION_NAMES)[number];
/** Name → the module's enum value. The names are the tuple above so the route
 * schemas can bound the input against the SAME closed set the encoder uses. */
export const GOVERNANCE_VOTE_OPTIONS: Record<GovernanceVoteOption, bigint> = {
  yes: 1n,
  abstain: 2n,
  no: 3n,
  no_with_veto: 4n,
};

/**
 * `cosmos.group.v1.Exec` — THE ONE DANGEROUS SUBTLETY (§2.4).
 *
 * `EXEC_TRY` (1) attempts execution in the SAME transaction, which silently
 * turns a vote — or a submission — into a vote PLUS execution of whatever the
 * proposal contains, which after this PR includes admin program-ops. The guard
 * PINS `exec` to `EXEC_UNSPECIFIED` (0) on both messages and rejects anything
 * else; because proto3 omits a zero varint, the pin is enforced as "field 5 is
 * absent", and the canonical re-encode enforces it a second time.
 *
 * Execution is always a separate, separately-confirmed `MsgExec` with its own
 * decoded-payload disclosure. A user who intends both performs two
 * confirmations — §17.1 confirmation rigor: the danger tier is not something to
 * bundle into a cheaper action.
 */
export const EXEC_UNSPECIFIED = 0n;

/** Proto field numbers, named so the guards read as the proto they enforce. */
const VOTE_FIELD = { proposalId: 1, voter: 2, option: 3, metadata: 4, exec: 5 } as const;
const EXEC_FIELD = { proposalId: 1, signer: 2 } as const;
const SUBMIT_FIELD = {
  policyAddress: 1,
  proposers: 2,
  metadata: 3,
  messages: 4,
  exec: 5,
  title: 6,
  summary: 7,
} as const;
/** `MsgExecuteContract`: sender=1, contract=2, msg=3, funds=5 (4 is unused). */
const WASM_EXEC_FIELD = { sender: 1, contract: 2, msg: 3, funds: 5 } as const;

/**
 * The CLOSED set of contract execute variants the relay will carry — the
 * operator actions of §14.6, and nothing else. Every admin and keeper variant
 * (`ADMIN_VARIANTS` / `KEEPER_VARIANTS` below) is deliberately ABSENT and
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

/**
 * The contract's ADMIN-gated variants (`contracts/src/msg.rs`), and the
 * permissionless KEEPER cranks. Neither list is an allowlist — nothing here is
 * carried by the relay, and `guardOperatorExecute` rejects every one of them.
 *
 * They are NAMED here, rather than left as prose, for two consumers that must
 * not describe the same action differently (M7.2 §2.2, "one vocabulary for one
 * action"): `test/broadcast-guard.test.ts`'s rejection matrix iterates them, so
 * it can no longer drift from the variant set; and `app/governance/decode.ts`
 * summarizes a `MsgExecuteContract` inside a governance proposal against them,
 * so the reader and 7.4's composer share one vocabulary. Naming a rejected set
 * is not admitting it — `ALLOWED_MSG_TYPE_URLS` and the guard are unchanged.
 *
 * `unregister_participation` is deliberately NOT here: the contract accepts it
 * from the operator OR the admin, and it is already in `OPERATOR_VARIANTS`.
 */
export const ADMIN_VARIANTS = [
  "set_halted",
  "update_config",
  "pause_vault",
  "unpause_vault",
  "clear_pending_delegations",
] as const;
export type AdminVariant = (typeof ADMIN_VARIANTS)[number];

export const KEEPER_VARIANTS = [
  "run_epoch",
  "claim_rewards",
  "service_redemptions",
  "capture_uptime_signal",
] as const;
export type KeeperVariant = (typeof KEEPER_VARIANTS)[number];

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

/** A member's vote on a proposal (M7.3 §2.2). Closed scalar payload. */
export interface GovVoteIntent {
  kind: "gov_vote";
  /** The acting account; the relay binds this to the session address. */
  voter: string;
  /** x/group proposal id, u64. Ids start at 1, so 0 is not a proposal. */
  proposalId: bigint;
  option: GovernanceVoteOption;
}

/**
 * Execute a proposal that has passed (M7.3 §2.2).
 *
 * Execution in x/group is PERMISSIONLESS once a proposal has passed (§7 Q2,
 * confirmed 2026-07-30: offered to any connected wallet, and the UI says so).
 * The relay still binds `signer` to the session address — the relay carries the
 * session's own transactions, which is a different rule from who the module
 * allows to execute.
 */
export interface GovExecIntent {
  kind: "gov_exec";
  signer: string;
  proposalId: bigint;
}

/** One template instance inside a composed proposal. */
export interface ProposalTemplateInstance {
  id: string;
  values: TemplateValues;
}

/**
 * Submit a template-scoped proposal (M7.4 §2.2/§2.3).
 *
 * `templates` is a LIST because the wire is a list — v1 composes exactly one
 * (§7 Q4, confirmed 2026-07-30), and modelling it as a scalar here would put
 * the cardinality assumption in the type where the guard could not see it
 * (§4b C1). `proposers` is likewise the wire's repeated field, but the relay is
 * sole-signer, so the encoder emits exactly the one proposer.
 */
export interface GovSubmitProposalIntent {
  kind: "gov_submit";
  proposer: string;
  /** A DISCOVERED program policy (guard condition 3), never an arbitrary account. */
  policyAddress: string;
  /** The program contract every template targets. */
  contractAddress: string;
  templates: readonly ProposalTemplateInstance[];
  title: string;
  summary: string;
  /** Optional public rationale (§7 Q3). Empty = omitted from the wire. */
  metadata: string;
}

export type GovernanceIntent = GovVoteIntent | GovExecIntent | GovSubmitProposalIntent;

export type TxIntent = SwapInIntent | SwapOutIntent | OperatorIntent | GovernanceIntent;

/** True for the three `cosmos.group.v1` intents (the governance flows). */
export function isGovernanceIntent(intent: TxIntent): intent is GovernanceIntent {
  return intent.kind === "gov_vote" || intent.kind === "gov_exec" || intent.kind === "gov_submit";
}

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

// ── Governance encoders (M7.3–7.4 §3.1) ─────────────────────────────────
//
// The same discipline as every encoder above: field-number order, omitted
// defaults, and — the property the whole guard rests on — a form the guard can
// reproduce from what it parsed. Each of these is the ONE place its message is
// serialized, which is what makes "byte-identical canonical re-encode" a
// meaningful condition rather than a second opinion.

/** `MsgVote` (proposal_id=1, voter=2, option=3, metadata=4, exec=5).
 *
 * Fields 4 and 5 are NEVER WRITTEN: vote metadata is omitted (§7 Q3) and `exec`
 * is pinned to `EXEC_UNSPECIFIED` (§2.4). Because proto3 omits defaults, "pinned
 * to the no-try value" and "field absent" are the same bytes — so the guard
 * enforces the pin by requiring absence, and the re-encode enforces it again. */
function encodeGovVote(intent: GovVoteIntent): Uint8Array {
  if (intent.proposalId <= 0n) throw new Error("proposal id must be positive");
  return new ProtoWriter()
    .uint(VOTE_FIELD.proposalId, intent.proposalId)
    .string(VOTE_FIELD.voter, intent.voter)
    .uint(VOTE_FIELD.option, GOVERNANCE_VOTE_OPTIONS[intent.option])
    .finish();
}

/** `MsgExec` (proposal_id=1, signer=2). No other field exists on this message. */
function encodeGovExec(intent: GovExecIntent): Uint8Array {
  if (intent.proposalId <= 0n) throw new Error("proposal id must be positive");
  return new ProtoWriter()
    .uint(EXEC_FIELD.proposalId, intent.proposalId)
    .string(EXEC_FIELD.signer, intent.signer)
    .finish();
}

/**
 * The CANONICAL inner `Any` for one template instance — the proposal's payload.
 *
 * `sender` is the GROUP POLICY ADDRESS, not the proposer: x/group executes a
 * proposal's messages AS the policy account, and the policy account is the
 * contract's admin. A message whose sender were anything else would be rejected
 * by the contract's `assert_admin`, so pinning it here keeps the composer from
 * building a proposal that can only ever fail — and keeps the guard from
 * carrying one whose sender someone chose freely.
 *
 * NO FUNDS, ever: no admin variant in `contracts/src/msg.rs` is payable, and
 * the guard rejects funds on an inner message for the same reason
 * `guardOperatorExecute` rejects them on a fundless operator action.
 */
export function templateExecuteAny(
  policyAddress: string,
  contractAddress: string,
  instance: ProposalTemplateInstance,
): { typeUrl: string; value: Uint8Array } {
  const value = new ProtoWriter()
    .string(WASM_EXEC_FIELD.sender, policyAddress)
    .string(WASM_EXEC_FIELD.contract, contractAddress)
    .bytes(
      WASM_EXEC_FIELD.msg,
      new TextEncoder().encode(templateInnerJson(instance.id, instance.values)),
    )
    .finish();
  return { typeUrl: MSG_EXECUTE_CONTRACT, value };
}

/** `MsgSubmitProposal` (policy=1, proposers=2, metadata=3, messages=4, exec=5,
 * title=6, summary=7). Field 5 is never written — the `exec` pin again. */
function encodeGovSubmitProposal(intent: GovSubmitProposalIntent): Uint8Array {
  // THE INVARIANT, as `encodeExecuteContract` states it: this encoder never
  // produces a message `guardSubmitProposal` would refuse. Preflight and the
  // route schema reject these earlier; the throws are the backstop that keeps
  // the invariant true however the intent was constructed.
  if (intent.templates.length === 0) throw new Error("a proposal must carry at least one message");
  if (intent.templates.length > MAX_PROPOSAL_MESSAGES) {
    throw new Error(`a proposal may carry at most ${MAX_PROPOSAL_MESSAGES} messages`);
  }
  if (intent.title.length === 0 || intent.title.length > MAX_PROPOSAL_TITLE_LEN) {
    throw new Error("proposal title is out of range");
  }
  if (intent.summary.length === 0 || intent.summary.length > MAX_PROPOSAL_SUMMARY_LEN) {
    throw new Error("proposal summary is out of range");
  }
  if (intent.metadata.length > MAX_PROPOSAL_METADATA_LEN) {
    throw new Error("proposal metadata is out of range");
  }

  const writer = new ProtoWriter()
    .string(SUBMIT_FIELD.policyAddress, intent.policyAddress)
    // Exactly one proposer: the relay is sole-signer, and x/group counts every
    // proposer as a required signer. The field is repeated on the wire, so the
    // guard still checks EVERY entry rather than only the first (§4b C1).
    .string(SUBMIT_FIELD.proposers, intent.proposer)
    .string(SUBMIT_FIELD.metadata, intent.metadata);
  for (const instance of intent.templates) {
    const inner = templateExecuteAny(intent.policyAddress, intent.contractAddress, instance);
    writer.message(SUBMIT_FIELD.messages, encodeAny(inner.typeUrl, inner.value), true);
  }
  return writer
    .string(SUBMIT_FIELD.title, intent.title)
    .string(SUBMIT_FIELD.summary, intent.summary)
    .finish();
}

/** Encode the intent's message (the two vault msgs, an operator execute, or one
 * of the three governance messages). */
export function encodeIntentMsg(intent: TxIntent): { typeUrl: string; value: Uint8Array } {
  if (intent.kind === "operator") {
    return { typeUrl: MSG_EXECUTE_CONTRACT, value: encodeExecuteContract(intent) };
  }
  if (intent.kind === "gov_vote") {
    return { typeUrl: MSG_GOV_VOTE, value: encodeGovVote(intent) };
  }
  if (intent.kind === "gov_exec") {
    return { typeUrl: MSG_GOV_EXEC, value: encodeGovExec(intent) };
  }
  if (intent.kind === "gov_submit") {
    return { typeUrl: MSG_GOV_SUBMIT_PROPOSAL, value: encodeGovSubmitProposal(intent) };
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
  switch (intent.kind) {
    case "operator":
      return intent.sender;
    case "gov_vote":
      return intent.voter;
    case "gov_exec":
      return intent.signer;
    case "gov_submit":
      return intent.proposer;
    default:
      return intent.owner;
  }
}

/**
 * The base-unit amount an intent moves.
 *
 * The transacting pages read the amount back OUT of the plan rather than from
 * their own form state, deliberately: the confirm copy must describe the bytes
 * that will be signed, not the input that produced them. The governance
 * messages move no funds at all, so this is `0n` for them — and their flows
 * never render an amount line, which is why that is a value rather than a
 * throw.
 */
export function intentAmount(intent: TxIntent): bigint {
  return isGovernanceIntent(intent) ? 0n : intent.amount;
}

/** Proto-JSON view of an intent's message (the disclosure body). */
export function intentToProtoJson(intent: TxIntent): Record<string, unknown> {
  if (intent.kind === "gov_vote") {
    // The exact message, INCLUDING the pinned fields — `exec` is shown as the
    // no-try value rather than omitted, because "this will not also execute" is
    // the single most consequential fact about this signature (§2.4) and a
    // reader cannot infer it from an absent key.
    return {
      "@type": MSG_GOV_VOTE,
      proposal_id: intent.proposalId.toString(),
      voter: intent.voter,
      option: `VOTE_OPTION_${intent.option.toUpperCase()}`,
      metadata: "",
      exec: "EXEC_UNSPECIFIED",
    };
  }
  if (intent.kind === "gov_exec") {
    return {
      "@type": MSG_GOV_EXEC,
      proposal_id: intent.proposalId.toString(),
      signer: intent.signer,
    };
  }
  if (intent.kind === "gov_submit") {
    return {
      "@type": MSG_GOV_SUBMIT_PROPOSAL,
      group_policy_address: intent.policyAddress,
      proposers: [intent.proposer],
      metadata: intent.metadata,
      // EVERY inner message, decoded — a proposer signing a submission must see
      // what the proposal would execute, not an opaque count (§2.6, §17.1).
      messages: intent.templates.map((instance) => ({
        "@type": MSG_EXECUTE_CONTRACT,
        sender: intent.policyAddress,
        contract: intent.contractAddress,
        msg: JSON.parse(templateInnerJson(instance.id, instance.values)) as Record<string, unknown>,
        funds: [],
      })),
      exec: "EXEC_UNSPECIFIED",
      title: intent.title,
      summary: intent.summary,
    };
  }
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
  /**
   * The `Any`'s raw `value` bytes — EXACTLY what was submitted for this
   * message. The governance guards' final condition compares a canonical
   * re-encode against these, so they are kept verbatim and never normalized.
   */
  value: Uint8Array;
  /**
   * The message's top-level wire fields.
   *
   * The vault and execute guards read one string per field, which the four
   * accessors above serve. The `cosmos.group.v1` messages do not fit that
   * shape — `MsgVote.proposal_id`/`option` are VARINTS and
   * `MsgSubmitProposal.proposers` is a REPEATED string — so their guards read
   * from here instead of through accessors that would answer "" for a field
   * that is present. This also lets a guard assert the FIELD SET is closed,
   * which is how a smuggled unknown field is refused rather than ignored.
   */
  fields: WireField[];
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
      value,
      fields: msg,
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

// ── The governance guards (M7.3–7.4 §2.2) ────────────────────────────────
//
// Two classes, because the payloads differ in kind. Both end where
// `guardOperatorExecute` ends — at a BYTE-IDENTICAL CANONICAL RE-ENCODE — for
// the same reason: the guard does not try to detect every malicious shape, it
// demands the payload equal what this module would itself have built. Duplicate
// keys, field reordering, smuggled fields, non-minimal varints and appended
// junk all fail that comparison without being enumerated.
//
// THE ORDER IS PART OF THE DESIGN and is not reorderable (§8): a condition that
// ran after the re-encode would be dead code, and one that ran before its
// inputs were bounded would decide on values it had not checked.
//
// What these guards do NOT do: authorize anything. The group module decides who
// may vote, whether a proposal passed, and whether it may execute; the contract
// decides whether an admin message is legitimate. These keep the relay from
// being a general governance-submission service for anyone holding a session.

export type GovernanceGuardKind = "vote" | "exec" | "submit";
export type GovernanceGuardResult =
  | { ok: true; kind: GovernanceGuardKind }
  | { ok: false; reason: string };

/** u64 ceiling — `proposal_id`'s type. `readFields` accepts varints wider than
 * 64 bits (it caps the shift at 63), so the bound is asserted, not assumed. */
const U64_MAX = (1n << 64n) - 1n;

/** True when every present field number is one this message defines. An
 * UNKNOWN field is rejected rather than ignored: proto3 would skip it, and a
 * skipped field is one the guard's verdict did not account for. */
function fieldSetWithin(fields: WireField[], allowed: readonly number[]): boolean {
  return fields.every((f) => allowed.includes(f.field));
}

/** Exactly one occurrence of a length-delimited field, or null. Distinguishes
 * "absent" from "repeated", which for a singular proto field is a malformation
 * rather than a value. */
function singleString(fields: WireField[], field: number): string | null {
  const all = stringFields(fields, field);
  return all.length === 1 ? all[0]! : null;
}

/**
 * `MsgVote` / `MsgExec` — the structural guard (§2.2).
 *
 * These carry closed scalar payloads embedding no other message, so there is no
 * template set to match: type URL → signer ↔ session binding → closed field set
 * with bounded values → canonical re-encode.
 */
export function guardGovernanceMsg(
  msg: DecodedMsg,
  expected: { signerAddress: string },
): GovernanceGuardResult {
  if (msg.typeUrl === MSG_GOV_VOTE) return guardVote(msg, expected);
  if (msg.typeUrl === MSG_GOV_EXEC) return guardExec(msg, expected);
  return { ok: false, reason: "not a guarded governance message" };
}

function guardVote(
  msg: DecodedMsg,
  expected: { signerAddress: string },
): GovernanceGuardResult {
  // 2 — voter ↔ session binding. A vote cannot be cast on another's behalf.
  const voter = singleString(msg.fields, VOTE_FIELD.voter);
  if (voter === null || voter !== expected.signerAddress) {
    return { ok: false, reason: "voter is not the session address" };
  }

  // 3 — the closed field set. `exec` and `metadata` get their own verdicts
  // before the general closure check, because "you tried to execute inside a
  // vote" and "you sent a field this message does not define" are different
  // things to have caught, and the matrix names each (§4 invariants 4, 13).
  if (hasField(msg.fields, VOTE_FIELD.exec)) {
    // §2.4: EXEC_TRY would turn this vote into a vote PLUS execution of
    // whatever the proposal contains. Pinned to the no-try value, which proto3
    // encodes as absence — so ANY present `exec`, including an explicit zero
    // written non-canonically, is refused here.
    return { ok: false, reason: "a vote must not attempt execution in the same transaction" };
  }
  if (hasField(msg.fields, VOTE_FIELD.metadata)) {
    return { ok: false, reason: "vote metadata is not carried" };
  }
  if (!fieldSetWithin(msg.fields, [VOTE_FIELD.proposalId, VOTE_FIELD.voter, VOTE_FIELD.option])) {
    return { ok: false, reason: "unexpected field in vote" };
  }

  // Bounded values. x/group ids start at 1, so 0 — which proto3 also encodes as
  // absence — is not a proposal.
  const proposalId = uintField(msg.fields, VOTE_FIELD.proposalId);
  if (proposalId === null || proposalId <= 0n || proposalId > U64_MAX) {
    return { ok: false, reason: "proposal id is not a u64 proposal id" };
  }
  const option = uintField(msg.fields, VOTE_FIELD.option);
  const optionName =
    option === null
      ? undefined
      : GOVERNANCE_VOTE_OPTION_NAMES.find((name) => GOVERNANCE_VOTE_OPTIONS[name] === option);
  if (optionName === undefined) {
    return { ok: false, reason: "vote option is not one of the four vote options" };
  }

  // 4 — canonical byte equality with what this module would have built.
  const canonical = encodeGovVote({
    kind: "gov_vote",
    voter,
    proposalId,
    option: optionName,
  });
  if (!bytesEqual(canonical, msg.value)) {
    return { ok: false, reason: "vote is not in canonical form" };
  }
  return { ok: true, kind: "vote" };
}

function guardExec(
  msg: DecodedMsg,
  expected: { signerAddress: string },
): GovernanceGuardResult {
  // 2 — signer ↔ session binding. Execution is permissionless in x/group, but
  // the RELAY carries the session's own transactions and nobody else's.
  const signer = singleString(msg.fields, EXEC_FIELD.signer);
  if (signer === null || signer !== expected.signerAddress) {
    return { ok: false, reason: "signer is not the session address" };
  }
  // 3 — the closed field set. `MsgExec` defines exactly these two fields.
  if (!fieldSetWithin(msg.fields, [EXEC_FIELD.proposalId, EXEC_FIELD.signer])) {
    return { ok: false, reason: "unexpected field in exec" };
  }
  const proposalId = uintField(msg.fields, EXEC_FIELD.proposalId);
  if (proposalId === null || proposalId <= 0n || proposalId > U64_MAX) {
    return { ok: false, reason: "proposal id is not a u64 proposal id" };
  }
  // 4 — canonical byte equality.
  const canonical = encodeGovExec({ kind: "gov_exec", signer, proposalId });
  if (!bytesEqual(canonical, msg.value)) {
    return { ok: false, reason: "exec is not in canonical form" };
  }
  return { ok: true, kind: "exec" };
}

/**
 * `MsgSubmitProposal` — the SIX-condition guard (§2.2).
 *
 * This is the message the whole design exists for. It carries `messages []Any`
 * destined for the group policy account, which is the contract's admin, so a
 * plain type-URL entry would open the relay to arbitrary admin calls. The six
 * conditions, in order:
 *
 *   1. type URL is `/cosmos.group.v1.MsgSubmitProposal`;
 *   2. EVERY entry in `proposers` equals the session address;
 *   3. `group_policy_address` is one of the DISCOVERED program policies —
 *      never an arbitrary account, and never a hardcoded "the admin policy"
 *      (D1: policy discovery is set-valued);
 *   4. each inner `Any` is matched against the CLOSED template set — its type
 *      URL, its sender, its target contract, its variant and its full field set;
 *   5. BYTE-IDENTICAL canonical re-encode PER INNER MESSAGE — a proposal is
 *      only as safe as its least-checked element (§4 invariant 3);
 *   6. `exec` is pinned to the no-try value (§2.4).
 *
 * …then a whole-message canonical re-encode as the closing backstop, which is
 * what refuses field reordering, a duplicated proposer, and anything appended
 * after a payload that individually passed.
 */
export function guardSubmitProposal(
  msg: DecodedMsg,
  expected: {
    signerAddress: string;
    contractAddress: string;
    /** The live, DISCOVERED program policy set. Never a literal. */
    policyAddresses: readonly string[];
  },
): GovernanceGuardResult {
  // 1 — type URL.
  if (msg.typeUrl !== MSG_GOV_SUBMIT_PROPOSAL) {
    return { ok: false, reason: "not a proposal submission" };
  }

  // 2 — proposer ↔ session binding, over EVERY entry. x/group permits several
  // proposers and counts each as a required signer, so checking only the first
  // is the §4b C1 failure shape: a verdict decided by one element of a
  // collection while another rides along unchecked.
  const proposers = stringFields(msg.fields, SUBMIT_FIELD.proposers);
  if (proposers.length === 0) {
    return { ok: false, reason: "a proposal must name its proposer" };
  }
  if (proposers.some((proposer) => proposer !== expected.signerAddress)) {
    return { ok: false, reason: "proposer is not the session address" };
  }

  // 3 — a discovered program policy, not an arbitrary account.
  const policyAddress = singleString(msg.fields, SUBMIT_FIELD.policyAddress);
  if (policyAddress === null) {
    return { ok: false, reason: "a proposal must name exactly one group policy" };
  }
  if (!expected.policyAddresses.includes(policyAddress)) {
    return { ok: false, reason: "group policy is not a program policy" };
  }

  // The closed field set and the text bounds, before any payload is read.
  if (
    !fieldSetWithin(msg.fields, [
      SUBMIT_FIELD.policyAddress,
      SUBMIT_FIELD.proposers,
      SUBMIT_FIELD.metadata,
      SUBMIT_FIELD.messages,
      SUBMIT_FIELD.exec,
      SUBMIT_FIELD.title,
      SUBMIT_FIELD.summary,
    ])
  ) {
    return { ok: false, reason: "unexpected field in proposal" };
  }
  const metadataValues = stringFields(msg.fields, SUBMIT_FIELD.metadata);
  if (metadataValues.length > 1) return { ok: false, reason: "unexpected field in proposal" };
  const metadata = metadataValues[0] ?? "";
  if (metadata.length > MAX_PROPOSAL_METADATA_LEN) {
    return { ok: false, reason: "proposal metadata is too long" };
  }
  const title = singleString(msg.fields, SUBMIT_FIELD.title);
  if (title === null || title.length === 0 || title.length > MAX_PROPOSAL_TITLE_LEN) {
    return { ok: false, reason: "proposal title is missing or too long" };
  }
  const summary = singleString(msg.fields, SUBMIT_FIELD.summary);
  if (summary === null || summary.length === 0 || summary.length > MAX_PROPOSAL_SUMMARY_LEN) {
    return { ok: false, reason: "proposal summary is missing or too long" };
  }

  // 4 + 5 — every inner message, individually.
  const innerAnys = bytesFields(msg.fields, SUBMIT_FIELD.messages);
  if (innerAnys.length === 0) {
    // Legal on the wire; explicitly refused. An empty proposal is not a
    // template instance, and it is a proposal to do nothing that would still
    // consume the group's voting period (§4b C1).
    return { ok: false, reason: "a proposal must carry at least one message" };
  }
  if (innerAnys.length > MAX_PROPOSAL_MESSAGES) {
    // REJECTED, never truncated: a governance payload quietly shortened on its
    // way to the chain would be a lie about what is being voted on.
    return { ok: false, reason: "a proposal carries too many messages" };
  }

  const templates: ProposalTemplateInstance[] = [];
  for (const anyBytes of innerAnys) {
    const verdict = guardInnerTemplateMessage(anyBytes, {
      policyAddress,
      contractAddress: expected.contractAddress,
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    templates.push(verdict.instance);
  }

  // 6 — the `exec` pin (§2.4). A submission with EXEC_TRY would submit AND
  // execute in one transaction, which for a single-member or already-satisfied
  // policy means an admin program-op reaching the chain under one signature the
  // user was shown as "propose".
  if (hasField(msg.fields, SUBMIT_FIELD.exec)) {
    return { ok: false, reason: "a proposal must not attempt execution in the same transaction" };
  }

  // The closing backstop: the whole message, re-encoded from what was just
  // validated, must equal the submitted bytes. Individually-valid parts in a
  // non-canonical arrangement — a duplicated proposer, reordered fields, a
  // trailing unknown region — die here.
  const canonical = encodeGovSubmitProposal({
    kind: "gov_submit",
    proposer: expected.signerAddress,
    policyAddress,
    contractAddress: expected.contractAddress,
    templates,
    title,
    summary,
    metadata,
  });
  if (!bytesEqual(canonical, msg.value)) {
    return { ok: false, reason: "proposal is not in canonical form" };
  }
  return { ok: true, kind: "submit" };
}

type InnerVerdict =
  | { ok: true; instance: ProposalTemplateInstance }
  | { ok: false; reason: string };

/**
 * One inner `Any`: condition 4 (structure) and condition 5 (canonical bytes).
 *
 * THE THREE ROUTES THIS EXISTS TO REFUSE (§4 invariant 8's disproof line), each
 * of which reaches the contract's admin authority by a different path and none
 * of which the M6.4 matrix models:
 *
 *   * an inner message that is itself a `MsgSubmitProposal` (governance
 *     nesting) — refused by the type-URL check;
 *   * an inner message targeting the GROUP MODULE rather than the contract
 *     (`MsgUpdateGroupMembers`, which changes WHO GOVERNS) — same check;
 *   * an `authz`/`MsgExec`-wrapped admin message — same check.
 *
 * The type-URL check admits `MsgExecuteContract` and nothing else, which is why
 * all three land on one line rather than three special cases.
 */
function guardInnerTemplateMessage(
  anyBytes: Uint8Array,
  expected: { policyAddress: string; contractAddress: string },
): InnerVerdict {
  let anyFields: WireField[];
  try {
    anyFields = readFields(anyBytes);
  } catch {
    return { ok: false, reason: "malformed inner message" };
  }
  if (!fieldSetWithin(anyFields, [1, 2])) {
    return { ok: false, reason: "malformed inner message" };
  }
  const innerTypeUrl = singleString(anyFields, 1);
  const innerValue = bytesField(anyFields, 2);
  if (innerTypeUrl === null || innerValue === null) {
    return { ok: false, reason: "malformed inner message" };
  }
  if (innerTypeUrl !== MSG_EXECUTE_CONTRACT) {
    return { ok: false, reason: "inner message type is not in the template set" };
  }

  let execFields: WireField[];
  try {
    execFields = readFields(innerValue);
  } catch {
    return { ok: false, reason: "malformed inner message" };
  }
  if (
    !fieldSetWithin(execFields, [
      WASM_EXEC_FIELD.sender,
      WASM_EXEC_FIELD.contract,
      WASM_EXEC_FIELD.msg,
      WASM_EXEC_FIELD.funds,
    ])
  ) {
    return { ok: false, reason: "unexpected field in inner message" };
  }
  // The sender is the POLICY account: x/group executes a proposal's messages as
  // the policy, and the policy is the contract's admin. Anything else is either
  // a message that cannot execute or one aimed somewhere this guard does not
  // reason about.
  if (singleString(execFields, WASM_EXEC_FIELD.sender) !== expected.policyAddress) {
    return { ok: false, reason: "inner message sender is not the group policy" };
  }
  if (singleString(execFields, WASM_EXEC_FIELD.contract) !== expected.contractAddress) {
    return { ok: false, reason: "inner message targets a different contract" };
  }
  // No admin variant is payable. Funds here would move value under a
  // confirmation that said nothing about an amount.
  if (bytesFields(execFields, WASM_EXEC_FIELD.funds).length !== 0) {
    return { ok: false, reason: "an admin action must not carry funds" };
  }

  const payloadBytes = bytesField(execFields, WASM_EXEC_FIELD.msg);
  if (payloadBytes === null) {
    return { ok: false, reason: "inner message has no execute payload" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    return { ok: false, reason: "inner execute payload is not JSON" };
  }
  const match = matchTemplateInstance(parsed);
  if (!match.ok) {
    return { ok: false, reason: "inner message is not an admin-action template instance" };
  }

  // 5 — canonical byte equality, PER ELEMENT. `matchTemplateInstance` believes
  // it validated a template; this proves the bytes are the ones this module
  // would have produced for what it believes.
  const instance: ProposalTemplateInstance = { id: match.id, values: match.values };
  const canonical = templateExecuteAny(
    expected.policyAddress,
    expected.contractAddress,
    instance,
  );
  if (!bytesEqual(canonical.value, innerValue)) {
    return { ok: false, reason: "inner message is not in canonical form" };
  }
  return { ok: true, instance };
}
