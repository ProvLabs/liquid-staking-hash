// The governance worker (app-spec §9.1/§9.2) →
// `gov_proposals` + `gov_votes`.
//
// Structurally a sibling of chain-events (tx + block planes) crossed with
// validator-sampler (height-pinned state sweep), because x/group needs both:
// the tx plane carries provenance and the outcomes the chain throws away, and the
// state sweep is the only observer of the voting-period-end transition, which is
// eventless on this build.
//
// Two-phase per the runtime contract: `collect` reads and decodes the window from
// chain with NO database access, `write` applies the batch on the window's
// transaction with NO network. Replay from height 0 or from any restart point
// converges, because the proposal upsert's monotonic `observedHeight` guard is a
// property of the SQL statement rather than of stream scheduling.
//
// The relay is untouched by this PR. Nothing here signs anything and no signing
// path exists; `apps/web`'s `ALLOWED_MSG_TYPE_URLS` is unchanged and a governance
// message is still provably rejected.

import { STREAMS } from "../../runtime/streams.ts";
import type { Worker } from "../../runtime/worker.ts";
import type { PinnedLcdClient, RpcClient } from "../../transport/rpc.ts";
import { collectWindow, type GovEventSource, type GovernanceBatch } from "./sources.ts";
import type { PolicySource } from "./policies.ts";
import { PrismaGovernanceStore } from "./store.ts";
import { applyBatch } from "./write.ts";

export interface GovernanceDeps {
  readonly rpc: RpcClient;
  readonly pinned: PinnedLcdClient;
  readonly contractAddress: string;
  /** LCD base, for the tx-body read `RpcClient` does not cover. */
  readonly lcdUrl: string;
  /**
   * Explicit policy addresses to index in ADDITION to whatever discovery finds.
   * The real case is a chain whose contract was deployed before the group
   * existed: there is no admin-rotation message, so discovery correctly finds
   * nothing and an operator must name the policies. A configuration escape hatch,
   * never a substitute for discovery.
   */
  readonly overridePolicies?: readonly string[];
  readonly startHeight?: bigint;
}

/**
 * Fetch a transaction's message array from the LCD. `EventVote` carries neither
 * the voter nor the option, so the body is the only source of both — and this is
 * the one read the shared `RpcClient` does not already provide.
 */
async function fetchTxMessages(lcdUrl: string, txhash: string): Promise<readonly unknown[]> {
  const base = lcdUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/cosmos/tx/v1beta1/txs/${encodeURIComponent(txhash)}`);
  if (!res.ok) throw new Error(`LCD tx fetch failed for ${txhash}: ${res.status}`);
  const body = (await res.json()) as { tx?: { body?: { messages?: unknown[] } } };
  return body.tx?.body?.messages ?? [];
}

export function createGovernanceWorker(deps: GovernanceDeps): Worker<GovernanceBatch> {
  const events: GovEventSource = {
    txSearch: (query, page, perPage) => deps.rpc.txSearch(query, page, perPage),
    blockResults: (height) => deps.rpc.blockResults(height),
    blockTime: (height) => deps.rpc.blockTime(height),
    txMessages: (txhash) => fetchTxMessages(deps.lcdUrl, txhash),
  };

  const state: PolicySource = {
    smartAtHeight: (contract, query, height) => deps.pinned.smartAtHeight(contract, query, height),
    getAtHeight: (path, params, height) => deps.pinned.getAtHeight(path, params, height),
  };

  return {
    stream: STREAMS.governance,
    // D13: start at 1 like the other streams, with `indexed_from_height` surfaced
    // on the list payload so a page never implies completeness it lacks. Height 0
    // does not exist on CometBFT; the runtime floors it anyway.
    startHeight: deps.startHeight ?? 1n,
    collect: (window) =>
      collectWindow(events, state, deps.contractAddress, window, deps.overridePolicies ?? []),
    write: (tx, _window, batch) => applyBatch(new PrismaGovernanceStore(tx), batch),
  };
}
