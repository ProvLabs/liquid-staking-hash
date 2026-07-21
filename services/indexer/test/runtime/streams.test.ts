// Unit: the per-(chain_id, contract) isolation boot check (app-spec §9.3).
// First run records the identity marker; a matching run is a no-op; a
// mismatching run fails closed with ChainIsolationError rather than mixing two
// histories. Postgres-free via a fake checkpoint store.

import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  assertChainIsolation,
  ChainIsolationError,
  PROVENANCE_MARKER_STREAM,
} from "../../src/runtime/streams.ts";

interface MarkerRow {
  stream: string;
  cursorHeight: bigint;
  cursorPage: string | null;
}

function fakeStore(initial?: MarkerRow) {
  const rows = new Map<string, MarkerRow>();
  if (initial) rows.set(initial.stream, initial);
  const upserts: string[] = [];
  const prisma = {
    indexerCheckpoint: {
      findUnique: async ({ where }: { where: { stream: string } }) => rows.get(where.stream) ?? null,
      // Models Postgres INSERT ... ON CONFLICT DO UPDATE: create if absent, else
      // apply `update` (here empty → leave the existing row untouched).
      upsert: async ({ where, create }: { where: { stream: string }; create: MarkerRow; update: unknown }) => {
        upserts.push(where.stream);
        if (!rows.has(where.stream)) rows.set(where.stream, create);
        return rows.get(where.stream)!;
      },
    },
  } as unknown as PrismaClient;
  return { prisma, rows, upserts };
}

const identity = { chainId: "chain-dev", contractAddress: "tp1contract" };

describe("assertChainIsolation", () => {
  it("records the identity marker on first run (atomic upsert, not create)", async () => {
    const { prisma, rows, upserts } = fakeStore();
    await assertChainIsolation(prisma, identity);
    expect(upserts).toEqual([PROVENANCE_MARKER_STREAM]);
    expect(rows.get(PROVENANCE_MARKER_STREAM)).toMatchObject({ cursorPage: "chain-dev|tp1contract" });
  });

  it("is a no-op when the persisted identity matches", async () => {
    const { prisma, rows } = fakeStore({
      stream: PROVENANCE_MARKER_STREAM,
      cursorHeight: 0n,
      cursorPage: "chain-dev|tp1contract",
    });
    await expect(assertChainIsolation(prisma, identity)).resolves.toBeUndefined();
    // upsert leaves the existing row untouched (no overwrite).
    expect(rows.get(PROVENANCE_MARKER_STREAM)?.cursorPage).toBe("chain-dev|tp1contract");
  });

  it("fails closed when the persisted identity differs, without overwriting it", async () => {
    const { prisma, rows } = fakeStore({
      stream: PROVENANCE_MARKER_STREAM,
      cursorHeight: 0n,
      cursorPage: "chain-other|tp1different",
    });
    await expect(assertChainIsolation(prisma, identity)).rejects.toBeInstanceOf(ChainIsolationError);
    // The foreign marker is preserved (empty `update`), not clobbered.
    expect(rows.get(PROVENANCE_MARKER_STREAM)?.cursorPage).toBe("chain-other|tp1different");
  });

  it("is idempotent across repeated boots with the same identity", async () => {
    const { prisma } = fakeStore();
    await assertChainIsolation(prisma, identity);
    await expect(assertChainIsolation(prisma, identity)).resolves.toBeUndefined();
  });
});
