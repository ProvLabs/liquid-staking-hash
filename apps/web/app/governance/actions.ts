// The state × affordance matrix (M7.3–7.4 §4b C4). PURE — no I/O, no clock
// beyond the `nowMs` passed in, no config.
//
// WHY THIS IS A MODULE AND NOT JSX. 7.2 filled C4 with every row reading "read
// only" and changed nothing, and the plan says to judge that table HERE, where
// affordances first exist. The M6.4 P1 it exists to prevent — an action panel
// rendered against a state the action could not validly operate on — was a
// decision made in a component, where it could not be driven by a table. So the
// decision is a function over a closed input, and `test/governance-flows.test.ts`
// drives one case per row.
//
// TWO RULES SHAPE EVERY ANSWER:
//
//   1. **Affordances come from the LIVE plane alone** (§4b C5). An action is
//      never offered on the strength of an indexed row a live read has not
//      confirmed: a stale "accepted" that has since been executed would offer
//      an execute button guaranteed to fail. When the live read is down, actions
//      are HIDDEN WITH THE REASON STATED, never rendered optimistically. This is
//      why `liveState` is a separate, nullable input rather than being read off
//      the display fields — the display plane may legitimately be the mirror
//      while the affordance plane is not.
//
//   2. **A hidden control always says why** (the console R1 rule). There is no
//      "hidden, silently": every hidden verdict carries a reason the page
//      renders, and the one state that is DISABLED rather than hidden is the
//      pending execution window — because the user needs to know it is coming.

import type { GovExecutorResult, GovProposalStatus } from "@nvhash/api-types";

/**
 * The live plane's own view of a proposal, when a live read succeeded.
 *
 * `null` means the chain could not be asked — which for an OPEN proposal is a
 * failed read and for a SUCCESSFULLY EXECUTED one is the module having pruned
 * it in its own transaction (M7 overview F4, strengthened at 7.1 closure). Both
 * land on the same answer: no action is offered.
 */
export interface LiveProposalState {
  status: GovProposalStatus;
  executorResult: GovExecutorResult;
  /** The proposal's own submit time — `min_execution_period` counts from it. */
  submitTime: string;
  votingPeriodEnd: string;
  groupVersion: string;
}

export interface AffordanceInput {
  /** Null when no live read confirmed the proposal (rule 1). */
  live: LiveProposalState | null;
  /** True when the mirror records the chain has discarded this proposal. */
  pruned: boolean;
  /** The proposal's group version differs from the live group's. */
  membershipChanged: boolean;
  /** The connected session address, or null for an anonymous reader. */
  sessionAddress: string | null;
  /** Whether the session is in the LIVE member set. Null = not checked. */
  isMember: boolean | null;
  /** Whether the session already has a recorded vote on this proposal. */
  hasVoted: boolean;
  /** The recorded option, for the "you voted X" copy. */
  votedOption: string | null;
  /** The policy's `min_execution_period` as x/group serializes it (e.g. "600s").
   * Null when the policy snapshot did not carry one. */
  minExecutionPeriod: string | null;
  nowMs: number;
}

export type VoteHiddenReason =
  | "anonymous"
  | "live-unavailable"
  | "pruned"
  | "not-open"
  | "voting-ended"
  | "not-member"
  | "membership-unknown"
  | "already-voted"
  | "membership-changed";

export type ExecuteHiddenReason =
  | "anonymous"
  | "live-unavailable"
  | "pruned"
  | "not-passed"
  | "already-executed"
  | "execution-failed"
  | "terminal";

export type VoteAffordance =
  | { state: "offered" }
  | { state: "hidden"; reason: VoteHiddenReason; option?: string };

export type ExecuteAffordance =
  | { state: "offered" }
  /** Shown but not actionable, WITH the eligible-at time. Never hidden: the
   * user needs to know it is coming (§4b C4). */
  | { state: "disabled"; reason: "min-execution-pending"; readyAtIso: string | null }
  | { state: "hidden"; reason: ExecuteHiddenReason };

/**
 * Parse an x/group protobuf duration as the LCD serializes it: seconds with a
 * trailing `s`, optionally fractional (`"600s"`, `"0.5s"`).
 *
 * Returns null for anything else, and null PROPAGATES to "we cannot say when" —
 * never to 0, which would claim a proposal is executable now.
 */
