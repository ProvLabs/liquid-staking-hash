// Raw x/group chain shapes -> the typed facts of events.ts.
//
// Two decode surfaces, because x/group splits its information across them:
//   - EVENTS (tx and block planes) carry proposal ids, exec results and prune
//     outcomes, but NOT a vote's voter or option;
//   - JSON PAYLOADS (height-pinned LCD reads) carry full proposal and vote state.
//
// Everything goes through `decode/attributes.ts`'s `dequote`, the one place the
// extra JSON-string quoting layer lives. x/group quotes its string attribute
// values (`proposal_id: "6"`) and leaves `msg_index` bare (`0`) — the same mixed
// shape the vault/contract corpus pins, so no new idiom is introduced.
//
// UNKNOWN SHAPES FAIL HONESTLY, NEVER FATALLY (invariant 8). An
// unrecognized enum member maps to `UNSPECIFIED` and an unrecognized decision
// policy is kept as raw JSON: a chain upgrade that adds an enum value must not
// stall a worker mid-window, because an aborted window is re-collected forever
// and would wedge the whole stream (the 2026-07-28 chain-events lesson). What is
// NEVER tolerated is a missing or malformed REQUIRED field on a shape we do
// claim to understand — that is a decoder bug or an upgrade, and it throws.

import {
  DecodeError,
  attr,
  dequote,
  optionalAttr,
  type RawEvent,
} from "../../decode/attributes.ts";
import {
  EXECUTOR_RESULTS,
  GROUP_EVENT,
  MSG_VOTE_TYPE_URL,
  PROPOSAL_STATUSES,
  VOTE_OPTIONS,
  ZERO_TALLY,
  type ExecFact,
  type ExecutorResult,
  type ProposalSnapshot,
  type ProposalStatus,
  type PruneFact,
  type SubmitFact,
  type Tally,
  type TxVoteFact,
  type VoteOption,
  type VoteSnapshot,
} from "./events.ts";

const UINT_RE = /^(0|[1-9][0-9]*)$/;

/** Canonical unsigned decimal string, UNBOUNDED. Member weights and tally counts
 * have no protocol ceiling, so a Uint128 bound would be an invented limit — the
 * shape is validated and the value stays a string. */
function decimalString(value: unknown, path: string): string {
  if (typeof value !== "string" || !UINT_RE.test(value)) {
    throw new DecodeError(path, "expected canonical unsigned integer string", value);
  }
  return value;
}

function u64(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !UINT_RE.test(value)) {
    throw new DecodeError(path, "expected string-encoded uint64", value);
  }
  const n = BigInt(value);
  if (n >= 1n << 64n) throw new DecodeError(path, "exceeds uint64 range", value);
  return n;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") throw new DecodeError(path, "expected string", value);
  return value;
}

function timestamp(value: unknown, path: string): Date {
  const parsed = new Date(str(value, path));
  if (Number.isNaN(parsed.getTime())) throw new DecodeError(path, "unparseable timestamp", value);
  return parsed;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DecodeError(path, "expected object", value);
  }
  return value as Record<string, unknown>;
}

/**
 * Strip a proto enum prefix and validate against a closed set, falling back to
 * the set's `UNSPECIFIED` member rather than throwing. See the header: an enum a
 * chain upgrade adds must degrade to a value the surfaces already render
 * honestly, not wedge the stream.
 */
function enumMember<T extends string>(
  raw: string,
  prefix: string,
  allowed: readonly T[],
): T {
  const stripped = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return (allowed as readonly string[]).includes(stripped)
    ? (stripped as T)
    : (allowed[allowed.length - 1] as T);
}

export function decodeStatus(raw: string): ProposalStatus {
  return enumMember(raw, "PROPOSAL_STATUS_", PROPOSAL_STATUSES);
}
export function decodeExecutorResult(raw: string): ExecutorResult {
  return enumMember(raw, "PROPOSAL_EXECUTOR_RESULT_", EXECUTOR_RESULTS);
}
export function decodeVoteOption(raw: string): VoteOption {
  return enumMember(raw, "VOTE_OPTION_", VOTE_OPTIONS);
}

// --- event decoding --------------------------------------------------------

/** `msg_index` arrives BARE while string attributes are JSON-quoted; `dequote`
 * handles both, and the value is bounded as a safe integer. Absent means 0 (a
 * single-message transaction), which is what the SDK omits. */
function msgIndexOf(event: RawEvent): number {
  const raw = optionalAttr(event, "msg_index");
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new DecodeError(`${event.type}.msg_index`, "expected a non-negative safe integer", raw);
  }
  return n;
}

function proposalIdOf(event: RawEvent): bigint {
  return u64(attr(event, "proposal_id"), `${event.type}.proposal_id`);
}

