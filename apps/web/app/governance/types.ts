// Governance-center view models (`/governance`, app-spec §8.7; assembled by
// governance.server.ts, consumed by the client components). Same split as
// portfolio/operator: no Prisma, no `@nvhash/api-types` row types and no
// chain-client types leak into a component — every figure below is either a
// display string prepared server-side or a closed union a component switches on.
//
// Three honesty rules shape these shapes (§12.1, SECURITY.md "never lie about
// state"):
//
//   1. Every proposal carries its PLANE — which read the status and tally came
//      from — so a component can never render an indexed figure as current.
//      `plane` is not derivable from the other fields, which is why it is one.
//   2. A decoded message is either a summary from a CLOSED union or a tagged
//      `unknown`; there is no third, heuristic case, and the exact JSON rides
//      with both.
//   3. "n/a" is a value. `meetsThreshold` is `boolean | null` end to end and
//      the null never collapses to false on the way to the page.

import type {
  FreshnessMeta,
  GovExecutorResult,
  GovProposalStatus,
  GovVoteOption,
} from "@nvhash/api-types";

import type { LiveProposalState } from "./actions";
import type { DecodedMessage } from "./decode";

/**
 * Which plane produced this proposal's `status` and `tally`.
 *
 * - `live` — an OPEN proposal read from the chain. Canonical (§12.1.1).
 * - `indexed-fallback` — an OPEN proposal whose live read failed. The figures
 *   are the mirror's, AS OF `observedHeight`, and the page says so. Never
 *   blank, never presented as current.
 * - `indexed` — a CLOSED proposal. The mirror IS the record: x/group prunes,
 *   and a successful exec prunes in its own transaction (7.1 finding 1).
 * - `pruned` — the chain no longer holds this proposal at all.
 * - `live-only` — on chain now, not in the mirror yet (submitted since the last
 *   indexer window). There is no `observedHeight` to show.
 */
export type ProposalPlane = "live" | "indexed-fallback" | "indexed" | "pruned" | "live-only";

/** Whether the live x/group plane could be resolved at all (§3.4 R2). */
export type LivePlaneState =
  | "governed"
  /** `Config.admin` is not a group-policy account: this deployment has no group. */
  | "not-governed"
  /** A chain read failed. NOT the same claim as `not-governed`. */
  | "unavailable";

/** Presentation of a tally against its decision rule. Never a bare boolean.
 *
 * Every count is NULLABLE and renders "n/a". A proposal on chain right now whose
 * tally read failed, with no mirrored row to fall back to, has an UNKNOWN tally —
 * and `0` there would read as "nobody supports this", which is a different claim
 * and a consequential one on the page where votes are cast. */
export interface TallyVM {
  /** The four counts, verbatim decimal strings (unbounded member weights). */
  yes: string | null;
  no: string | null;
  abstain: string | null;
  noWithVeto: string | null;
  /** Sum across all four, or null when a count was unreadable. */
  totalVoted: string | null;
  /** The rule in force for THIS proposal (snapshot at submit for a closed one). */
  rule: "threshold" | "percentage" | "unknown";
  /** The rule's own figure as a display string — a weight, or a percent. */
  ruleValue: string | null;
  /** Electorate weight, live plane only; null makes a percentage rule "n/a". */
  totalWeight: string | null;
  /** `meetsThreshold` verbatim: null = undecidable, and it renders "n/a". */
  meets: boolean | null;
  /** Participation as a percent display string, or null. Never an input to passage. */
  participationPercent: string | null;
}

/** One recorded vote, from the mirror or (for an open proposal) from chain. */
export interface VoteVM {
  voter: string;
  option: GovVoteOption;
  /** Null when it could not be recovered — x/group's `Vote` has no weight field. */
  weight: string | null;
  submitTime: string;
  height: number | null;
  txhash: string | null;
  /** True when the mirror has no row for this voter yet (live-only vote). */
  liveOnly: boolean;
}

/** One row of the per-member status table (§8.7 "who, how, when"). */
export interface MemberStatusVM {
  address: string;
  weight: string;
  /** Null = has not voted. */
  vote: VoteVM | null;
  /** True when this is the connected session's address (highlight, never a gate). */
  isSession: boolean;
}

