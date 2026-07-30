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
import { recoverAbsentProposals, sweepPolicies } from "./state.ts";
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
  /**
   * Proposals the tx/block plane proved existed but the ending sweep cannot
   * return, because their whole lifecycle fell inside this window. Carried
   * SEPARATELY from `proposals` because each has its own AS-OF: the height it was
   * recovered at, not `observedHeight` — at `observedHeight` the chain no longer
   * holds it, and stamping it with the window's end would assert otherwise.
   */
  readonly recoveredProposals: { snapshot: ProposalSnapshot; observedHeight: bigint }[];
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
  recoveredProposals: [],
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

  // 5. Recovery pass. Anything the events proved existed but the sweep cannot
  //    return was submitted AND pruned inside this window — the normal outcome for
  //    a promptly executed proposal, since a successful exec prunes in its own
  //    transaction. Without this the row is never created and every event-derived
  // UPDATE below silently affects nothing.
  const present = new Set(sweep.proposals.map((p) => p.proposalId.toString()));

  // Which height to pin is the whole correctness of this pass, and the two signals
  // are NOT interchangeable:
  //   - a SUBMIT height is a height the proposal existed at (it was created there);
  //   - a terminal height is one where it is already GONE, since a prune lands in
  //     the same block as the transaction that caused it — so the block BEFORE it
  //     is the last one that still had it.
  // Taking a naive minimum across both mixes the two and can pin BEFORE the
  // proposal existed, which reads as not-found and loses the row for the wrong
  // reason. So they are tracked separately.
  const submitHeight = new Map<string, bigint>();
  const terminalHeight = new Map<string, bigint>();
  const noteEarliest = (m: Map<string, bigint>, id: bigint, height: bigint): void => {
    const key = id.toString();
    const prev = m.get(key);
    if (prev === undefined || height < prev) m.set(key, height);
  };
  for (const s of submits) noteEarliest(submitHeight, s.proposalId, s.height);
  for (const e of execResults) noteEarliest(terminalHeight, e.proposalId, e.height);
  for (const p of prunes) noteEarliest(terminalHeight, p.proposalId, p.height);
  for (const w of withdrawals) noteEarliest(terminalHeight, w.proposalId, w.height);

  const absent: { proposalId: bigint; pinHeight: bigint }[] = [];
  for (const key of new Set([...submitHeight.keys(), ...terminalHeight.keys()])) {
    if (present.has(key)) continue;
    const submitted = submitHeight.get(key);
    const terminal = terminalHeight.get(key);

    if (submitted !== undefined) {
      // Submitted AND finished in the same BLOCK — reachable with
      // `MsgSubmitProposal.exec = EXEC_TRY` when the proposers alone meet the
      // threshold. No height has this proposal alive, so a pinned read cannot
      // recover it; the tx BODY could, and doing so is a recorded follow-on rather
      // than a silent gap.
      if (terminal !== undefined && terminal <= submitted) {
        logger.warn("governance proposal submitted and finished in one block: not recoverable by a pinned read", {
          stream: "governance",
          height: submitted,
          error: `proposal ${key} has no height at which it was alive`,
        });
        continue;
      }
      absent.push({ proposalId: BigInt(key), pinHeight: submitted });
      continue;
    }
    // No submit in this window: the proposal came from an earlier one, so the row
    // should already exist and this read is a repair rather than the primary path.
    if (terminal !== undefined && terminal > 0n) {
      absent.push({ proposalId: BigInt(key), pinHeight: terminal - 1n });
    }
  }

  const recoveredProposals = await recoverAbsentProposals(source, policies, absent);

  return {
    observedHeight: window.to,
    observedAt,
    policies: policies.map((p) => p.address),
    proposals: sweep.proposals,
    recoveredProposals,
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
