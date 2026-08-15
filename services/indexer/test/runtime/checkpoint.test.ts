// Unit: `runWindow` advances the cursor ONLY inside the same transaction as the
// data work, and never when that work throws (app-spec §9.2 atomic-cursor
// invariant). A hand-rolled fake stands in for Prisma so the test stays
// Postgres-free (the real transactional rollback is a Postgres guarantee
// exercised by the DB-backed suites); here we prove the ordering and that a
// throwing worker body reaches neither the cursor upsert nor a commit.

import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/prisma.ts";
import { readCheckpoint, runWindow, trailingTarget } from "../../src/runtime/checkpoint.ts";

interface UpsertCall {
  where: { stream: string };
  create: { stream: string; cursorHeight: bigint };
  update: { cursorHeight: bigint };
}

function fakePrisma(existing: Record<string, bigint> = {}) {
  const upserts: UpsertCall[] = [];
  const calls: string[] = [];
  const tx = {
    indexerCheckpoint: {
      upsert: async (args: UpsertCall) => {
        calls.push("upsert");
        upserts.push(args);
      },
    },
  };
  const prisma = {
    // Mimic Prisma: run the callback; if it rejects, the whole tx rejects.
    $transaction: async (cb: (t: typeof tx) => Promise<void>) => {
      calls.push("tx:begin");
      await cb(tx);
      calls.push("tx:commit");
    },
    indexerCheckpoint: {
      findUnique: async ({ where }: { where: { stream: string } }) =>
        where.stream in existing ? { cursorHeight: existing[where.stream]! } : null,
    },
  } as unknown as PrismaClient;
  return { prisma, upserts, calls };
}

describe("trailingTarget", () => {
  it("trails the head by the confirmation depth", () => {
    expect(trailingTarget(100n, 0)).toBe(100n);
    expect(trailingTarget(100n, 5)).toBe(95n);
  });

  it("returns -1 when nothing is yet safe to process", () => {
    expect(trailingTarget(3n, 5)).toBe(-1n);
    expect(trailingTarget(0n, 0)).toBe(0n);
  });

  it("rejects a negative depth", () => {
    expect(() => trailingTarget(10n, -1)).toThrow();
  });
});

describe("readCheckpoint", () => {
  it("returns the committed height or null", async () => {
    const { prisma } = fakePrisma({ "chain-events": 42n });
    expect(await readCheckpoint(prisma, "chain-events")).toBe(42n);
    expect(await readCheckpoint(prisma, "epoch-history")).toBeNull();
  });
});

describe("runWindow", () => {
  it("advances the cursor to window.to after the work, inside the transaction", async () => {
    const { prisma, upserts, calls } = fakePrisma();
    const work = vi.fn(async () => {});

    await runWindow(prisma, "chain-events", { from: 10n, to: 19n }, work);

    expect(work).toHaveBeenCalledOnce();
    expect(upserts).toEqual([
      {
        where: { stream: "chain-events" },
        create: { stream: "chain-events", cursorHeight: 19n },
        update: { cursorHeight: 19n },
      },
    ]);
    // work runs, THEN the cursor upsert, THEN commit.
    expect(calls).toEqual(["tx:begin", "upsert", "tx:commit"]);
  });

  it("does not advance the cursor (or commit) when the work throws", async () => {
    const { prisma, upserts, calls } = fakePrisma();
    const boom = async () => {
      throw new Error("decode failed");
    };

    await expect(runWindow(prisma, "chain-events", { from: 10n, to: 19n }, boom)).rejects.toThrow(
      "decode failed",
    );

    expect(upserts).toEqual([]);
    expect(calls).toEqual(["tx:begin"]); // no upsert, no commit
  });
});
