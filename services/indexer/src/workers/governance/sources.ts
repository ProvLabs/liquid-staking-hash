// The window collector: merges the tx, block and state planes into one batch.
//
// Runs entirely OUTSIDE any database transaction (the two-phase `Worker`
// contract) and touches no DB at all — including for the prune diff, which needs
// to know which proposal ids we already store. That diff is deliberately deferred
// to `write.ts`, where the transaction client is available, rather than smuggling
// a read in here.
//
// Plane responsibilities, all three grounded in the 2026-07-29 drill rather than
// in the plan's original guess (see events.ts for the full list):
//   - tx-search      : submit provenance, per-voter votes, exec results, prunes
//                      that happen inside a transaction (a successful exec)
//   - block_results  : prunes with NO transaction (the EndBlocker's)
//   - height-pinned  : authoritative status/tally, and the eventless
//                      voting-period-end transition

import { logger } from "../../logger.ts";
import type { Window } from "../../runtime/checkpoint.ts";
import type { RawEvent } from "../../decode/attributes.ts";
import {
  decodeExecEvent,
  decodeProposalPrunedEvent,
  decodeSubmitEvent,
  decodeTxVotes,
  decodeWithdrawEvent,
  hasGroupEvent,
} from "./decode.ts";
import { GROUP_BLOCK_EVENT_TYPES, GROUP_EVENT } from "./events.ts";
import { discoverGovernance, type PolicySource } from "./policies.ts";
import { sweepPolicies } from "./state.ts";
import type {
  ExecFact,
  ProposalSnapshot,
  PruneFact,
  SubmitFact,
  TxVoteFact,
  VoteSnapshot,
} from "./events.ts";

const PER_PAGE = 100;

/** The tx/block transport surface (injectable for tests). */
export interface GovEventSource {
  txSearch(
    query: string,
    page?: number,
    perPage?: number,
  ): Promise<{
    totalCount: number;
    txs: readonly { hash: string; height: bigint; events: readonly RawEvent[] }[];
  }>;
  blockResults(height: bigint | number): Promise<{ finalizeBlockEvents: readonly RawEvent[] }>;
  blockTime(height: bigint | number): Promise<Date>;
  /** The tx BODY's message array — the only source of a vote's voter and option,
   * since `EventVote` carries neither. */
  txMessages(txhash: string): Promise<readonly unknown[]>;
}

export interface GovernanceBatch {
  /** The AS-OF of every state-plane fact in this batch, and the monotonicity key. */
  readonly observedHeight: bigint;
  readonly observedAt: Date;
  readonly policies: string[];
  readonly proposals: ProposalSnapshot[];
  readonly stateVotes: VoteSnapshot[];
  readonly submits: SubmitFact[];
  readonly txVotes: TxVoteFact[];
  readonly execResults: ExecFact[];
  readonly prunes: PruneFact[];
  readonly withdrawals: PruneFact[];
  /** Ids the successful sweep enumerated — the writer diffs stored rows against
   * this to find prunes it never saw an event for. */
  readonly presentIds: bigint[];
  /** Only when true may the writer conclude that an absent id was pruned. */
  readonly sweepOk: boolean;
  readonly sweptPolicies: string[];
}

const EMPTY_BATCH = (observedHeight: bigint, observedAt: Date): GovernanceBatch => ({
  observedHeight,
  observedAt,
  policies: [],
  proposals: [],
  stateVotes: [],
  submits: [],
  txVotes: [],
  execResults: [],
  prunes: [],
  withdrawals: [],
  presentIds: [],
  // No policies means nothing was swept, so nothing may be concluded absent.
  // This is the honest no-governance state (a plain-account `Config.admin`), and
  // it must not read as "every proposal you know about is gone".
  sweepOk: false,
  sweptPolicies: [],
});

