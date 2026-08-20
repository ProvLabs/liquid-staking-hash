// The composition root's start-height wiring. `Worker.startHeight` exists on
// every worker, but a worker left at its 0 default pages from height 1, which
// on a chain with millions of blocks never converges. These assertions are the
// gate on that: they fail if a stream stops receiving the configured start.

import { describe, expect, it } from "vitest";
import type { IndexerConfig } from "../../src/config.ts";
import { buildWorkers } from "../../src/index.ts";
import { PinnedLcdClient, RpcClient } from "../../src/transport/rpc.ts";

const CONFIG: IndexerConfig = {
  databaseUrl: "postgresql://u:p@h:5432/d?schema=indexed",
  lcdUrl: "http://lcd:1317",
  rpcUrl: "http://rpc:26657",
  chainId: "pio-testnet-1",
  contractAddress: "tp1contract",
  vaultAddress: "tp1vault",
  receiptDenom: "nvhash",
  indexStartHeight: 33_273_900,
  confirmationDepth: 0,
  indexWindowSpan: 500,
  pollIntervalMs: 5000,
  reconcileIntervalMs: 30000,
  govGroupPolicies: [],
  govStartHeight: 33_273_901,
};

function workers() {
  return buildWorkers(CONFIG, {
    rpc: new RpcClient(CONFIG.rpcUrl),
    pinned: new PinnedLcdClient(CONFIG.lcdUrl),
  });
}

describe("buildWorkers start-height wiring", () => {
  it("gives every non-governance stream the configured start height", () => {
    const nonGov = workers().filter((w) => !w.stream.includes("governance"));
    expect(nonGov.length).toBeGreaterThan(0);
    for (const worker of nonGov) {
      expect(worker.startHeight).toBe(33_273_900n);
    }
  });

  it("leaves governance on its own independent knob", () => {
    const gov = workers().find((w) => w.stream.includes("governance"));
    expect(gov?.startHeight).toBe(33_273_901n);
  });

  it("never leaves a stream at the 0 default", () => {
    for (const worker of workers()) {
      expect(worker.startHeight).not.toBe(0n);
      expect(worker.startHeight).not.toBeUndefined();
    }
  });
});
