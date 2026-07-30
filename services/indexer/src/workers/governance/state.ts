// The state plane: height-pinned, paginated reads of what the chain STILL HOLDS.
//
// This is the authority for the status and tally of every live proposal, and the
// ONLY observer of the voting-period-end transition — which is eventless on this
// build (no tally event in `finalize_block_events`), so a sweep at height H
// returning REJECTED where the previous sweep returned SUBMITTED is the sole
// evidence that the transition happened.
//
// It is ALSO the only authoritative statement of what is gone. That is why the
// sweep's success is tracked explicitly and threaded to the writer: absence from
// a SUCCESSFUL sweep is the prune signal, and absence because the read failed
// must write nothing at all.
//
// What this plane can NEVER see (both measured 2026-07-29):
//   - `ACCEPTED` + `SUCCESS` — a successful execution prunes the proposal in its
//     own transaction, so the happy path leaves no state behind;
//   - the votes of any CLOSED proposal — the module deletes them at the tally.
// Those come from the tx plane, and the writer merges the two.

import { logger } from "../../logger.ts";
import { decodeProposal, decodeVote } from "./decode.ts";
import { paginate, type PolicyInfo, type PolicySource } from "./policies.ts";
import type { ProposalSnapshot, VoteSnapshot } from "./events.ts";

/** A proposal's status is non-terminal — i.e. its votes are still on chain and
 * worth reading. Anything else has had its votes deleted by the tally, so a vote
 * read would return an empty list that must never overwrite recorded history. */
function isOpen(status: string): boolean {
  return status === "SUBMITTED";
}

export interface SweepResult {
  /** Proposals the chain holds at the pinned height, across every policy. */
  readonly proposals: ProposalSnapshot[];
  /** Authoritative votes, for OPEN proposals only. */
  readonly votes: VoteSnapshot[];
  /**
   * Did EVERY policy's proposal read succeed? Only then is the proposal id set
   * complete, and only then may the writer conclude that a known id which is
   * absent has been pruned. One failed policy read poisons the whole conclusion,
   * so this is a single flag rather than per-policy — a partial sweep is not a
   * weaker prune signal, it is no prune signal at all.
   */
  readonly sweepOk: boolean;
  /** Policies whose sweep succeeded — the scope the absence diff may consider. */
  readonly sweptPolicies: string[];
}

/**
 * Sweep every discovered policy at `height`.
 *
 * A read failure on one policy is logged and clears `sweepOk`; it does NOT throw,
 * because the proposals we did read are still true facts worth committing, and
 * their `observedHeight` stamps them honestly. What must not happen is the
 * absence conclusion being drawn from an incomplete picture, and clearing the
 * flag is what prevents it.
 */
export async function sweepPolicies(
  source: PolicySource,
  policies: readonly PolicyInfo[],
  memberWeights: Map<string, Map<string, string>>,
  height: bigint,
): Promise<SweepResult> {
  const proposals: ProposalSnapshot[] = [];
  const votes: VoteSnapshot[] = [];
  const sweptPolicies: string[] = [];
  let sweepOk = true;

  for (const policy of policies) {
    let rows: unknown[];
    try {
      rows = await paginate(
        source,
        `cosmos/group/v1/proposals_by_group_policy/${encodeURIComponent(policy.address)}`,
        "proposals",
        height,
      );
    } catch (cause) {
      // Includes the pagination-cap throw: a truncated sweep is exactly the
      // thing that must not be mistaken for a complete one.
      sweepOk = false;
      logger.warn("governance sweep failed for a policy; prune detection is suspended this window", {
        stream: "governance",
        height,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      continue;
    }
    sweptPolicies.push(policy.address);

    const weights = memberWeights.get(policy.groupId.toString()) ?? new Map<string, string>();

    for (const [i, raw] of rows.entries()) {
      let snapshot: ProposalSnapshot;
      try {
        snapshot = decodeProposal(
          raw,
          { groupId: policy.groupId, decisionPolicy: policy.decisionPolicy },
          `$.proposals[${i}]`,
        );
      } catch (cause) {
        // Per-element quarantine (invariant 8's disproof): one undecodable
        // proposal must not drop its siblings, and it must not clear `sweepOk`
        // either — we DID read the chain successfully, so the id is present and
        // must not be treated as pruned. Skipping it leaves the stored row at its
        // previous observation, which is honest.
        logger.warn("undecodable governance proposal skipped", {
          stream: "governance",
          height,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        continue;
      }
      proposals.push(snapshot);

      if (!isOpen(snapshot.status)) continue;
      try {
        const voteRows = await paginate(
          source,
          `cosmos/group/v1/votes_by_proposal/${snapshot.proposalId.toString()}`,
          "votes",
          height,
        );
        for (const [j, rawVote] of voteRows.entries()) {
          const vote = decodeVote(rawVote, null, `$.votes[${j}]`);
          votes.push({ ...vote, weight: weights.get(vote.voter) ?? null });
        }
      } catch (cause) {
        // A failed vote read costs provenance, not correctness: recorded votes
        // are never deleted, and the tx plane carries the durable record anyway.
        logger.warn("governance vote read failed", {
          stream: "governance",
          height,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  return { proposals, votes, sweepOk, sweptPolicies };
}
