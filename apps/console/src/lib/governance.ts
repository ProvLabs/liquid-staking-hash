// Pure governance derivations for the /governance panel (spec §8.0; PR 8.4b
// §2.2). Every honesty rule the panel renders is decided HERE, over already-
// fetched inputs, so the §4b C4 matrix is gated by pure tests
// (test/governance-state.test.ts) rather than by reading the JSX.
import type {
  Bounded,
  GroupInfo,
  GroupMember,
  GroupPolicyInfo,
  GroupProposal,
  GroupVote,
  TallyCounts,
} from "@/lib/types";

/**
 * The panel header's three states — never conflated (chain-facts §x/group 8):
 * a 404 on `group_policy_info(Config.admin)` is the PLAIN-ACCOUNT FACT ("no
 * group behind this deployment", a valid state); every other failure is
 * "could not check", which asserts nothing about the topology.
 */
export type GovTopology =
  | {
      state: "governed";
      groupId: string;
      group: GroupInfo | null;
      policies: Bounded<GroupPolicyInfo>;
      members: Bounded<GroupMember>;
    }
  | { state: "no-group" };

/**
 * A proposal row's tally cell. The rule that cannot be broken silently
 * (chain-facts §x/group 7): an OPEN proposal's `final_tally_result` is zeros
 * until the module tallies, so rendering it would assert "nobody voted" —
 * the live figure comes only from the Tally query. A CLOSED proposal's
 * final tally is the module's own recorded outcome and is honest to show.
 */
export type TallyCell =
  | { state: "live"; tally: TallyCounts }
  | { state: "final"; tally: TallyCounts }
  | { state: "unavailable"; reason: string };

export function tallyCellFor(
  proposal: Pick<GroupProposal, "status" | "final_tally_result">,
  liveTally: TallyCounts | null,
  liveTallyError: string | null,
): TallyCell {
  if (proposal.status !== "PROPOSAL_STATUS_SUBMITTED") {
    return { state: "final", tally: proposal.final_tally_result };
  }
  if (liveTally !== null) return { state: "live", tally: liveTally };
  return {
    state: "unavailable",
    reason: liveTallyError ?? "tally not read",
  };
}

/** Yes-weight vs the policy threshold, both as decimal strings; null when the
 *  policy's decision rule carries no readable threshold (rendered as such,
 *  never as 0 — an unmodeled rule is unknown, not failing). */
export function thresholdProgress(
  tally: TallyCounts,
  policy: GroupPolicyInfo | undefined,
): { yes: string; threshold: string } | null {
  const threshold = policy?.decision_policy?.threshold;
  if (typeof threshold !== "string" || !/^\d+$/.test(threshold)) return null;
  return { yes: tally.yes_count, threshold };
}

/** Seconds until an RFC3339 instant, negative when past; null when unparseable. */
export function secondsUntil(instant: string, nowSecs: number): number | null {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000) - nowSecs;
}

/** The standing panel caveat (§2.2.5): the live plane structurally cannot
 *  show outcome history — this is §17 honesty applied to absence. */
export const PRUNING_CAVEAT =
  "x/group prunes a proposal the moment it executes successfully and deletes " +
  "votes at voting-period end, so this panel structurally cannot show outcome " +
  "history. The App's governance center is the durable record.";

/** One proposal row as the panel consumes it: the raw proposal (raw-JSON
 *  disclosure per §9.6), its live-tally read (SUBMITTED only), and its votes
 *  (recoverable only while SUBMITTED — chain-facts §x/group 2). */
export interface GovProposalRow {
  proposal: GroupProposal;
  policyAddress: string;
  liveTally: TallyCounts | null;
  liveTallyError: string | null;
  votes: Bounded<GroupVote> | null;
}

export interface GovProposals {
  rows: GovProposalRow[];
  /** True when ANY policy's sweep hit its page cap — rendered as a
   *  "truncated at N" label, never a silent drop or a prune inference. */
  truncated: boolean;
}
