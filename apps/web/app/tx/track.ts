// §10.2 step-5 tracking, client-side: poll inclusion
// through /tx/status, then fast-poll /tx/recent until the indexer's row
// lands and the optimistic pending row can drop. All polling goes through
// this server's routes — the browser talks to no chain endpoint.
//
// Honesty notes (SECURITY.md: never lie about state):
//   * `confirmed` is driven by CHAIN inclusion (the canonical plane); the
//     indexed row is history reconciliation, so a lagging indexer bounds
//     the reconcile wait rather than blocking the truthful confirmed state
//     — after RECONCILE_MAX_ATTEMPTS the row drops with the flow already
//     chain-confirmed, and the history view's own freshness labels carry
//     the lag story from there (§12.1).
//   * an on-chain execution failure dispatches INCLUDED with its code; the
//     reducer renders the failure — no retry loop, no fabricated success.

import type { TxEvent } from "./lifecycle";

export const INCLUSION_POLL_MS = 2_000;
export const INCLUSION_MAX_ATTEMPTS = 45; // ~90 s; devnet blocks are fast
export const RECONCILE_POLL_MS = 2_000;
export const RECONCILE_MAX_ATTEMPTS = 15; // ~30 s of indexer fast-poll

type Dispatch = (event: TxEvent) => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive pending → (reconciling → confirmed) | failed for a broadcast tx.
 * Injectable fetch for tests; resolves when tracking ends.
 */
export async function trackTransaction(
  txhash: string,
  dispatch: Dispatch,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // Phase 1: chain inclusion. A thrown fetch (transient network drop) counts
  // as a failed attempt and polling continues — tracking must never abort by
  // exception, or the flow strands in `pending` with no further events.
  let included: { height: string; code: number; raw_log: string } | null = null;
  for (let attempt = 0; attempt < INCLUSION_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetchImpl(`/tx/status?hash=${txhash}`);
      if (res.ok) {
        const body = (await res.json()) as
          | { included: false }
          | { included: true; height: string; code: number; raw_log: string };
        if (body.included) {
          included = body;
          break;
        }
      }
    } catch {
      // fall through to the sleep + next attempt
    }
    await sleep(INCLUSION_POLL_MS);
  }
  if (included === null) {
    // Not observed within the window: the tx may still land. Report the
    // truthful unknown as an execute-stage failure naming the hash — the
    // user can follow the explorer link; nothing claims success.
    dispatch({
      type: "INCLUDED",
      height: "0",
      code: -1,
      rawLog: "inclusion not observed within the polling window",
    });
    return;
  }
  dispatch({
    type: "INCLUDED",
    height: included.height,
    code: included.code,
    rawLog: included.raw_log,
  });
  if (included.code !== 0) return; // reducer is now in failed

  // Phase 2: indexer fast-poll reconcile (bounded; see honesty note above).
  for (let attempt = 0; attempt < RECONCILE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetchImpl("/tx/recent");
      if (res.ok) {
        const body = (await res.json()) as { available: boolean; txhashes: string[] };
        if (body.available && body.txhashes.includes(txhash)) break;
      }
    } catch {
      // transient — the reconcile wait is already bounded
    }
    await sleep(RECONCILE_POLL_MS);
  }
  dispatch({ type: "RECONCILED" });
}
