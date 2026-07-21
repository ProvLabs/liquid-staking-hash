// The dual-source window reader (app-spec §9.2). For a height window it merges:
//   - tx-search (DeliverTx): swaps + expedite, filtered/decoded per event.
//   - block_results per height: EndBlocker payout/refund + the NAV marker,
//     which never appear in tx-search (fixture corpus pinned fact).
// It returns a single stream ordered by (height, then DeliverTx before
// EndBlocker, then emission order) so the reducer sees one causal order and the
// running NAV lands correctly.
//
// Correctness-first: EndBlocker events are found by scanning block_results for
// every height in the window. block_search-based height narrowing is a later
// optimization (noted in the M2.1 plan); functionally this is complete.

import { decodeBlockEvent, decodeTxEvent } from "./decode.ts";
import { NAV_EVENT, VAULT_EVENT, type DomainEvent, type EventScope } from "./events.ts";
import type { Window } from "../../runtime/checkpoint.ts";

const PER_PAGE = 100;

/** Event types that appear as EndBlocker events — the only reason to fetch a
 * block's time and decode its finalize events. Everything else (mint, liveness,
 * transfers) is skipped without a round-trip. */
const RELEVANT_BLOCK_TYPES = new Set<string>([
  VAULT_EVENT.swapOutCompleted,
  VAULT_EVENT.swapOutRefunded,
  NAV_EVENT,
]);

/** DeliverTx event types worth decoding — the only reason to fetch a tx's block
 * time. A tx with no event of these types is skipped without a round-trip, so
 * block-time fetches stay coupled to heights that actually produce events. */
const RELEVANT_TX_TYPES = new Set<string>([
  VAULT_EVENT.swapIn,
  VAULT_EVENT.swapOutRequested,
  VAULT_EVENT.expedited,
]);

/** The subset of RpcClient the collector needs (injectable for tests). */
export interface EventSource {
  txSearch(
    query: string,
    page?: number,
    perPage?: number,
  ): Promise<{ totalCount: number; txs: readonly { hash: string; height: bigint; events: readonly import("../../decode/attributes.ts").RawEvent[] }[] }>;
  blockResults(height: bigint | number): Promise<{
    finalizeBlockEvents: readonly import("../../decode/attributes.ts").RawEvent[];
  }>;
  blockTime(height: bigint | number): Promise<Date>;
}

interface Ranked {
  ev: DomainEvent;
  phase: 0 | 1; // 0 = DeliverTx, 1 = EndBlocker
  seq: number;
}

export async function collectWindow(
  rpc: EventSource,
  scope: EventScope,
  window: Window,
): Promise<DomainEvent[]> {
  const blockTimes = new Map<string, Date>();
  const timeOf = async (h: bigint): Promise<Date> => {
    const key = h.toString();
    let t = blockTimes.get(key);
    if (t === undefined) {
      t = await rpc.blockTime(h);
      blockTimes.set(key, t);
    }
    return t;
  };

  const ranked: Ranked[] = [];
  let seq = 0;

  // Phase 0 — tx-search across the window (swaps + expedite).
  let page = 1;
  for (;;) {
    const res = await rpc.txSearch(`tx.height>=${window.from} AND tx.height<=${window.to}`, page, PER_PAGE);
    for (const tx of res.txs) {
      // Cheap type pre-pass: skip txs with no candidate event BEFORE fetching
      // the block time, so a height of purely non-vault txs costs no round-trip.
      const candidates = tx.events.filter((e) => RELEVANT_TX_TYPES.has(e.type));
      if (candidates.length === 0) continue;
      const blockTime = await timeOf(tx.height);
      for (const raw of candidates) {
        const de = decodeTxEvent(raw, { height: tx.height, blockTime, txhash: tx.hash }, scope);
        if (de) ranked.push({ ev: de, phase: 0, seq: seq++ });
      }
    }
    if (res.txs.length === 0 || page * PER_PAGE >= res.totalCount) break;
    page++;
  }

  // Phase 1 — block_results per height (EndBlocker payout/refund/NAV).
  for (let h = window.from; h <= window.to; h++) {
    const block = await rpc.blockResults(h);
    const relevant = block.finalizeBlockEvents.filter((e) => RELEVANT_BLOCK_TYPES.has(e.type));
    if (relevant.length === 0) continue;
    const blockTime = await timeOf(h);
    for (const raw of relevant) {
      const de = decodeBlockEvent(raw, { height: h, blockTime }, scope);
      if (de) ranked.push({ ev: de, phase: 1, seq: seq++ });
    }
  }

  ranked.sort((a, b) => {
    if (a.ev.height !== b.ev.height) return a.ev.height < b.ev.height ? -1 : 1;
    if (a.phase !== b.phase) return a.phase - b.phase;
    return a.seq - b.seq;
  });
  return ranked.map((r) => r.ev);
}
