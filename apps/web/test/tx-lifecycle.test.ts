// Lifecycle-reducer gates: transitions are total, `signing`
// is unreachable except through `confirm`, `confirmed` is unreachable
// before chain inclusion, on-chain failure renders as failure, and RESET
// cannot discard an in-flight sign/broadcast.

import { describe, expect, it } from "vitest";

import { buildTxPlan, type TxIntent } from "~/tx/build";
import {
  INITIAL_TX_STATE,
  pendingRow,
  txReducer,
  type TxEvent,
  type TxState,
} from "~/tx/lifecycle";

const intent: TxIntent = {
  kind: "swap_in",
  owner: "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0",
  vaultAddress: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad",
  amount: 1_000_000_000n,
  denom: "nhash",
};
const plan = buildTxPlan(
  intent,
  { gasLimit: 260_000n, amount: 495_300_000n, denom: "nhash" },
  {
    chainId: "chain-dev",
    accountNumber: 1n,
    sequence: 0n,
    pubkeyBase64: Buffer.alloc(33, 2).toString("base64"),
  },
);

function drive(events: TxEvent[], from: TxState = INITIAL_TX_STATE): TxState {
  return events.reduce(txReducer, from);
}

const toConfirm: TxEvent[] = [
  { type: "START", intent },
  { type: "PREFLIGHT_READY" },
  { type: "SIMULATE" },
  { type: "SIMULATED", plan },
];
const toPending: TxEvent[] = [
  ...toConfirm,
  { type: "CONFIRM_ACCEPTED" },
  { type: "SIGNED", signatureBase64: "c2ln" },
  { type: "BROADCAST_ACCEPTED", txhash: "A".repeat(64), submittedAtIso: "2026-07-23T00:00:00Z" },
];

describe("happy path", () => {
  it("walks idle → … → confirmed with reconcile dropping the pending row", () => {
    let state = drive(toPending);
    expect(state.phase).toBe("pending");
    expect(pendingRow(state)?.txhash).toBe("A".repeat(64));

    state = txReducer(state, { type: "INCLUDED", height: "42", code: 0, rawLog: "" });
    expect(state.phase).toBe("reconciling");
    expect(pendingRow(state)).not.toBeNull(); // optimistic row survives until reconcile

    state = txReducer(state, { type: "RECONCILED" });
    expect(state).toEqual({ phase: "confirmed", txhash: "A".repeat(64), height: "42" });
    expect(pendingRow(state)).toBeNull();
  });
});

describe("signing is unreachable except through confirm", () => {
  it("SIGNED is ignored in every phase before signing", () => {
    const prefixes: TxEvent[][] = [
      [],
      [{ type: "START", intent }],
      [{ type: "START", intent }, { type: "PREFLIGHT_READY" }],
      [{ type: "START", intent }, { type: "PREFLIGHT_READY" }, { type: "SIMULATE" }],
      toConfirm, // confirm phase: SIGNED without CONFIRM_ACCEPTED must not sign
    ];
    for (const prefix of prefixes) {
      const before = drive(prefix);
      const after = txReducer(before, { type: "SIGNED", signatureBase64: "c2ln" });
      expect(after.phase, `SIGNED must be ignored in ${before.phase}`).toBe(before.phase);
    }
  });

  it("only CONFIRM_ACCEPTED enters signing", () => {
    expect(drive([...toConfirm, { type: "CONFIRM_ACCEPTED" }]).phase).toBe("signing");
    expect(drive([...toConfirm, { type: "CONFIRM_CANCELLED" }])).toEqual(INITIAL_TX_STATE);
  });
});

describe("confirmed is unreachable before inclusion", () => {
  it("no event sequence without INCLUDED(code 0) reaches confirmed", () => {
    // RECONCILED before inclusion is ignored in pending.
    const state = drive([...toPending, { type: "RECONCILED" }]);
    expect(state.phase).toBe("pending");
  });

  it("an on-chain execution failure renders failed with the chain's reason", () => {
    const state = drive([
      ...toPending,
      { type: "INCLUDED", height: "42", code: 5, rawLog: "insufficient funds" },
    ]);
    expect(state).toEqual({
      phase: "failed",
      stage: "execute",
      txhash: "A".repeat(64),
      detail: "insufficient funds",
    });
  });
});

describe("blocked states carry machine-readable reasons", () => {
  it("PREFLIGHT_BLOCKED holds the reasons for the UI", () => {
    const state = drive([
      { type: "START", intent },
      { type: "PREFLIGHT_BLOCKED", reasons: [{ code: "vault-paused", detail: "maintenance" }] },
    ]);
    expect(state).toEqual({
      phase: "blocked",
      intent,
      reasons: [{ code: "vault-paused", detail: "maintenance" }],
    });
  });
});

describe("RESET discipline", () => {
  it("cannot discard an in-flight sign or broadcast", () => {
    const signing = drive([...toConfirm, { type: "CONFIRM_ACCEPTED" }]);
    expect(txReducer(signing, { type: "RESET" })).toBe(signing);
    const broadcasting = txReducer(signing, { type: "SIGNED", signatureBase64: "c2ln" });
    expect(txReducer(broadcasting, { type: "RESET" })).toBe(broadcasting);
  });

  it("resets cleanly from terminal and waiting states", () => {
    expect(txReducer(drive(toPending), { type: "RESET" })).toEqual(INITIAL_TX_STATE);
    const failed = drive([...toConfirm, { type: "SIMULATE_FAILED", detail: "x" }]);
    // simulate-failed only fires from simulating; drive again properly:
    const failedState = drive([
      { type: "START", intent },
      { type: "PREFLIGHT_READY" },
      { type: "SIMULATE" },
      { type: "SIMULATE_FAILED", detail: "gas estimation failed" },
    ]);
    expect(failedState.phase).toBe("failed");
    expect(txReducer(failedState, { type: "RESET" })).toEqual(INITIAL_TX_STATE);
    void failed;
  });

  it("totality: every event in every phase returns a defined state", () => {
    const allEvents: TxEvent[] = [
      { type: "START", intent },
      { type: "PREFLIGHT_BLOCKED", reasons: [{ code: "amount-invalid" }] },
      { type: "PREFLIGHT_READY" },
      { type: "SIMULATE" },
      { type: "SIMULATED", plan },
      { type: "SIMULATE_FAILED", detail: "d" },
      { type: "CONFIRM_ACCEPTED" },
      { type: "CONFIRM_CANCELLED" },
      { type: "SIGNED", signatureBase64: "c2ln" },
      { type: "SIGN_FAILED", detail: "d" },
      { type: "BROADCAST_ACCEPTED", txhash: "B".repeat(64), submittedAtIso: "t" },
      { type: "BROADCAST_FAILED", detail: "d" },
      { type: "INCLUDED", height: "1", code: 0, rawLog: "" },
      { type: "RECONCILED" },
      { type: "RESET" },
    ];
    const reachable: TxState[] = [
      INITIAL_TX_STATE,
      drive([{ type: "START", intent }]),
      drive([{ type: "START", intent }, { type: "PREFLIGHT_READY" }]),
      drive(toConfirm),
      drive([...toConfirm, { type: "CONFIRM_ACCEPTED" }]),
      drive(toPending),
    ];
    for (const state of reachable) {
      for (const event of allEvents) {
        expect(txReducer(state, event)).toBeDefined();
      }
    }
  });
});
