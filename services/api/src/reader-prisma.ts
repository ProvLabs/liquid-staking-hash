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
  derivePayoutStats,
  derivePortfolio,
  deriveHeads,
  deriveMetrics,
  deriveValidatorsPayload,
  navPriceNhash,
  payoutDurationSeconds,
  PAYOUT_STATS_WINDOW_DAYS,
  toAlertArrearsFact,
  toAlertIncidentFact,
  toAlertRedemptionFact,
  toBridgedSupplyRow,
  toEpochRow,
  toIncidentRow,
  toMarketSample,
  toSafeInt,
  toTransactionRow,
  type ValidatorEpochFacts,
} from "./derive.ts";
import type { EpochStepFact } from "./portfolio-metrics.ts";
import type { Heads, IndexedReader } from "./reader.ts";
import type { Pagination } from "./query.ts";
import type { TransactionFacts } from "./derive.ts";
import type {
  AlertArrearsFact,
  AlertIncidentFact,
  AlertRedemptionFact,
  EpochRow,
  IncidentKind,
  IncidentRow,
  IncidentSeverity,
  MarketSummary,
  PayoutStats,
  PortfolioSummary,
  ProgramMetrics,
  TransactionKind,
  TransactionRow,
  ValidatorsPayload,
} from "@nvhash/api-types";

/** Prisma Decimal(39,0) → bigint (always integral; no float is ever built). */
function toBigint(value: { toFixed(dp: number): string }): bigint {
  return BigInt(value.toFixed(0));
}

interface TransactionRowScalars {
  txhash: string;
  msgIndex: number;
  address: string;
  kind: string;
  shares: { toFixed(dp: number): string };
  nhash: { toFixed(dp: number): string };
  navAtHeight: { toFixed(dp: number): string };
  height: bigint;
  blockTime: Date;
}