/** The per-member section, or the honest reason there isn't one. */
export type MemberStatus =
  | { kind: "members"; rows: MemberStatusVM[] }
  /** Closed proposal whose electorate has since changed (§2.3): votes only. */
  | { kind: "membership-changed"; proposalGroupVersion: string; currentGroupVersion: string }
  /** The live member read did not happen or failed: votes only, and say so. */
  | { kind: "not-checked" };

/** A proposal as the list renders it. */
export interface ProposalSummaryVM {
  proposalId: string;
  title: string;
  policyAddress: string;
  proposers: string[];
  proposersTruncated: boolean;
  status: GovProposalStatus;
  executorResult: GovExecutorResult;
  plane: ProposalPlane;
  /** AS-OF of an indexed figure. Null on the live and live-only planes. */
  observedHeight: number | null;
  observedAt: string | null;
  submitTime: string;
  votingPeriodEnd: string;
  /** Server-computed, APPROXIMATE seconds until expiry; null once elapsed or
   * for anything not open. The absolute `votingPeriodEnd` is the primary fact. */
  votingEndsInSeconds: number | null;
  tally: TallyVM;
  pruned: boolean;
  /** True when the proposal's group version is behind the live group version. */
  membershipChanged: boolean;
  messageCount: number;
  messagesTruncated: boolean;
}

/** A proposal as the detail route renders it: the summary plus everything else. */
export interface ProposalDetailVM extends ProposalSummaryVM {
  summary: string;
  metadata: string | null;
  groupId: string;
  groupVersion: string;
  groupPolicyVersion: string;
  height: number | null;
  txhash: string | null;
  /** Decoded messages, in order. The exact JSON rides on every one of them. */
  messages: DecodedMessage[];
  votes: VoteVM[];
  votesTruncated: boolean;
  memberStatus: MemberStatus;
  /** The rule's windows, from the proposal's own snapshot (never the live policy). */
  votingPeriod: string | null;
  minExecutionPeriod: string | null;
  /**
   * The LIVE plane's own view of this proposal, when a live read succeeded.
   *
   * SEPARATE FROM `plane` on purpose. `plane` answers "where
   * did the figures on this page come from", and for a CLOSED proposal the
   * honest answer is the mirror — x/group prunes, so the mirror is the record.
   * This answers a different question: "did the chain, just now, confirm this
   * proposal is in the state we are about to offer an action against". Only
   * this one may decide an affordance. Deriving affordances from `plane` would
   * either hide execute on every accepted proposal (its plane is `indexed`) or
   * offer it from a stale row — the two failure modes C5 exists to separate.
   */
  liveState: LiveProposalState | null;
  /** True when the session address is in the LIVE member set; null = not read. */
  sessionIsMember: boolean | null;
  /** The session's recorded vote on this proposal, if any. */
  sessionVote: VoteVM | null;
}

/** One group policy the program's governance runs through. */
export interface PolicyVM {
  address: string;
  groupId: string;
  /** Live metadata label (e.g. `nvhash-program-admin`), or null when not live. */
  metadata: string | null;
  /** Proposals the MIRROR holds for this policy; null when not in the mirror. */
  proposalCount: number | null;
  lastSeenHeight: number | null;
  rule: "threshold" | "percentage" | "unknown" | null;
  ruleValue: string | null;
  votingPeriod: string | null;
  /** True when the live policy set carries it; false = historical only. */
  live: boolean;
}

/** The live group behind the program, when one could be resolved. */
export interface LiveGroupVM {
  groupId: string;
  version: string;
  totalWeight: string;
  memberCount: number;
}

export interface GovernanceListData {
  state: LivePlaneState;
  policies: PolicyVM[];
  group: LiveGroupVM | null;
  proposals: ProposalSummaryVM[];
  /** First height the governance stream ingested; null when none certifies it. */
  indexedFromHeight: number | null;
  /** False when the mirror read failed — the list is then empty for a REASON. */
  indexedAvailable: boolean;
  /** True when the page cap bounded the list. */
  truncated: boolean;
  /** The active `?status=` filter, or null for "all". */
  statusFilter: GovProposalStatus | null;
  page: number;
  hasMore: boolean;
  freshness: FreshnessMeta | null;
}

export interface GovernanceDetailData {
  state: LivePlaneState;
  proposal: ProposalDetailVM;
  policy: PolicyVM | null;
  group: LiveGroupVM | null;
  freshness: FreshnessMeta | null;
}
