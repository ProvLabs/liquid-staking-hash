// Apply a collected window to the store. PURE over the abstract `GovernanceStore`
// (Postgres via store.ts, in-memory in the replay property test) and touching no
// network — the `write` half of the two-phase worker contract.
//
// ORDER MATTERS HERE, and it is the merge of three planes that the drill proved
// carry different, non-overlapping truths:
//
//   1. state-plane proposals  — authoritative status/tally for what the chain
//                               still holds, under the monotonic guard
//   2. submit provenance      — the only source of a proposal's txhash/height
//   3. exec results           — the ONLY record that an execution succeeded (the
//                               state plane cannot hold ACCEPTED+SUCCESS at all)
//   4. terminal states        — the status/tally the chain discarded with the row
//   5. prunes                 — stamped, never deleted
//   6. votes                  — tx plane for provenance, state plane for
//                               authority while a proposal is open; never deleted
//
// Steps 3–5 run AFTER step 1 on purpose: a proposal executed and pruned inside
// this same window is absent from the sweep, so its row has to exist (from the
// submit event or a previous window) before its outcome can land on it.

import { logger } from "../../logger.ts";
import type { GovernanceBatch } from "./sources.ts";
import type { GovernanceStore } from "./store.ts";

export async function applyBatch(store: GovernanceStore, batch: GovernanceBatch): Promise<void> {
  // 1. Authoritative observations for everything the chain still holds.
  for (const p of batch.proposals) {
    await store.upsertProposal({
      proposalId: p.proposalId,
      groupPolicyAddress: p.groupPolicyAddress,
      groupId: p.groupId,
      proposers: p.proposers,
      status: p.status,
      executorResult: p.executorResult,
      metadata: p.metadata === "" ? null : p.metadata,
      title: p.title,
      summary: p.summary,
      messages: p.messages,
      submitTime: p.submitTime,
      votingPeriodEnd: p.votingPeriodEnd,
      tally: p.tally,
      groupVersion: p.groupVersion,
      groupPolicyVersion: p.groupPolicyVersion,
      decisionPolicy: p.decisionPolicy,
      observedHeight: batch.observedHeight,
      observedAt: batch.observedAt,
    });
  }

  // 2. Submit provenance, set-once. A proposal seen only by the sweep keeps null
  //    height/txhash — honest, and what `indexed_from_height` exists to explain.
  for (const s of batch.submits) {
    await store.setSubmitProvenance(s.proposalId, s.txhash, s.height);
  }

  // 3. Execution outcomes. `NOT_RUN` is never written from here: it is the state
  //    plane's default, and writing it back would erase a real outcome.
  for (const e of batch.execResults) {
    if (e.result === "NOT_RUN" || e.result === "UNSPECIFIED") continue;
    await store.setExecutorResult(e.proposalId, e.result, e.height);
  }

  // 4. Withdrawals: a status transition, NOT a prune. The row survives on chain
  //    until the EndBlocker drops it, so the prune stamp waits for a signal that
  //    actually observes one.
  for (const w of batch.withdrawals) {
    await store.setTerminalState(w.proposalId, w.status, null, w.height);
  }

  // 5. Prunes. The event carries the terminal status and full tally, which is the
  //    only way a successfully-executed proposal's outcome is knowable at all.
  for (const p of batch.prunes) {
    if (p.status !== "UNSPECIFIED") {
      await store.setTerminalState(p.proposalId, p.status, p.tally, p.height);
    }
    await store.markPruned(p.proposalId, p.height);
  }

  // 6. The absence diff — prunes we never saw an event for (the EndBlocker's,
  //    on a build or a window where the event was missed).
  //
  //    GATED ON `sweepOk`, and that gate is the single most consequential line in
  //    this file. Absence is only evidence of a prune when the enumeration that
  //    produced it SUCCEEDED. A failed or truncated sweep produces the same empty
  //    id set as a genuinely empty policy, and acting on it would durably stamp
  //    `prunedAtHeight` on proposals the chain still holds — asserting "the chain
  //    discarded this" about live governance. That is invariant 4's disproof, and
  //    it is a live hazard rather than a hypothetical one: a missing proposal and
  //    an LCD outage are indistinguishable at the transport (both answer HTTP 500
  //    with the same body), so absence-from-an-authoritative-200 is the ONLY
  //    sound signal available.
  if (batch.sweepOk && batch.sweptPolicies.length > 0) {
    const present = new Set(batch.presentIds.map(String));
    const stored = await store.storedIdsForPolicies(batch.sweptPolicies);
    for (const id of stored) {
      if (present.has(String(id))) continue;
      await store.markPruned(id, batch.observedHeight);
      logger.info("proposal no longer held on chain: stamped pruned", {
        stream: "governance",
        height: batch.observedHeight,
      });
    }
  }

  // 7. Votes. The tx plane goes FIRST so its provenance is what lands in the row;
  //    the state plane then confirms option/weight for still-open proposals, and
  //    its COALESCEd nulls cannot erase a txhash. Votes are never deleted — the
  //    module deletes them at the tally, which is exactly why this table exists.
  for (const v of batch.txVotes) {
    await store.upsertVote({
      proposalId: v.proposalId,
      voter: v.voter,
      option: v.option,
      metadata: v.metadata === "" ? null : v.metadata,
      weight: null,
      submitTime: v.blockTime,
      height: v.height,
      txhash: v.txhash,
    });
  }
  for (const v of batch.stateVotes) {
    await store.upsertVote({
      proposalId: v.proposalId,
      voter: v.voter,
      option: v.option,
      metadata: v.metadata === "" ? null : v.metadata,
      weight: v.weight,
      submitTime: v.submitTime,
      height: null,
      txhash: null,
    });
  }
}