/** One transaction row → fold facts (the shared per-row mapping). */
function toTxFacts(r: TransactionRowScalars): TransactionFacts {
  return {
    txhash: r.txhash,
    msgIndex: r.msgIndex,
    address: r.address,
    kind: r.kind as TransactionKind,
    shares: toBigint(r.shares),
    nhash: toBigint(r.nhash),
    navAtHeight: toBigint(r.navAtHeight),
    height: r.height,
    blockTime: r.blockTime,
  };
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
      // The three reads are independent, so they run concurrently (PR #13
      // review): /metrics latency is the slowest of them, not their sum.
      const [distinct, first, epochCount] = await Promise.all([
        prisma.$queryRaw<Array<{ count: bigint }>>(
          Prisma.sql`SELECT COUNT(DISTINCT "address")::bigint AS count FROM "indexed"."transactions"`,
        ),
        prisma.transaction.findFirst({
          orderBy: { blockTime: "asc" },
          select: { blockTime: true },
        }),
        prisma.epochSnapshot.count(),
      ]);
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

    async payoutStats(): Promise<PayoutStats> {
      // Recent terminal cohort (§9.5.3, no epoch-index column → rolling
      // window, Q4 delivery). The window also bounds the row set. Terminal =
      // matured or expedited (a refund-only request never paid out).
      const cutoff = new Date(Date.now() - PAYOUT_STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const [rows, epochCount] = await Promise.all([
        prisma.redemptionRequest.findMany({
          where: {
            status: { in: ["matured", "expedited"] },
            OR: [{ expeditedAt: { gte: cutoff } }, { maturedAt: { gte: cutoff } }],
          },
          select: { enqueuedAt: true, expeditedAt: true, maturedAt: true },
        }),
        prisma.epochSnapshot.count(),
      ]);
      const durations: number[] = [];
      for (const r of rows) {
        const d = payoutDurationSeconds({
          requestId: "",
          owner: "",
          shares: 0n,
          status: "matured",
          enqueuedAt: r.enqueuedAt,
          expeditedAt: r.expeditedAt,
          maturedAt: r.maturedAt,
          refundedAt: null,
          lastHeight: 0n,
          lastTxhash: "",
        });
        if (d !== null) durations.push(d);
      }
      return derivePayoutStats(durations, epochCount);
    },

    async portfolioFor(address: string): Promise<PortfolioSummary> {
      const [first, count, active] = await Promise.all([
        prisma.transaction.findFirst({
          where: { address },
          orderBy: { blockTime: "asc" },
          select: { blockTime: true },
        }),
        prisma.transaction.count({ where: { address } }),
        prisma.redemptionRequest.findMany({
          where: { owner: address, status: { in: ["enqueued", "expedited"] } },
          orderBy: { enqueuedAt: "desc" },
        }),
      ]);
      return derivePortfolio(
        address,
        first?.blockTime ?? null,
        count,
        active.map((r) => ({
          requestId: r.requestId,
          owner: r.owner,
          shares: toBigint(r.shares),
          status: r.status,
          enqueuedAt: r.enqueuedAt,
          expeditedAt: r.expeditedAt,
          maturedAt: r.maturedAt,
          refundedAt: r.refundedAt,
          lastHeight: r.lastHeight,
          lastTxhash: r.lastTxhash,
        })),
      );
    },

    async transactionsFor(address: string, page: Pagination): Promise<TransactionRow[]> {
      const rows = await prisma.transaction.findMany({
        where: { address },
        orderBy: [{ height: "desc" }, { msgIndex: "desc" }],
        skip: page.offset,
        take: page.limit,
      });
      return rows.map((r) => toTransactionRow(toTxFacts(r)));
    },

    async transactionsAscFor(address: string): Promise<TransactionFacts[]> {
      // Fixed chunk, loop until a short page: the full history is bounded per
      // query, so no single SELECT scans an address's entire (unbounded) log.
      const CHUNK = 1000;
      const facts: TransactionFacts[] = [];
      for (let skip = 0; ; skip += CHUNK) {
        const rows = await prisma.transaction.findMany({
          where: { address },
          orderBy: [{ height: "asc" }, { msgIndex: "asc" }],
          skip,
          take: CHUNK,
        });
        for (const r of rows) facts.push(toTxFacts(r));
        if (rows.length < CHUNK) break;
      }
      return facts;
    },

    async listEpochsAsc(): Promise<EpochStepFact[]> {
      // Same chunk-until-short-page pattern as transactionsAscFor: epochs are
      // calendar-month (small in practice) but no SELECT is left unbounded.
      const CHUNK = 1000;
      const facts: EpochStepFact[] = [];
      for (let skip = 0; ; skip += CHUNK) {
        const rows = await prisma.epochSnapshot.findMany({
          orderBy: { epochIndex: "asc" },
          skip,
          take: CHUNK,
          select: {
            epochIndex: true,
            endedAtSeconds: true,
            tvvAfter: true,
            totalShares: true,
            netAprBps: true,
            endHeight: true,
          },
        });
        for (const r of rows) {
          facts.push({
            epochIndex: r.epochIndex,
            endedAtSeconds: r.endedAtSeconds,
            tvvAfter: toBigint(r.tvvAfter),
            totalShares: toBigint(r.totalShares),
            netAprBps: r.netAprBps,
            endHeight: r.endHeight,
          });
        }
        if (rows.length < CHUNK) break;
      }
      return facts;
    },

    async redemptionsChangedSince(sinceHeight: number, limit: number): Promise<AlertRedemptionFact[]> {
      // Rows whose last lifecycle height is past the cursor, ascending by
      // height so the notifier advances its cursor monotonically. `take`
      // bounds the page; the `@@index([lastHeight])` migration on this branch
      // keeps the range scan cheap.
      const rows = await prisma.redemptionRequest.findMany({
        where: { lastHeight: { gt: BigInt(sinceHeight) } },
        orderBy: [{ lastHeight: "asc" }, { requestId: "asc" }],
        take: limit,
      });
      return rows.map((r) =>
        toAlertRedemptionFact({
          requestId: r.requestId,
          owner: r.owner,
          shares: toBigint(r.shares),
          status: r.status,
          enqueuedAt: r.enqueuedAt,
          expeditedAt: r.expeditedAt,
          maturedAt: r.maturedAt,
          refundedAt: r.refundedAt,
          lastHeight: r.lastHeight,
          lastTxhash: r.lastTxhash,
        }),
      );
    },

    async incidentsSince(sinceId: number, limit: number): Promise<AlertIncidentFact[]> {
      // Ascending by id past the cursor. No payload passthrough (plan §2.3):
      // the notifier needs identity, so only id + (kind, dedupeKey) + open
      // facts are selected — never the incident payload.
      const rows = await prisma.incident.findMany({
        where: { id: { gt: BigInt(sinceId) } },
        orderBy: { id: "asc" },
        take: limit,
        select: {
          id: true,
          kind: true,
          severity: true,
          dedupeKey: true,
          openedAt: true,
          openedHeight: true,
        },
      });
      return rows.map((r) =>
        toAlertIncidentFact({
          id: r.id,
          kind: r.kind as IncidentKind,
          severity: r.severity as IncidentSeverity,
          dedupeKey: r.dedupeKey,
          openedAt: r.openedAt,
          openedHeight: r.openedHeight,
        }),
      );
    },

    async latestArrears(): Promise<AlertArrearsFact[]> {
      // The latest sampled epoch bounds the scan (arrears is a point-in-time
      // "who owes now" read, not a history). No epoch → no arrears.
      const latest = await prisma.validatorEpoch.aggregate({ _max: { epochIndex: true } });
      const epochIndex = latest._max.epochIndex;
      if (epochIndex === null) return [];
      const [rows, registry] = await Promise.all([
        prisma.validatorEpoch.findMany({
          where: { epochIndex, commissionDue: { gt: 0 } },
          orderBy: { valoper: "asc" },
          select: { valoper: true, epochIndex: true, commissionDue: true },
        }),
        // Active registry rows only: an unregistered validator has no operator
        // session to alert (plan §2.3 — the join excludes unregisteredAt rows).
        prisma.validatorRegistry.findMany({
          where: { unregisteredAt: null },
          select: { valoper: true, operator: true },
        }),
      ]);
      const operatorByValoper = new Map(registry.map((r) => [r.valoper, r.operator]));
      const facts: AlertArrearsFact[] = [];
      for (const r of rows) {
        const operator = operatorByValoper.get(r.valoper);
        if (operator === undefined) continue; // unregistered → excluded
        facts.push(
          toAlertArrearsFact({
            valoper: r.valoper,
            operator,
            epochIndex: r.epochIndex,
            commissionDue: toBigint(r.commissionDue),
          }),
        );
      }
      return facts;
    },

    close: () => prisma.$disconnect(),
  };
}
