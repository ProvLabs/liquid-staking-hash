// §10.2 steps 5–6: broadcast the SIGNED TxRaw (BROADCAST_MODE_SYNC) and poll
// for inclusion. Route shapes mirror packages/chain-client/src/tx.ts. The
// chain's errors surface verbatim; there is NO retry and NO sequence bumping
// — a retry loop against a guard-rejected tx is a griefing pattern on the
// user's own funds (C3).

import { lcdGetJson, lcdPostJson } from "@/data/lcd";
import { bytesToBase64 } from "@/tx/build";

export interface BroadcastOutcome {
  txhash: string;
  /** 0 = executed successfully at inclusion. */
  code: number;
  rawLog: string;
  height: string;
}

const POLL_INTERVAL_MS = 1_500;
const POLL_ATTEMPTS = 40; // ~60 s; devnet blocks land well inside it

/** Broadcast and poll to inclusion. Throws on mempool rejection (CheckTx
 *  code != 0) or on the polling window expiring — each with the chain's own
 *  words, before any success is claimed. */
export async function broadcastAndConfirm(txRaw: Uint8Array): Promise<BroadcastOutcome> {
  const body = (await lcdPostJson("/cosmos/tx/v1beta1/txs", {
    tx_bytes: bytesToBase64(txRaw),
    mode: "BROADCAST_MODE_SYNC",
  })) as { tx_response?: { txhash?: string; code?: number; raw_log?: string } };
  const res = body.tx_response;
  if (res === undefined || typeof res.txhash !== "string") {
    throw new Error("broadcast: unexpected response shape");
  }
  if ((res.code ?? 0) !== 0) {
    throw new Error(`broadcast rejected (code ${res.code}): ${res.raw_log ?? ""}`);
  }

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    let included: unknown;
    try {
      included = await lcdGetJson(`/cosmos/tx/v1beta1/txs/${res.txhash}`);
    } catch {
      // 404 = not yet included; any other read failure is transient for the
      // remainder of the window (the window's expiry is the honest give-up).
      continue;
    }
    const tx = (included as { tx_response?: { code?: number; raw_log?: string; height?: string } })
      .tx_response;
    if (tx === undefined) continue;
    if ((tx.code ?? 0) !== 0) {
      throw new Error(`tx failed at inclusion (code ${tx.code}): ${tx.raw_log ?? ""}`);
    }
    return {
      txhash: res.txhash,
      code: tx.code ?? 0,
      rawLog: tx.raw_log ?? "",
      height: tx.height ?? "",
    };
  }
  throw new Error(
    `tx ${res.txhash} not observed included within the polling window — check the chain directly`,
  );
}
