// The chain-events worker (app-spec §9.2, master plan PR 2.1): vault/contract
// event ingestion into `transactions` and `redemption_requests`. Two-phase per
// the runtime contract — `collect` reads+decodes the window from chain (no DB),
// `write` applies the reducer to the `indexed` schema on the window's
// transaction (no network). Replay from height 0 or any restart converges to
// byte-identical derived state (proven by test/workers/chain-events-replay).

import { STREAMS } from "../../runtime/streams.ts";
import type { Worker } from "../../runtime/worker.ts";
import type { RpcClient } from "../../transport/rpc.ts";
import { applyEvents } from "./reduce.ts";
import { collectWindow } from "./sources.ts";
import { PrismaStore } from "./store.ts";
import type { DomainEvent, EventScope } from "./events.ts";

export interface ChainEventsDeps {
  readonly rpc: RpcClient;
  readonly scope: EventScope;
  /** backfill start (vault deploy height). Defaults to genesis (PR 2.2 refines
   * instantiation-height discovery). */
  readonly startHeight?: bigint;
}

export function createChainEventsWorker(deps: ChainEventsDeps): Worker<DomainEvent[]> {
  return {
    stream: STREAMS.chainEvents,
    startHeight: deps.startHeight ?? 0n,
    collect: (window) => collectWindow(deps.rpc, deps.scope, window),
    write: (tx, _window, batch) => applyEvents(new PrismaStore(tx), batch),
  };
}
