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
import { decodeBlockEvent, decodeTxEvent, decodeTxPayments } from "../../src/workers/chain-events/decode.ts";
import {
  NAV_EVENT,
  TRANSFER_EVENT,
  VAULT_EVENT,
  WASM_EVENT,
  type EventScope,
} from "../../src/workers/chain-events/events.ts";

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

// The devnet vault/receipt/contract the corpus was captured against
// (manifest.json).
const scope: EventScope = {
  vaultAddress: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad",
  receiptDenom: "nvhash",
  contractAddress: "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8",
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

// ---------------------------------------------------------------------------
// Operator payments (M6.4 §2.1). These decode from a PAIR — the contract's wasm
// event plus the same-msg_index funds transfer — because `pay_tip` publishes
// only the epoch-cumulative `tip_epoch`, never the payment's own nhash.

/** The captured payer/valoper/contract of the operator fixtures. */
const PAYER = "tp18kkn20p7dphkal2x84t30cv7z6v9rf9cvykjhk";
const VALOPER = "tpvaloper1l39wu7cht0zcycc5rkcd90sdd4ksjmxwjqvnjp";

function payEvents(action: "pay_commission" | "pay_tip", amount: string, msgIndex = "0"): RawEvent[] {
  const wasmAttrs =
    action === "pay_commission"
      ? [
          { key: "amount", value: amount },
          { key: "outstanding", value: "0" },
        ]
      : [{ key: "tip_epoch", value: "999999999999" }];
  return [
    {
      type: TRANSFER_EVENT,
      attributes: [
        { key: "recipient", value: scope.contractAddress },
        { key: "sender", value: PAYER },
        { key: "amount", value: `${amount}nhash` },
        { key: "msg_index", value: msgIndex },
      ],
    },
    {
      type: WASM_EVENT,
      attributes: [
        { key: "_contract_address", value: scope.contractAddress },
        { key: "action", value: action },
        { key: "valoper", value: VALOPER },
        ...wasmAttrs,
        { key: "msg_index", value: msgIndex },
      ],
    },
  ];
}

describe("operator-payment decode against the fixture corpus", () => {
  it("decodes PayCommission from the captured tx (amount from the attached funds)", () => {
    const { payments, undecodable } = decodeTxPayments(
      txEvents(load("operator/pay-commission.json")),
      txCtx,
      scope,
    );
    expect(undecodable).toEqual([]);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      kind: "operator_payment",
      paymentType: "commission",
      valoper: VALOPER,
      payer: PAYER,
      amount: 1500000000n,
      msgIndex: 0,
    });
  });

  it("decodes PayTip from the captured tx — the amount CANNOT come from the wasm event", () => {
    const events = txEvents(load("operator/pay-tip.json"));
    // Pin the shape the design rests on: the wasm event's only amount-ish
    // attribute is the epoch-cumulative tip_epoch. If the contract ever emits a
    // per-payment amount here, this assertion is the prompt to simplify.
    const wasm = events.find(
      (e) => e.type === WASM_EVENT && e.attributes.some((a) => a.key === "action" && a.value === "pay_tip"),
    );
    expect(wasm?.attributes.map((a) => a.key)).not.toContain("amount");

    const { payments, undecodable } = decodeTxPayments(events, txCtx, scope);
    expect(undecodable).toEqual([]);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      kind: "operator_payment",
      paymentType: "tip",
      valoper: VALOPER,
      payer: PAYER,
      amount: 2750000000n,
      msgIndex: 0,
    });
  });

  it("ignores a non-payment execute against our contract (enroll)", () => {
    expect(
      decodeTxPayments(txEvents(load("operator/register-participation.json")), txCtx, scope).payments,
    ).toEqual([]);
  });

  it("scopes out another contract's identically-shaped pay event", () => {
    const foreign = payEvents("pay_commission", "1000").map((e) => ({
      ...e,
      attributes: e.attributes.map((a) =>
        a.key === "_contract_address" || a.key === "recipient"
          ? { ...a, value: "tp1OTHERCONTRACT" }
          : a,
      ),
    }));
    expect(decodeTxPayments(foreign, txCtx, scope).payments).toEqual([]);
  });

  it("decodes each payment in a multi-message tx by its own msg_index", () => {
    const events = [...payEvents("pay_commission", "111", "0"), ...payEvents("pay_tip", "222", "1")];
    expect(decodeTxPayments(events, txCtx, scope).payments).toMatchObject([
      { paymentType: "commission", amount: 111n, msgIndex: 0 },
      { paymentType: "tip", amount: 222n, msgIndex: 1 },
    ]);
  });

  // ── Ambiguous funds pairing: SKIPPED and reported, never guessed — and
  // never fatal (2026-07-28 review). How many transfers land at a msg_index is
  // a property of how the TRANSACTION was composed, which is not ours to
  // control: paying is permissionless, and a contract batching two pay_tip
  // sub-calls in one message legally produces two. Throwing aborted
  // `collectWindow`, and since the runner re-collects an aborted window on
  // restart, ONE such tx stalled the whole chain-events stream — transactions
  // and redemption_requests included — permanently. These three cases are the
  // gate on that: a reason is recorded, no payment is fabricated, and no throw
  // escapes to the worker loop.
  it("skips and reports, without throwing, when the funds transfer is missing", () => {
    const events = payEvents("pay_tip", "500").filter((e) => e.type !== TRANSFER_EVENT);
    const { payments, undecodable } = decodeTxPayments(events, txCtx, scope);
    expect(payments).toEqual([]);
    expect(undecodable).toMatchObject([{ msgIndex: 0, reason: /found 0 for 1 payment/ }]);
  });

  it("skips and reports when the transfer count does not match the payment count", () => {
    // Two transfers but only one payment event: nothing says which is the
    // payment's funds, so neither is guessed.
    const [transfer, wasm] = payEvents("pay_tip", "500");
    const { payments, undecodable } = decodeTxPayments([transfer!, transfer!, wasm!], txCtx, scope);
    expect(payments).toEqual([]);
    expect(undecodable).toMatchObject([{ reason: /found 2 for 1 payment/ }]);
  });

  // ── Batched payments under ONE msg_index (PR #22 review) ──────────────────
  // A contract that sub-executes two payments in a single message legally
  // produces two wasm events and two transfers at the same msg_index. These
  // must DECODE — dropping them loses real payments from the operator's
  // history, totals and §14.11 CSV. Pairing is by emission order, which is
  // execution order.
  it("decodes two batched tips at one msg_index, pairing in emission order", () => {
    const [t1, w1] = payEvents("pay_tip", "111", "0");
    const [t2, w2] = payEvents("pay_tip", "222", "0");
    // Interleaved exactly as sequential sub-message execution emits them.
    const { payments, undecodable } = decodeTxPayments([t1!, w1!, t2!, w2!], txCtx, scope);
    expect(undecodable).toEqual([]);
    expect(payments).toMatchObject([
      { paymentType: "tip", amount: 111n, msgIndex: 0 },
      { paymentType: "tip", amount: 222n, msgIndex: 0 },
    ]);
  });

  it("a batched commission cross-checks its own pairing and rejects a mismatch", () => {
    // pay_commission publishes its amount, so a mispairing is detectable. Build
    // a batch whose transfers are in the WRONG order relative to the events.
    const [t1, w1] = payEvents("pay_commission", "111", "0");
    const [t2, w2] = payEvents("pay_commission", "222", "0");
    const { payments, undecodable } = decodeTxPayments([t2!, w1!, t1!, w2!], txCtx, scope);
    expect(payments).toEqual([]);
    expect(undecodable).toHaveLength(2);
    expect(undecodable[0]!.reason).toMatch(/disagrees with the attached funds/);
  });

  it("skips and reports when a commission's declared amount disagrees with the funds moved", () => {
    const events = payEvents("pay_commission", "500").map((e) =>
      e.type === TRANSFER_EVENT
        ? { ...e, attributes: e.attributes.map((a) => (a.key === "amount" ? { ...a, value: "499nhash" } : a)) }
        : e,
    );
    const { payments, undecodable } = decodeTxPayments(events, txCtx, scope);
    expect(payments).toEqual([]);
    expect(undecodable).toMatchObject([{ reason: /disagrees with the attached funds/ }]);
  });

  it("still decodes the OTHER payments in a tx that contains an ambiguous one", () => {
    // Isolation is the point: one unpairable payment must not cost the window
    // the facts around it.
    const [badTransfer, badWasm] = payEvents("pay_tip", "500", "0");
    const good = payEvents("pay_commission", "111", "1");
    const { payments, undecodable } = decodeTxPayments(
      [badTransfer!, badTransfer!, badWasm!, ...good],
      txCtx,
      scope,
    );
    expect(payments).toMatchObject([{ paymentType: "commission", amount: 111n, msgIndex: 1 }]);
    expect(undecodable).toHaveLength(1);
  });

  it("throws on a multi-coin funds transfer (must_pay bounds it to one)", () => {
    const events = payEvents("pay_tip", "500").map((e) =>
      e.type === TRANSFER_EVENT
        ? { ...e, attributes: e.attributes.map((a) => (a.key === "amount" ? { ...a, value: "500nhash,1other" } : a)) }
        : e,
    );
    expect(() => decodeTxPayments(events, txCtx, scope)).toThrow(/coin string/);
  });

  it("does not mistake a tx-level fee transfer (no msg_index) for attached funds", () => {
    const [transfer, wasm] = payEvents("pay_tip", "500");
    const feeToContract: RawEvent = {
      type: TRANSFER_EVENT,
      attributes: [
        { key: "recipient", value: scope.contractAddress },
        { key: "sender", value: PAYER },
        { key: "amount", value: "1nhash" },
      ],
    };
    const { payments, undecodable } = decodeTxPayments(
      [feeToContract, transfer!, wasm!],
      txCtx,
      scope,
    );
    expect(payments).toMatchObject([{ amount: 500n }]);
    // The fee transfer must not count toward the pairing either — otherwise
    // this reads as two transfers and the payment is skipped, not decoded.
    expect(undecodable).toEqual([]);
  });
});
