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

import { dequote, type RawEvent } from "../../decode/attributes.ts";
import { logger } from "../../logger.ts";
import { decodeBlockEvent, decodeTxEvent, decodeTxPayments } from "./decode.ts";
import {
  NAV_EVENT,
  PAYMENT_ACTION,
  VAULT_EVENT,
  WASM_EVENT,
  type DomainEvent,
  type EventScope,
} from "./events.ts";
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

const PAYMENT_ACTIONS = new Set<string>([PAYMENT_ACTION.commission, PAYMENT_ACTION.tip]);

/** Does this tx carry an operator payment for us? `wasm` is every contract's
 * event type, so the pre-pass matches on the contract's own `action` values —
 * scoping to OUR contract is `decodeTxPayments`' job, on the same pass that
 * pairs the event with its funds transfer. */
function hasPaymentEvent(events: readonly RawEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === WASM_EVENT &&
      e.attributes.some((a) => a.key === "action" && PAYMENT_ACTIONS.has(dequote(a.value))),
  );
}

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
      const payments = hasPaymentEvent(tx.events);
      if (candidates.length === 0 && !payments) continue;
      const blockTime = await timeOf(tx.height);
      const ctx = { height: tx.height, blockTime, txhash: tx.hash };
      for (const raw of candidates) {
        const de = decodeTxEvent(raw, ctx, scope);
        if (de) ranked.push({ ev: de, phase: 0, seq: seq++ });
      }
      // Operator payments decode from the WHOLE tx: the amount rides the funds
      // transfer, not the contract's own event (M6.4 §2.1).
      if (payments) {
        const decoded = decodeTxPayments(tx.events, ctx, scope);
        for (const de of decoded.payments) {
          ranked.push({ ev: de, phase: 0, seq: seq++ });
        }
        // A payment whose funds could not be paired unambiguously is SKIPPED,
        // not stored as a guess and not allowed to abort the window (2026-07-28
        // review: an aborted window re-collects forever and stalls the whole
        // stream). Skipping is only acceptable because it is observable, so it
        // is logged per occurrence — public chain identifiers only, all
        // `SAFE_FIELDS`. Idempotent re-ingest means a later decoder recovers
        // the row on replay.
        for (const skipped of decoded.undecodable) {
          logger.warn("operator payment skipped: ambiguous funds transfer", {
            stream: "chain-events",
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
