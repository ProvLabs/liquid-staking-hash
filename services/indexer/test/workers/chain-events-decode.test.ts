// Fixture-decode: every swap/expedite/payout/refund/NAV event the worker
// decodes matches the captured devnet corpus (packages/fixtures). A contract
// event-shape change breaks THIS test, not production (app-spec §9.2). Reads the
// fixtures by path (no cross-package dependency); the corpus is provisional
// against the pre-release vault and re-vetted at PR 8.0.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RawEvent } from "../../src/decode/attributes.ts";
import { decodeBlockEvent, decodeTxEvent } from "../../src/workers/chain-events/decode.ts";
import { NAV_EVENT, VAULT_EVENT, type EventScope } from "../../src/workers/chain-events/events.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CORPUS = join(REPO, "packages", "fixtures", "fixtures");

function load(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CORPUS, rel), "utf8")) as Record<string, unknown>;
}

/** Events from a tx-search fixture (`tx_response.events`). */
function txEvents(fixture: Record<string, unknown>): RawEvent[] {
  const resp = fixture["tx_response"] as Record<string, unknown>;
  return resp["events"] as RawEvent[];
}

/** EndBlocker events from a block_results fixture (`finalize_block_events`). */
function blockEvents(fixture: Record<string, unknown>): RawEvent[] {
  return fixture["finalize_block_events"] as RawEvent[];
}

function find(events: RawEvent[], type: string): RawEvent {
  const ev = events.find((e) => e.type === type);
  if (!ev) throw new Error(`fixture missing event ${type}`);
  return ev;
}

// The devnet vault/receipt the corpus was captured against (manifest.json).
const scope: EventScope = {
  vaultAddress: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad",
  receiptDenom: "nvhash",
};
const txCtx = { height: 1n, blockTime: new Date(0), txhash: "TX" };
const blkCtx = { height: 1n, blockTime: new Date(0) };

describe("chain-events decode against the fixture corpus", () => {
  it("decodes EventSwapIn (tx-search)", () => {
    const ev = find(txEvents(load("msgs/swap-in.json")), VAULT_EVENT.swapIn);
    expect(decodeTxEvent(ev, txCtx, scope)).toMatchObject({
      kind: "swap_in",
      owner: "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0",
      nhashIn: 500000000000n,
      sharesReceived: 500000000000000000n,
      msgIndex: 0,
    });
  });

  it("decodes EventSwapOutRequested (tx-search)", () => {
    const ev = find(txEvents(load("msgs/swap-out.json")), VAULT_EVENT.swapOutRequested);
    expect(decodeTxEvent(ev, txCtx, scope)).toMatchObject({
      kind: "swap_out_requested",
      owner: "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0",
      requestId: "3",
      shares: 36222971000000n,
      redeemDenom: "nhash",
    });
  });

  it("decodes EventPendingSwapOutExpedited (crank tx)", () => {
    const ev = find(txEvents(load("run-epoch/expedite.json")), VAULT_EVENT.expedited);
    expect(decodeTxEvent(ev, txCtx, scope)).toMatchObject({ kind: "expedited", requestId: "3" });
  });

  it("decodes EventSwapOutCompleted (EndBlocker)", () => {
    const ev = find(blockEvents(load("block-events/swap-out-completed.json")), VAULT_EVENT.swapOutCompleted);
    expect(decodeBlockEvent(ev, blkCtx, scope)).toMatchObject({
      kind: "swap_out_completed",
      owner: "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0",
      requestId: "3",
      assetsNhash: 36852482n,
    });
  });

  it("decodes EventSwapOutRefunded (EndBlocker)", () => {
    const ev = find(blockEvents(load("block-events/swap-out-refunded.json")), VAULT_EVENT.swapOutRefunded);
    expect(decodeBlockEvent(ev, blkCtx, scope)).toMatchObject({
      kind: "swap_out_refunded",
      requestId: "2",
      shares: 2144891884000000n,
      reason: "insufficient_funds",
    });
  });

  it("decodes EventSetNetAssetValue (NAV marker)", () => {
    const ev = find(blockEvents(load("block-events/swap-out-completed.json")), NAV_EVENT);
    expect(decodeBlockEvent(ev, blkCtx, scope)).toMatchObject({ kind: "nav", priceNhash: 315387426370n });
  });

  it("scopes out a different vault's swap and a different denom's NAV", () => {
    const foreignVault: RawEvent = {
      type: VAULT_EVENT.swapIn,
      attributes: [
        { key: "amount_in", value: '"1nhash"' },
        { key: "owner", value: '"tp1someone"' },
        { key: "shares_received", value: '"1nvhash"' },
        { key: "vault_address", value: '"tp1OTHERVAULT"' },
        { key: "msg_index", value: "0" },
      ],
    };
    expect(decodeTxEvent(foreignVault, txCtx, scope)).toBeNull();

    const foreignDenom: RawEvent = {
      type: NAV_EVENT,
      attributes: [
        { key: "denom", value: '"othercoin"' },
        { key: "price", value: '"1nhash"' },
        { key: "source", value: '"vault"' },
        { key: "mode", value: "EndBlock" },
      ],
    };
    expect(decodeBlockEvent(foreignDenom, blkCtx, scope)).toBeNull();
  });
});
