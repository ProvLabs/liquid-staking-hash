// Prisma-backed IndexedReader over @nvhash/db-indexed (app plan PR 3.1).
//
// A thin query-and-convert shell: every mapping to API shapes lives in the
// pure derive.ts layer; this file only runs SELECTs and converts Prisma
// scalars (Decimal → bigint via toFixed(0), the store.ts precedent — the JS
// float domain is never crossed on an amount).
//
// Connects with the DATABASE_URL the config validated — the SELECT-only
// `api_reader` role (ADR-001 Decision 1). Read-only is enforced by the role's
// grants (grant-boundary CI gate), not trusted to this code; this module
// still contains no write call of any kind. Loaded via dynamic import from
// main() so the DB-free unit/contract suite never touches the generated
// client (plan §4: `pnpm -r run test` stays Postgres-free).

import { Prisma, PrismaClient } from "@nvhash/db-indexed";
import {
  deriveHeads,
  deriveMetrics,
  deriveValidatorsPayload,
  navPriceNhash,
  toBridgedSupplyRow,
  toEpochRow,
  toIncidentRow,
  toMarketSample,
  toSafeInt,
  type ValidatorEpochFacts,
} from "./derive.ts";
import type { Heads, IndexedReader } from "./reader.ts";
import type { Pagination } from "./query.ts";
import type {
  EpochRow,
  IncidentRow,
  MarketSummary,
  ProgramMetrics,
  ValidatorsPayload,
} from "@nvhash/api-types";

/** Prisma Decimal(39,0) → bigint (always integral; no float is ever built). */
function toBigint(value: { toFixed(dp: number): string }): bigint {
  return BigInt(value.toFixed(0));
}

/** Reserved `meta:`-prefixed checkpoint rows are markers, not worker cursors. */
const META_PREFIX = "meta:";

export interface PrismaReader extends IndexedReader {
  close(): Promise<void>;
}