export async function collectWindow(
  rpc: GovEventSource,
  source: PolicySource,
  contractAddress: string,
  window: Window,
  overridePolicies: readonly string[] = [],
): Promise<GovernanceBatch> {
  const observedAt = await rpc.blockTime(window.to);

  // 1. Who governs, as of the window's end. Re-resolved every window: a new
  //    policy on the group must start being mirrored without a restart.
  const { policies, memberWeights } = await discoverGovernance(
    source,
    contractAddress,
    window.to,
    overridePolicies,
  );
  if (policies.length === 0) return EMPTY_BATCH(window.to, observedAt);

  const submits: SubmitFact[] = [];
  const txVotes: TxVoteFact[] = [];
  const execResults: ExecFact[] = [];
  const prunes: PruneFact[] = [];
  const withdrawals: PruneFact[] = [];

  // 2. Tx plane. Paged to exhaustion over the height range.
  let page = 1;
  for (;;) {
    const res = await rpc.txSearch(
      `tx.height>=${window.from} AND tx.height<=${window.to}`,
      page,
      PER_PAGE,
    );
    for (const tx of res.txs) {
      if (!hasGroupEvent(tx.events)) continue;

      for (const event of tx.events) {
        switch (event.type) {
          case GROUP_EVENT.submitProposal:
            submits.push(decodeSubmitEvent(event, tx.hash, tx.height));
            break;
          case GROUP_EVENT.exec:
            execResults.push(decodeExecEvent(event, tx.height));
            break;
          case GROUP_EVENT.proposalPruned:
            // A prune inside a TRANSACTION: this is the successful-exec case, and
            // the event is the only carrier of the terminal status and tally.
            prunes.push(decodeProposalPrunedEvent(event, tx.height));
            break;
          case GROUP_EVENT.withdrawProposal:
            withdrawals.push(decodeWithdrawEvent(event, tx.height));
            break;
          default:
            break;
        }
      }

      // Votes need the message BODY, so the body is fetched only for txs that
      // actually carry a vote event.
      if (tx.events.some((e) => e.type === GROUP_EVENT.vote)) {
        const blockTime = await rpc.blockTime(tx.height);
        const messages = await rpc.txMessages(tx.hash);
        const decoded = decodeTxVotes(tx.events, messages, {
          txhash: tx.hash,
          height: tx.height,
          blockTime,
        });
        txVotes.push(...decoded.votes);
        for (const skipped of decoded.undecodable) {
          // Skipped, never guessed, and always visible: a fabricated voter would
          // be a lie about who voted, and a silent drop would make the omission
          // indistinguishable from nobody having voted.
          logger.warn("governance vote skipped: no decodable MsgVote body", {
            stream: "governance",
            txhash: tx.hash,
            msgIndex: skipped.msgIndex,
            height: tx.height,
            error: skipped.reason,
          });
        }
      }
    }
    if (res.txs.length === 0 || page * PER_PAGE >= res.totalCount) break;
    page++;
  }

  // 3. Block plane — EndBlocker prunes, which have no transaction. Skipped
  //    entirely when the observed event set is empty, so a build that emits
  //    nothing here costs no per-height round-trip.
  if (GROUP_BLOCK_EVENT_TYPES.length > 0) {
    for (let h = window.from; h <= window.to; h++) {
      const block = await rpc.blockResults(h);
      for (const event of block.finalizeBlockEvents) {
        if (!GROUP_BLOCK_EVENT_TYPES.includes(event.type)) continue;
        if (event.type === GROUP_EVENT.proposalPruned) {
          prunes.push(decodeProposalPrunedEvent(event, h));
        }
      }
    }
  }

  // 4. State plane — authority, and the only observer of the eventless
  //    voting-period-end transition.
  const sweep = await sweepPolicies(source, policies, memberWeights, window.to);

  return {
    observedHeight: window.to,
    observedAt,
    policies: policies.map((p) => p.address),
    proposals: sweep.proposals,
    stateVotes: sweep.votes,
    submits,
    txVotes,
    execResults,
    prunes,
    withdrawals,
    presentIds: sweep.proposals.map((p) => p.proposalId),
    sweepOk: sweep.sweepOk,
    sweptPolicies: sweep.sweptPolicies,
  };
}
