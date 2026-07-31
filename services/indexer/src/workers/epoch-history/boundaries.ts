// Locate epoch cranks in a height window. `RunEpoch` cranks emit a plain `wasm`
// event with `action=run_epoch` and `_contract_address=<our contract>` (fixture
// corpus: contract cranks emit plain wasm events with action attributes). We
// only need the (height, txhash) of each crank; the epoch decomposition itself
// is read by a height-pinned smart query (snapshot.ts), because the contract
// retains only the latest snapshot on chain (spec §13, contract §9.10).

import { optionalAttr, type RawEvent } from "../../decode/attributes.ts";
import type { Window } from "../../runtime/checkpoint.ts";

export const RUN_EPOCH_ACTION = "run_epoch";

/** A detected epoch crank: the height it ran at and the tx that ran it. */
export interface Crank {
  readonly height: bigint;
  readonly txhash: string;
}

/** The tx-search surface the crank scan needs (a subset of RpcClient). */
export interface CrankSource {
  txSearch(
    query: string,
    page?: number,
    perPage?: number,
  ): Promise<{
    totalCount: number;
    txs: readonly { hash: string; height: bigint; events: readonly RawEvent[] }[];
  }>;
}

const PER_PAGE = 100;

/** Cranks among a batch of txs: any tx with a `wasm` event carrying both our
 * contract address and `action=run_epoch`. At most one crank per tx. */
export function findCranks(
  txs: readonly { hash: string; height: bigint; events: readonly RawEvent[] }[],
  contractAddress: string,
): Crank[] {
  const cranks: Crank[] = [];
  for (const tx of txs) {
    const isCrank = tx.events.some(
      (e) =>
        e.type === "wasm" &&
        optionalAttr(e, "action") === RUN_EPOCH_ACTION &&
        optionalAttr(e, "_contract_address") === contractAddress,
    );
    if (isCrank) cranks.push({ height: tx.height, txhash: tx.hash });
  }
  return cranks;
}

/** Page tx-search across the window and return every crank, height-ordered. */
export async function collectCranks(
  rpc: CrankSource,
  contractAddress: string,
  window: Window,
): Promise<Crank[]> {
  const cranks: Crank[] = [];
  let page = 1;
  for (;;) {
    const res = await rpc.txSearch(
      `tx.height>=${window.from} AND tx.height<=${window.to}`,
      page,
      PER_PAGE,
    );
    cranks.push(...findCranks(res.txs, contractAddress));
    if (res.txs.length === 0 || page * PER_PAGE >= res.totalCount) break;
    page++;
  }
  cranks.sort((a, b) => (a.height === b.height ? 0 : a.height < b.height ? -1 : 1));
  return cranks;
}