export function createPrismaReader(databaseUrl: string): PrismaReader {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

  async function maxWorkerCheckpoint(): Promise<bigint | null> {
    const rows = await prisma.indexerCheckpoint.findMany({
      select: { stream: true, cursorHeight: true },
    });
    let max: bigint | null = null;
    for (const row of rows) {
      if (row.stream.startsWith(META_PREFIX)) continue;
      if (max === null || row.cursorHeight > max) max = row.cursorHeight;
    }
    return max;
  }

  return {
    async heads(): Promise<Heads> {
      const run = await prisma.reconcilerRun.findFirst({
        orderBy: { ranAt: "desc" },
        select: { chainHeight: true, indexedHeight: true },
      });
      if (run !== null) return deriveHeads(run, null);
      return deriveHeads(null, await maxWorkerCheckpoint());
    },

    async programMetrics(): Promise<ProgramMetrics> {
      const indexed = (await maxWorkerCheckpoint()) !== null;
      if (!indexed) {
        return deriveMetrics({ indexed: false, participantCount: 0, firstActivityAt: null, epochCount: 0 });
      }
      // COUNT(DISTINCT …) stays in SQL so the row set never crosses the wire
      // (a groupBy would materialize every address). Tagged template — no
      // string interpolation reaches the query (SECURITY.md input handling).
      const distinct = await prisma.$queryRaw<Array<{ count: bigint }>>(
        Prisma.sql`SELECT COUNT(DISTINCT "address")::bigint AS count FROM "indexed"."transactions"`,
      );
      const first = await prisma.transaction.findFirst({
        orderBy: { blockTime: "asc" },
        select: { blockTime: true },
      });
      const epochCount = await prisma.epochSnapshot.count();
      return deriveMetrics({
        indexed: true,
        participantCount: toSafeInt(distinct[0]?.count ?? 0n, "participant_count"),
        firstActivityAt: first?.blockTime ?? null,
        epochCount,
      });
    },

    async listEpochs(page: Pagination): Promise<EpochRow[]> {
      const rows = await prisma.epochSnapshot.findMany({
        orderBy: { epochIndex: "desc" },
        skip: page.offset,
        take: page.limit,
        select: {
          epochIndex: true,
          endedAtSeconds: true,
          tvvAfter: true,
          totalShares: true,
          netAprBps: true,
        },
      });
      return rows.map((r) =>
        toEpochRow({
          epochIndex: r.epochIndex,
          endedAtSeconds: r.endedAtSeconds,
          tvvAfter: toBigint(r.tvvAfter),
          totalShares: toBigint(r.totalShares),
          netAprBps: r.netAprBps,
        }),
      );
    },

    async listIncidents(page: Pagination): Promise<IncidentRow[]> {
      const rows = await prisma.incident.findMany({
        orderBy: [{ openedAt: "desc" }, { id: "desc" }],
        skip: page.offset,
        take: page.limit,
        select: { kind: true, severity: true, openedAt: true, closedAt: true, openedHeight: true },
      });
      return rows.map(toIncidentRow);
    },

    async listValidators(): Promise<ValidatorsPayload> {
      const registry = await prisma.validatorRegistry.findMany({
        orderBy: [{ moniker: "asc" }, { valoper: "asc" }],
        select: { valoper: true, moniker: true, unregisteredAt: true },
      });
      // Latest sampled epoch per validator: ordered desc within each valoper,
      // `distinct` keeps the first (= latest) row per group. The set is
      // bounded by the contract's validator cap, so this stays small.
      const latest = await prisma.validatorEpoch.findMany({
        orderBy: [{ valoper: "asc" }, { epochIndex: "desc" }],
        distinct: ["valoper"],
        select: {
          valoper: true,
          epochIndex: true,
          uptimeBps: true,
          eligible: true,
          failingReasons: true,
          programDelegation: true,
          commissionDue: true,
        },
      });
      const byValoper = new Map<string, ValidatorEpochFacts>(
        latest.map((row) => [
          row.valoper,
          {
            valoper: row.valoper,
            epochIndex: row.epochIndex,
            uptimeBps: row.uptimeBps,
            eligible: row.eligible,
            failingReasons: row.failingReasons,
            programDelegation: toBigint(row.programDelegation),
            commissionDue: toBigint(row.commissionDue),
          },
        ]),
      );
      return deriveValidatorsPayload(registry, byValoper);
    },

    async latestMarket(): Promise<MarketSummary> {
      const raw = await prisma.marketSample.findFirst({
        orderBy: [{ sampledAt: "desc" }, { id: "desc" }],
        select: { venue: true, pool: true, price: true, depthBands: true, sampledAt: true },
      });
      // Latest reading per remote chain (ordered desc within each chain,
      // `distinct` keeps the first = latest — the validators pattern).
      const bridged = await prisma.bridgeSupplySample.findMany({
        orderBy: [{ chain: "asc" }, { sampledAt: "desc" }, { id: "desc" }],
        distinct: ["chain"],
        select: { chain: true, remoteSupply: true, sampledAt: true },
      });
      let sample = null;
      if (raw !== null) {
        // [R6] the premium denominator is the NAV current AT THE SAMPLE'S
        // time: the last epoch settled at or before sampledAt — never a
        // newer NAV retroactively applied to an older price.
        const sampledAtSeconds = BigInt(Math.floor(raw.sampledAt.getTime() / 1000));
        const navEpoch = await prisma.epochSnapshot.findFirst({
          where: { endedAtSeconds: { lte: sampledAtSeconds } },
          orderBy: { epochIndex: "desc" },
          select: { tvvAfter: true, totalShares: true },
        });
        const nav =
          navEpoch === null ? null : navPriceNhash(toBigint(navEpoch.tvvAfter), toBigint(navEpoch.totalShares));
        sample = toMarketSample(
          {
            venue: raw.venue,
            pool: raw.pool,
            priceNhash: toBigint(raw.price),
            depthBands: raw.depthBands,
            sampledAt: raw.sampledAt,
          },
          nav,
        );
      }
      return {
        sample,
        bridged_supply: bridged.map((row) =>
          toBridgedSupplyRow({ chain: row.chain, remoteSupply: toBigint(row.remoteSupply), sampledAt: row.sampledAt }),
        ),
      };
    },

    close: () => prisma.$disconnect(),
  };
}
