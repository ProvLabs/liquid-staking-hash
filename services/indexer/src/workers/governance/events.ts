// The x/group facts the governance worker derives from chain, and the event
// types they decode from. Every type and quirk below was OBSERVED on the devnet
// 2026-07-29 by `contracts/drills/gov-drill.sh` and is pinned in
// `packages/fixtures/fixtures/manifest.json` — none is taken from module docs.
//
// THREE PLANES, and which one is authoritative for what. All three are
// required: no one of them is complete (chain-facts §x/group 1–4).
//
//   1. TX PLANE (tx-search) — provenance AND the terminal outcomes the state
//      plane cannot hold. A proposal that executes SUCCESSFULLY is pruned in the
//      same transaction, so `ACCEPTED` + `SUCCESS` is a pair no state read can
//      ever return; `EventExec.result` and `EventProposalPruned` (which carries
//      the terminal status AND the full tally) are its only record. This plane is
//      also the only durable source of WHO VOTED: the module deletes a
//      proposal's votes at its voting-period-end tally.
//   2. BLOCK PLANE (block_results.finalize_block_events) — prune detection only.
//      `EventProposalPruned` is the ONE x/group EndBlocker event on this build
//      (295 heights scanned); there is NO voting-period-end tally event, so the
//      SUBMITTED→REJECTED/ACCEPTED transition is eventless.
//   3. STATE PLANE (height-pinned, paginated) — authority for the status and
//      tally of every proposal the chain STILL HOLDS, and the only observer of
//      the eventless voting-period-end transition.
//
// Attribute values are JSON-string-quoted for strings (`proposal_id: "6"`,
// `status`, `result`) and BARE for `msg_index` (`0`) — the same mixed shape the
// vault/contract corpus already pins, so `decode/attributes.ts`'s `dequote`
// remains the single decoding idiom.

/** x/group event type URLs (cosmos.group.v1). */
export const GROUP_EVENT = {
  submitProposal: "cosmos.group.v1.EventSubmitProposal",
  /** Carries ONLY proposal_id + msg_index — the voter and option come from the
   * `MsgVote` body at that msg_index, never from the event. */
  vote: "cosmos.group.v1.EventVote",
  /** Carries `result` — the only record that an execution succeeded. */
  exec: "cosmos.group.v1.EventExec",
  withdrawProposal: "cosmos.group.v1.EventWithdrawProposal",
  /** Carries the terminal `status` AND the full `tally_result`. Emitted BOTH in
   * the executing transaction (a successful exec prunes itself) and by the
   * EndBlocker (withdrawn/aborted proposals, pruned after their voting period). */
  proposalPruned: "cosmos.group.v1.EventProposalPruned",
} as const;

/**
 * The group event types that appear in `finalize_block_events` on this build.
 * A SET rather than a constant so the block plane is provably correct either
 * way: if a future build starts emitting a voting-period-end tally event, adding
 * it here turns that plane on, and if this set were ever empty the worker would
 * skip the per-height fetch entirely instead of paying for nothing.
 */
export const GROUP_BLOCK_EVENT_TYPES: readonly string[] = [GROUP_EVENT.proposalPruned];

/** `MsgVote`'s type URL — the body carrying voter, option and metadata. */
export const MSG_VOTE_TYPE_URL = "/cosmos.group.v1.MsgVote";

/** Closed status set. `ABORTED` is here because it is in the module's proto,
 * NOT because the corpus reaches it — the drill could not produce an abort on
 * this build, and multiplicity comes from the producing system rather than from
 * the path a drill happens to walk. */
export const PROPOSAL_STATUSES = [
  "SUBMITTED",
  "ACCEPTED",
  "REJECTED",
  "ABORTED",
  "WITHDRAWN",
  "UNSPECIFIED",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const EXECUTOR_RESULTS = ["NOT_RUN", "SUCCESS", "FAILURE", "UNSPECIFIED"] as const;
export type ExecutorResult = (typeof EXECUTOR_RESULTS)[number];

export const VOTE_OPTIONS = ["YES", "NO", "ABSTAIN", "NO_WITH_VETO", "UNSPECIFIED"] as const;
export type VoteOption = (typeof VOTE_OPTIONS)[number];

/** A proposal's four tally counts. Canonical decimal STRINGS: these are sums of
 * member WEIGHTS, unbounded integers with no protocol ceiling, so a JS number
 * would corrupt them silently past 2^53. */
export interface Tally {
  readonly yes: string;
  readonly no: string;
  readonly abstain: string;
  readonly noWithVeto: string;
}

export const ZERO_TALLY: Tally = { yes: "0", no: "0", abstain: "0", noWithVeto: "0" };

// --- state-plane facts -----------------------------------------------------

/** A proposal as the chain holds it at a pinned height — the authority for
 * status and tally while the chain still has it. */
export interface ProposalSnapshot {
  readonly proposalId: bigint;
  readonly groupPolicyAddress: string;
  readonly groupId: bigint;
  readonly proposers: string[];
  readonly status: ProposalStatus;
  readonly executorResult: ExecutorResult;
  readonly metadata: string;
  readonly title: string;
  readonly summary: string;
  /** Stored VERBATIM: 7.2 decodes these and 7.4 canonically re-encodes them. */
  readonly messages: unknown[];
  readonly submitTime: Date;
  readonly votingPeriodEnd: Date;
  readonly tally: Tally;
  readonly groupVersion: bigint;
  readonly groupPolicyVersion: bigint;
  /** The decision policy in force AT SUBMIT — snapshotted, because the live
   * policy can change and a historical tally-vs-threshold is otherwise
   * unrenderable. */
  readonly decisionPolicy: unknown;
}

/** A vote as the chain holds it. Recoverable ONLY while its proposal is open. */
export interface VoteSnapshot {
  readonly proposalId: bigint;
  readonly voter: string;
  readonly option: VoteOption;
  readonly metadata: string;
  readonly submitTime: Date;
  /** The voter's weight at this height, resolved from the group's member set —
   * the module's `Vote` payload has no weight field. Null means "not
   * recoverable", never 0. */
  readonly weight: string | null;
}

// --- tx/block-plane facts --------------------------------------------------

/** Submit provenance: the only source of a proposal's txhash and height. */
export interface SubmitFact {
  readonly proposalId: bigint;
  readonly txhash: string;
  readonly height: bigint;
  readonly msgIndex: number;
}

/**
 * A vote read from a transaction. Keyed for discovery per `msgIndex`, never per
 * txhash: one transaction may legally carry several `MsgVote`s for different
 * proposals (the drill produces exactly that), and keying by txhash would drop
 * all but one — the batched-payment defect in a new place.
 */
export interface TxVoteFact {
  readonly proposalId: bigint;
  readonly voter: string;
  readonly option: VoteOption;
  readonly metadata: string;
  readonly txhash: string;
  readonly height: bigint;
  readonly msgIndex: number;
  readonly blockTime: Date;
}

/** An execution outcome. The state plane cannot see a SUCCESS at all. */
export interface ExecFact {
  readonly proposalId: bigint;
  readonly result: ExecutorResult;
  readonly height: bigint;
}

/** A prune, with the terminal state the chain discarded along with the row. */
export interface PruneFact {
  readonly proposalId: bigint;
  readonly status: ProposalStatus;
  readonly tally: Tally | null;
  readonly height: bigint;
}
