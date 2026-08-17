import type {
  Bounded,
  GroupInfo,
  GroupMember,
  GroupPolicyInfo,
  GroupProposal,
  GroupVote,
  TallyCounts,
} from "@/lib/types";

export type GovTopology =
  | {
      state: "governed";
      groupId: string;
      group: GroupInfo | null;
      policies: Bounded<GroupPolicyInfo>;
      members: Bounded<GroupMember>;
    }
  | { state: "no-group" };

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