export function decodeSubmitEvent(event: RawEvent, txhash: string, height: bigint): SubmitFact {
  return { proposalId: proposalIdOf(event), txhash, height, msgIndex: msgIndexOf(event) };
}

export function decodeExecEvent(event: RawEvent, height: bigint): ExecFact {
  return {
    proposalId: proposalIdOf(event),
    result: decodeExecutorResult(attr(event, "result")),
    height,
  };
}

/**
 * `EventProposalPruned` -> the terminal state the chain is discarding. Its
 * `tally_result` attribute is a JSON OBJECT encoded as a string, which is the
 * only shape in this family that is not a scalar. A tally that fails to parse
 * yields `null` rather than throwing: the prune itself is the load-bearing fact,
 * and losing the row entirely because its tally was unreadable would be strictly
 * worse than recording the prune without one.
 */
export function decodeProposalPrunedEvent(event: RawEvent, height: bigint): PruneFact {
  let tally: Tally | null = null;
  const raw = optionalAttr(event, "tally_result");
  if (raw !== undefined && raw !== "") {
    try {
      tally = decodeTally(JSON.parse(raw), `${event.type}.tally_result`);
    } catch {
      tally = null;
    }
  }
  return {
    proposalId: proposalIdOf(event),
    status: decodeStatus(optionalAttr(event, "status") ?? ""),
    tally,
    height,
  };
}

export function decodeWithdrawEvent(event: RawEvent, height: bigint): PruneFact {
  // A withdrawal is not itself a prune — the row survives until the EndBlocker
  // drops it — so this reports the STATUS transition and leaves the prune to the
  // signal that actually observes one.
  return { proposalId: proposalIdOf(event), status: "WITHDRAWN", tally: null, height };
}

/**
 * Votes, decoded from a transaction's `EventVote`s PAIRED WITH the `MsgVote`
 * bodies in the same transaction. The event carries only `proposal_id` and
 * `msg_index`; the voter and the option exist only in the body.
 *
 * Pairing is BY `msg_index` into the message array, not positional across the two
 * lists, because a transaction can mix `MsgVote` with other messages. A vote
 * whose body cannot be located is SKIPPED and reported, never guessed: the
 * per-element quarantine rule (invariant 8's disproof) — one undecodable element
 * must not drop its siblings, and a fabricated voter would be a lie about who
 * voted.
 */
export function decodeTxVotes(
  events: readonly RawEvent[],
  messages: readonly unknown[],
  ctx: { txhash: string; height: bigint; blockTime: Date },
): { votes: TxVoteFact[]; undecodable: { msgIndex: number; reason: string }[] } {
  const votes: TxVoteFact[] = [];
  const undecodable: { msgIndex: number; reason: string }[] = [];

  for (const event of events) {
    if (event.type !== GROUP_EVENT.vote) continue;
    const msgIndex = msgIndexOf(event);
    const body = messages[msgIndex];

    if (typeof body !== "object" || body === null) {
      undecodable.push({ msgIndex, reason: "no message body at this msg_index" });
      continue;
    }
    const o = body as Record<string, unknown>;
    const typeUrl = typeof o["@type"] === "string" ? o["@type"] : "";
    if (typeUrl !== MSG_VOTE_TYPE_URL) {
      undecodable.push({ msgIndex, reason: `message at this index is ${typeUrl || "untyped"}, not MsgVote` });
      continue;
    }
    const voter = o["voter"];
    if (typeof voter !== "string" || voter === "") {
      undecodable.push({ msgIndex, reason: "MsgVote body carries no voter" });
      continue;
    }
    votes.push({
      proposalId: proposalIdOf(event),
      voter,
      option: decodeVoteOption(typeof o["option"] === "string" ? o["option"] : ""),
      metadata: typeof o["metadata"] === "string" ? o["metadata"] : "",
      txhash: ctx.txhash,
      height: ctx.height,
      msgIndex,
      blockTime: ctx.blockTime,
    });
  }
  return { votes, undecodable };
}

/** Does this transaction carry any x/group event worth decoding? Cheap pre-pass
 * so a window of unrelated traffic costs no body parsing. */
export function hasGroupEvent(events: readonly RawEvent[]): boolean {
  return events.some((e) => e.type.startsWith("cosmos.group.v1.Event"));
}

/** Every `msg_index` value of a given group event type, dequoted. Used by the
 * multiplicity tests to prove per-index discovery. */
export function groupEventIndexes(events: readonly RawEvent[], type: string): number[] {
  return events.filter((e) => e.type === type).map((e) => msgIndexOf(e));
}

// --- JSON payload decoding (state plane) -----------------------------------

