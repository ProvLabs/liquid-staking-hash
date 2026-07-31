// Unit: the dual-source collector orders tx + EndBlocker events by height and,
// per the PR-8 review fix, fetches a block's time ONLY for heights that
// actually produce a domain event — a height of purely non-vault txs / events
// costs no `/block` round-trip. Injected EventSource, no network.

import { describe, expect, it } from "vitest";
import type { RawEvent } from "../../src/decode/attributes.ts";
import { collectWindow, type EventSource } from "../../src/workers/chain-events/sources.ts";
import {
  TRANSFER_EVENT,
  VAULT_EVENT,
  WASM_EVENT,
  type EventScope,
} from "../../src/workers/chain-events/events.ts";

const scope: EventScope = {
  vaultAddress: "tp1vault",
  receiptDenom: "nvhash",
  contractAddress: "tp1contract",
};

const swapIn: RawEvent = {
  type: VAULT_EVENT.swapIn,
  attributes: [
    { key: "amount_in", value: '"100nhash"' },
    { key: "owner", value: '"tp1owner"' },
    { key: "shares_received", value: '"100nvhash"' },
    { key: "vault_address", value: '"tp1vault"' },
    { key: "msg_index", value: "0" },
  ],
};
const completed: RawEvent = {
  type: VAULT_EVENT.swapOutCompleted,
  attributes: [
    { key: "assets", value: '"50nhash"' },
    { key: "owner", value: '"tp1owner"' },
    { key: "request_id", value: '"1"' },
    { key: "vault_address", value: '"tp1vault"' },
    { key: "mode", value: "EndBlock" },
  ],
};
const transfer: RawEvent = {
  type: TRANSFER_EVENT,
  attributes: [{ key: "amount", value: "1nhash" }],
};
const mint: RawEvent = { type: "mint", attributes: [{ key: "amount", value: "0" }] };

/** A PayTip execute against our contract: the wasm event plus the funds
 * transfer the amount is decoded from. */
const payTipFunds: RawEvent = {
  type: TRANSFER_EVENT,
  attributes: [
    { key: "recipient", value: "tp1contract" },
    { key: "sender", value: "tp1payer" },
    { key: "amount", value: "700nhash" },
    { key: "msg_index", value: "0" },
  ],
};
const payTipWasm: RawEvent = {
  type: WASM_EVENT,
  attributes: [
    { key: "_contract_address", value: "tp1contract" },
    { key: "action", value: "pay_tip" },
    { key: "valoper", value: "tpvaloper1x" },
    { key: "tip_epoch", value: "700" },
    { key: "msg_index", value: "0" },
  ],
};

/** Fake source: h1 tx is non-vault, h2 tx is a swap-in, h3 EndBlocker payout,
 * h4 tx is an operator payment carrying NO vault event at all. */
function fakeSource(): { source: EventSource; blockTimeHeights: bigint[] } {
  const blockTimeHeights: bigint[] = [];
  const source: EventSource = {
    txSearch: async () => ({
      totalCount: 3,
      txs: [
        { hash: "TX1", height: 1n, events: [transfer] },
        { hash: "TX2", height: 2n, events: [transfer, swapIn] },
        { hash: "TX4", height: 4n, events: [transfer, payTipFunds, payTipWasm] },
      ],
    }),
    blockResults: async (height) => {
      // Only height 3 carries a relevant EndBlocker event.
      if (BigInt(height) === 3n) return { finalizeBlockEvents: [mint, completed] };
      return { finalizeBlockEvents: [mint] };
    },
    blockTime: async (height) => {
      blockTimeHeights.push(BigInt(height));
      return new Date(Number(height) * 1000);
    },
  };
  return { source, blockTimeHeights };
}

describe("collectWindow", () => {
  it("fetches block time only for heights that produce events", async () => {
    const { source, blockTimeHeights } = fakeSource();
    const events = await collectWindow(source, scope, { from: 1n, to: 4n });

    // h1 (non-vault tx) and its empty block never trigger a /block fetch.
    expect([...blockTimeHeights].sort()).toEqual([2n, 3n, 4n]);

    // Decoded + height-ordered: swap-in (h2), payout (h3), payment (h4).
    expect(events.map((e) => ({ kind: e.kind, height: e.height }))).toEqual([
      { kind: "swap_in", height: 2n },
      { kind: "swap_out_completed", height: 3n },
      { kind: "operator_payment", height: 4n },
    ]);
  });

  it("collects an operator payment from a tx carrying no vault event", async () => {
    const { source } = fakeSource();
    const events = await collectWindow(source, scope, { from: 1n, to: 4n });
    expect(events.find((e) => e.kind === "operator_payment")).toMatchObject({
      paymentType: "tip",
      valoper: "tpvaloper1x",
      payer: "tp1payer",
      amount: 700n,
      txhash: "TX4",
      msgIndex: 0,
    });
  });
});