export function parseDurationSeconds(duration: string | null): number | null {
  if (duration === null) return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(duration.trim());
  if (match === null) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * The earliest instant a passed proposal may be executed.
 *
 * x/group's `Exec` compares the block time against
 * `proposal.submit_time + min_execution_period` — SUBMIT time, not the voting
 * period's end. Getting that wrong would show a countdown that expires before
 * the chain agrees, and the user would sign into a revert.
 *
 * Null when the period could not be parsed: "we do not know when" is a real
 * answer and the UI says it rather than picking one.
 */
export function executableAtIso(
  submitTime: string,
  minExecutionPeriod: string | null,
): string | null {
  const submitMs = Date.parse(submitTime);
  if (!Number.isFinite(submitMs)) return null;
  const seconds = parseDurationSeconds(minExecutionPeriod);
  if (seconds === null) return null;
  return new Date(submitMs + seconds * 1_000).toISOString();
}

/**
 * Can the connected session vote on this proposal right now?
 *
 * Voting is MEMBER-ONLY: x/group counts weighted member votes and rejects
 * anyone else, so offering the control to a non-member would be a control that
 * always fails. The reason is always stated — never a disabled control with no
 * explanation.
 */
export function voteAffordance(input: AffordanceInput): VoteAffordance {
  if (input.pruned) return { state: "hidden", reason: "pruned" };
  if (input.sessionAddress === null) return { state: "hidden", reason: "anonymous" };
  if (input.live === null) return { state: "hidden", reason: "live-unavailable" };
  if (input.live.status !== "submitted") return { state: "hidden", reason: "not-open" };
  // The voting period can close before the module tallies, so "still submitted"
  // is not the same as "still votable" — the chain would reject a late vote.
  const endMs = Date.parse(input.live.votingPeriodEnd);
  if (Number.isFinite(endMs) && input.nowMs >= endMs) {
    return { state: "hidden", reason: "voting-ended" };
  }
  // Voting is moot on a proposal whose electorate has changed: the group
  // version is snapshotted at submit and today's members were not its
  // electorate.
  if (input.membershipChanged) return { state: "hidden", reason: "membership-changed" };
  if (input.isMember === null) return { state: "hidden", reason: "membership-unknown" };
  if (!input.isMember) return { state: "hidden", reason: "not-member" };
  if (input.hasVoted) {
    return {
      state: "hidden",
      reason: "already-voted",
      ...(input.votedOption === null ? {} : { option: input.votedOption }),
    };
  }
  return { state: "offered" };
}

/**
 * Can the connected session execute this proposal right now?
 *
 * Execution is PERMISSIONLESS in x/group once a proposal has passed (§7 Q2,
 * confirmed 2026-07-30): any connected wallet is offered it, and the UI says
 * plainly that this is the module's rule rather than a permission we granted.
 * A connected wallet is still required — the transaction needs a signer.
 *
 * `membershipChanged` deliberately does NOT gate this. Execution acts on a
 * decision already taken; who governs today has no bearing on whether a passed
 * proposal may run, and hiding it would strand a passed proposal permanently
 * after any membership change.
 */
export function executeAffordance(input: AffordanceInput): ExecuteAffordance {
  if (input.pruned) return { state: "hidden", reason: "pruned" };
  if (input.sessionAddress === null) return { state: "hidden", reason: "anonymous" };
  if (input.live === null) return { state: "hidden", reason: "live-unavailable" };
  if (input.live.status === "submitted") return { state: "hidden", reason: "not-passed" };
  if (input.live.status !== "accepted") return { state: "hidden", reason: "terminal" };
  // A SUCCESSFUL execution prunes the proposal in its own transaction, so this
  // branch is mostly unreachable in practice — and it is written anyway, because
  // "unreachable in practice" is how a state nobody enumerated becomes a bug.
  if (input.live.executorResult === "success") {
    return { state: "hidden", reason: "already-executed" };
  }
  // FAILURE is terminal: x/group does not permit a second attempt.
  if (input.live.executorResult === "failure") {
    return { state: "hidden", reason: "execution-failed" };
  }
  const readyAtIso = executableAtIso(input.live.submitTime, input.minExecutionPeriod);
  if (readyAtIso !== null && input.nowMs < Date.parse(readyAtIso)) {
    return { state: "disabled", reason: "min-execution-pending", readyAtIso };
  }
  if (readyAtIso === null && input.minExecutionPeriod !== null) {
    // The policy declares a waiting period this build could not parse. Disabled
    // with an unknown eligible-at is honest; offering it would invite a
    // transaction the chain may reject with "must wait until …".
    return { state: "disabled", reason: "min-execution-pending", readyAtIso: null };
  }
  return { state: "offered" };
}