export function decodeTally(value: unknown, path = "$"): Tally {
  const o = record(value, path);
  return {
    yes: decimalString(o["yes_count"], `${path}.yes_count`),
    no: decimalString(o["no_count"], `${path}.no_count`),
    abstain: decimalString(o["abstain_count"], `${path}.abstain_count`),
    noWithVeto: decimalString(o["no_with_veto_count"], `${path}.no_with_veto_count`),
  };
}

/**
 * A proposal payload. `messages` and `decisionPolicy` are carried through
 * UNTOUCHED — 7.2's decoder and 7.4's byte-identical canonical re-encode guard
 * both need the exact payload, so any normalization here would break a guard far
 * away from here.
 *
 * `decisionPolicy` is supplied by the caller rather than read from the proposal:
 * the proposal payload does not contain it, and the point of storing it is to
 * snapshot the rule IN FORCE AT SUBMIT, since the live policy can change.
 */
export function decodeProposal(
  value: unknown,
  context: { groupId: bigint; decisionPolicy: unknown },
  path = "$",
): ProposalSnapshot {
  const o = record(value, path);
  const proposers = o["proposers"];
  if (!Array.isArray(proposers)) throw new DecodeError(`${path}.proposers`, "expected array", proposers);
  const messages = o["messages"];
  return {
    proposalId: u64(o["id"], `${path}.id`),
    groupPolicyAddress: str(o["group_policy_address"], `${path}.group_policy_address`),
    groupId: context.groupId,
    proposers: proposers.map((p, i) => str(p, `${path}.proposers[${i}]`)),
    status: decodeStatus(str(o["status"] ?? "", `${path}.status`)),
    executorResult: decodeExecutorResult(str(o["executor_result"] ?? "", `${path}.executor_result`)),
    metadata: typeof o["metadata"] === "string" ? o["metadata"] : "",
    title: typeof o["title"] === "string" ? o["title"] : "",
    summary: typeof o["summary"] === "string" ? o["summary"] : "",
    messages: Array.isArray(messages) ? messages : [],
    submitTime: timestamp(o["submit_time"], `${path}.submit_time`),
    votingPeriodEnd: timestamp(o["voting_period_end"], `${path}.voting_period_end`),
    tally:
      o["final_tally_result"] === undefined
        ? ZERO_TALLY
        : decodeTally(o["final_tally_result"], `${path}.final_tally_result`),
    groupVersion: u64(o["group_version"], `${path}.group_version`),
    groupPolicyVersion: u64(o["group_policy_version"], `${path}.group_policy_version`),
    decisionPolicy: context.decisionPolicy,
  };
}

/**
 * A vote payload. `weight` comes from the caller's member-set lookup, not from
 * the payload — the module's `Vote` has no weight field (pinned 2026-07-29), and
 * a fabricated weight would misstate how a proposal passed.
 */
export function decodeVote(value: unknown, weight: string | null, path = "$"): VoteSnapshot {
  const o = record(value, path);
  return {
    proposalId: u64(o["proposal_id"], `${path}.proposal_id`),
    voter: str(o["voter"], `${path}.voter`),
    option: decodeVoteOption(str(o["option"] ?? "", `${path}.option`)),
    metadata: typeof o["metadata"] === "string" ? o["metadata"] : "",
    submitTime: timestamp(o["submit_time"], `${path}.submit_time`),
    weight,
  };
}

/** Group-member weights by address, for resolving a vote's weight. The LCD nests
 * the member under `member` alongside `group_id`. */
export function decodeMemberWeights(value: unknown, path = "$.members"): Map<string, string> {
  const weights = new Map<string, string>();
  if (!Array.isArray(value)) return weights;
  value.forEach((entry, i) => {
    const m = record(record(entry, `${path}[${i}]`)["member"], `${path}[${i}].member`);
    weights.set(
      str(m["address"], `${path}[${i}].member.address`),
      decimalString(m["weight"], `${path}[${i}].member.weight`),
    );
  });
  return weights;
}

/** Is this LCD error body the module's "this proposal does not exist" answer?
 *
 * It matters because the answer arrives as HTTP **500**, not 404, and is
 * byte-identical for a proposal that was pruned and one that never existed
 * (observed 2026-07-29). This predicate exists so that distinction is written
 * down in exactly one place — and note what it is NOT used for: absence alone
 * never justifies writing `prunedAtHeight`, because a node outage and a bad
 * height pin also answer 500. Prune is established by absence from a SUCCESSFUL
 * paginated sweep or by an observed `EventProposalPruned`.
 */
export function isNotFoundBody(body: string): boolean {
  return /not found/i.test(body);
}

export { dequote };
