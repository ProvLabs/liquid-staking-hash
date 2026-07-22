// Unit: window pagination (pure), the registration seam, and one guarded pass
// of the loop — proving the runner reads the checkpoint, trails the head,
// pages the range, and advances the cursor per window without Postgres or a
// live chain.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Window } from "../../src/runtime/checkpoint.ts";
import {
  clearRegisteredWorkers,
  planWindows,
  registerWorker,
  registeredWorkers,
  runWorker,
  type Worker,
  type WorkerRuntimeDeps,
} from "../../src/runtime/worker.ts";

describe("planWindows", () => {
  it("splits an inclusive range into bounded windows", () => {
    expect(planWindows(1n, 25n, 10n)).toEqual([
      { from: 1n, to: 10n },
      { from: 11n, to: 20n },
      { from: 21n, to: 25n },
    ]);
  });

  it("returns a single window when the range fits", () => {
    expect(planWindows(100n, 105n, 10n)).toEqual([{ from: 100n, to: 105n }]);
  });

  it("returns nothing when from > to", () => {
    expect(planWindows(10n, 9n, 10n)).toEqual([]);
  });

  it("rejects a non-positive span", () => {
    expect(() => planWindows(1n, 2n, 0n)).toThrow();
  });
});

describe("registration seam", () => {
  afterEach(() => clearRegisteredWorkers());

  const stub = (stream: string): Worker => ({
    stream,
    collect: async () => undefined,
    write: async () => {},
  });

  it("registers workers and rejects duplicate streams", () => {
    registerWorker(stub("chain-events"));
    registerWorker(stub("epoch-history"));
    expect(registeredWorkers().map((w) => w.stream)).toEqual(["chain-events", "epoch-history"]);
    expect(() => registerWorker(stub("chain-events"))).toThrow(/already registered/);
  });
});

describe("runWorker (one guarded pass)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("processes every window up to the trailing target, then stops on abort", async () => {
    const processed: Window[] = [];
    const upserted: bigint[] = [];

    const tx = { indexerCheckpoint: { upsert: async (a: { create: { cursorHeight: bigint } }) => {
      upserted.push(a.create.cursorHeight);
    } } };
    const prisma = {
      $transaction: async (cb: (t: typeof tx) => Promise<void>) => cb(tx),
      indexerCheckpoint: { findUnique: async () => null }, // no checkpoint → startHeight
    } as unknown as PrismaClient;

    const controller = new AbortController();
    const sleep = vi.fn(async () => {
      controller.abort(); // stop after the first caught-up pass
    });

    const worker: Worker<Window> = {
      stream: "chain-events",
      startHeight: 100n,
      collect: async (window) => window,
      write: async (_tx, _window, batch) => {
        processed.push(batch);
      },
    };

    const deps: WorkerRuntimeDeps = {
      prisma,
      headHeight: async () => 105n,
      confirmationDepth: 0,
      maxWindowSpan: 10n,
      pollIntervalMs: 1_000,
      sleep,
      signal: controller.signal,
    };

    await runWorker(worker, deps);

    expect(processed).toEqual([{ from: 100n, to: 105n }]);
    expect(upserted).toEqual([105n]); // cursor advanced to the window end
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("floors the first ingested height at 1 on an empty checkpoint (no block 0)", async () => {
    // Regression: CometBFT heights are 1-based and `block_results?height=0` is a
    // hard RPC error. With no checkpoint and a 0/unset startHeight the runner
    // must page from height 1, never 0, or the worker crashes on its first live
    // read (surfaced by a fresh-DB devnet bring-up).
    const collected: Window[] = [];
    const tx = { indexerCheckpoint: { upsert: async () => {} } };
    const prisma = {
      $transaction: async (cb: (t: typeof tx) => Promise<void>) => cb(tx),
      indexerCheckpoint: { findUnique: async () => null }, // no checkpoint
    } as unknown as PrismaClient;

    const controller = new AbortController();
    const worker: Worker<Window> = {
      stream: "chain-events",
      startHeight: 0n, // the crashing default
      collect: async (window) => {
        collected.push(window);
        return window;
      },
      write: async () => {},
    };
    await runWorker(worker, {
      prisma,
      headHeight: async () => 3n,
      confirmationDepth: 0,
      maxWindowSpan: 100n,
      pollIntervalMs: 1_000,
      sleep: async () => {
        controller.abort();
      },
      signal: controller.signal,
    });

    // Empty checkpoint + startHeight 0 → first window starts at 1, not 0.
    expect(collected).toEqual([{ from: 1n, to: 3n }]);
    expect(collected.every((w) => w.from >= 1n)).toBe(true);
  });

  it("resumes from the committed checkpoint + 1", async () => {
    const processed: Window[] = [];
    const tx = { indexerCheckpoint: { upsert: async () => {} } };
    const prisma = {
      $transaction: async (cb: (t: typeof tx) => Promise<void>) => cb(tx),
      indexerCheckpoint: { findUnique: async () => ({ cursorHeight: 200n }) },
    } as unknown as PrismaClient;

    const controller = new AbortController();
    const worker: Worker<Window> = {
      stream: "chain-events",
      startHeight: 0n,
      collect: async (window) => window,
      write: async (_tx, _window, batch) => {
        processed.push(batch);
      },
    };
    await runWorker(worker, {
      prisma,
      headHeight: async () => 203n,
      confirmationDepth: 0,
      maxWindowSpan: 100n,
      pollIntervalMs: 1_000,
      sleep: async () => {
        controller.abort();
      },
      signal: controller.signal,
    });

    // committed 200 → resume at 201, not startHeight
    expect(processed).toEqual([{ from: 201n, to: 203n }]);
  });
});
