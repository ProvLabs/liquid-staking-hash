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
  const creates: MarkerRow[] = [];
  const prisma = {
    indexerCheckpoint: {
      findUnique: async ({ where }: { where: { stream: string } }) => rows.get(where.stream) ?? null,
      create: async ({ data }: { data: MarkerRow }) => {
        rows.set(data.stream, data);
        creates.push(data);
        return data;
      },
    },
  } as unknown as PrismaClient;
  return { prisma, rows, creates };
}

const identity = { chainId: "chain-dev", contractAddress: "tp1contract" };

describe("assertChainIsolation", () => {
  it("records the identity marker on first run", async () => {
    const { prisma, creates } = fakeStore();
    await assertChainIsolation(prisma, identity);
    expect(creates).toEqual([
      { stream: PROVENANCE_MARKER_STREAM, cursorHeight: 0n, cursorPage: "chain-dev|tp1contract" },
    ]);
  });

  it("is a no-op when the persisted identity matches", async () => {
    const { prisma, creates } = fakeStore({
      stream: PROVENANCE_MARKER_STREAM,
      cursorHeight: 0n,
      cursorPage: "chain-dev|tp1contract",
    });
    await expect(assertChainIsolation(prisma, identity)).resolves.toBeUndefined();
    expect(creates).toEqual([]); // no re-create
  });

  it("fails closed when the persisted identity differs", async () => {
    const { prisma } = fakeStore({
      stream: PROVENANCE_MARKER_STREAM,
      cursorHeight: 0n,
      cursorPage: "chain-other|tp1different",
    });
    await expect(assertChainIsolation(prisma, identity)).rejects.toBeInstanceOf(ChainIsolationError);
  });
});
