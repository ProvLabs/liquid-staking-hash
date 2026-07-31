// Prisma-backed IndexedReader over @nvhash/db-indexed.
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
// client (: `pnpm -r run test` stays Postgres-free).

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
import { MAX_GOV_POLICIES, MAX_GOV_VOTES_PER_PROPOSAL } from "@nvhash/api-types";
import type { Pagination } from "./query.ts";
import type {
  EpochBoundary,
  GovPolicyFacts,
  GovProposalFacts,
  GovVoteFacts,
  OperatorEpochFacts,
  OperatorPaymentFacts,
  OperatorPaymentTotalFacts,
  OperatorRegistryFacts,
  TransactionFacts,
} from "./derive.ts";
import type {
  AlertArrearsFact,
  AlertIncidentFact,
  AlertRedemptionFact,
  EpochRow,
  IncidentKind,
  IncidentRow,
  IncidentSeverity,
  MarketSummary,
  OperatorPaymentType,
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

// ── Keyset export walks (2026-07-28 review) ─────────────────────────────────
//
// Both §14.11 exports serve a COMPLETE history ascending by `(height,
// msgIndex)`. They must not use `OFFSET` (each chunk re-scans and discards
// every prior row — quadratic), and they must not use Prisma's two-arm
// `OR` cursor either, which is the subtler trap and the reason these are raw:
//
//   `OR: [{height: {gt: h}}, {height: h, msgIndex: {gt: m}}]` is CORRECT but
//   Postgres cannot push it into an index condition. Measured at 300 000 rows,
//   it degraded to `Index Cond: (valoper = ...)` + `Filter: (height > ... OR
//   ...)` with `Rows Removed by Filter: 250 118` — i.e. every chunk rescans the
//   group from its start, so the walk stays quadratic. It only looks fast when
//   sampled at the very END of a walk, where few rows remain.
//
//   The SQL row comparison `("height", "msgIndex") > (h, m)` is what Postgres
//   turns into a real range bound: `Index Cond: (valoper = ... AND ROW(height,
//   "msgIndex") > ROW(...))`, ~42 buffers / 0.2 ms per chunk, FLAT at every
//   depth. Prisma's query builder cannot express it, hence `$queryRaw`.
//
// Tagged templates throughout — every value is a bound parameter, no string
// interpolation reaches the query (SECURITY.md input handling), the
// `programMetrics` precedent. The row comparison is correct but unindexed
// unless the walked sort key is covered to its tie-break column — the
// `@@index([valoper, height, msgIndex, ordinal])` and
// `@@index([address, height, msgIndex])` declared in the indexer's
// `operator_payments.prisma` and `transactions.prisma`.

/**
 * A cursor on an export's sort key. `ordinal` completes it for
 * `operator_payments`, where one message can carry several payments — without
 * it a cursor at `(height, msgIndex)` would step straight over the siblings
 *. `transactions` has one row per message, so it passes 0.
 */
interface KeysetCursor {
  readonly height: bigint;
  readonly msgIndex: number;
  readonly ordinal: number;
}

/** The cursor predicate, or nothing for the first chunk. Casts are explicit so
 * the comparison's parameter types cannot be inferred into something the index
 * condition would reject. */
function keysetCursor(cursor: KeysetCursor | null, columns: Prisma.Sql): Prisma.Sql {
  return cursor === null
    ? Prisma.empty
    : Prisma.sql`AND ${columns} > (${cursor.height}::bigint, ${cursor.msgIndex}::int, ${cursor.ordinal}::int)`;
}

/** The payments sort key; `transactions` uses a constant 0 for the ordinal so
 * both walks share one cursor shape and one helper. */
const PAYMENT_KEY = Prisma.sql`("height", "msgIndex", "ordinal")`;
const TX_KEY = Prisma.sql`("height", "msgIndex", 0)`;

/** Rows per chunk. Bounds both the query and the caller's peak memory. */
const KEYSET_CHUNK = 1000;

/**
 * Walk a history by keyset, yielding mapped chunks. Nothing accumulates: the
 * consumer renders each chunk and drops it, so peak memory is one chunk
 * regardless of history size. `operator_payments` and `transactions` are both
 * append-only, so a keyset walk cannot skip a row.
 */
async function* keysetStream<Row extends { height: bigint; msgIndex: number; ordinal?: number }, Fact>(
  page: (cursor: KeysetCursor | null, take: number) => Promise<Row[]>,
  toFact: (row: Row) => Fact,
): AsyncIterable<readonly Fact[]> {
  let cursor: KeysetCursor | null = null;
  for (;;) {
    const rows = await page(cursor, KEYSET_CHUNK);
    if (rows.length === 0) return;
    yield rows.map(toFact);
    if (rows.length < KEYSET_CHUNK) return;
    const last = rows[rows.length - 1]!;
    cursor = { height: last.height, msgIndex: last.msgIndex, ordinal: last.ordinal ?? 0 };
  }
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

interface OperatorEpochScalars {
  valoper: string;
  epochIndex: bigint;
  uptimeBps: number;
  eligible: boolean;
  failingReasons: string[];
  tip: { toFixed(dp: number): string };
  commissionAccrued: { toFixed(dp: number): string };
  commissionPaid: { toFixed(dp: number): string };
  commissionDue: { toFixed(dp: number): string };
  programDelegation: { toFixed(dp: number): string };
  height: bigint;
  observedAt: Date;
}

/** One `validator_epochs` row → the FULL operator facts (M6.4). The public
 * projection's narrower `ValidatorEpochFacts` stays untouched: operator
 * economics never leave the server on the public page. */
function toOperatorEpochFacts(r: OperatorEpochScalars): OperatorEpochFacts {
  return {
    valoper: r.valoper,
    epochIndex: r.epochIndex,
    uptimeBps: r.uptimeBps,
    eligible: r.eligible,
    failingReasons: r.failingReasons,
    tip: toBigint(r.tip),
    commissionAccrued: toBigint(r.commissionAccrued),
    commissionPaid: toBigint(r.commissionPaid),
    commissionDue: toBigint(r.commissionDue),
    programDelegation: toBigint(r.programDelegation),
    height: r.height,
    observedAt: r.observedAt,
  };
}

interface OperatorPaymentScalars {
  txhash: string;
  msgIndex: number;
  ordinal: number;
  valoper: string;
  payer: string;
  paymentType: string;
  amount: { toFixed(dp: number): string };
  height: bigint;
  occurredAt: Date;
}

function toOperatorPaymentFacts(r: OperatorPaymentScalars): OperatorPaymentFacts {
  return {
    txhash: r.txhash,
    msgIndex: r.msgIndex,
    ordinal: r.ordinal,
    valoper: r.valoper,
    payer: r.payer,
    paymentType: r.paymentType as OperatorPaymentType,
    amount: toBigint(r.amount),
    height: r.height,
    occurredAt: r.occurredAt,
  };
}

/** Reserved `meta:`-prefixed checkpoint rows are markers, not worker cursors. */
const META_PREFIX = "meta:";

export interface PrismaReader extends IndexedReader {
  close(): Promise<void>;
}

export function createPrismaReader(databaseUrl: string): PrismaReader {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

  /** The address history keyset walk — shared by the CSV stream and the
   * array-returning `transactionsAscFor` the metrics fold needs. */
  function txAscStream(address: string): AsyncIterable<readonly TransactionFacts[]> {
    return keysetStream(
      (cursor, take) => prisma.$queryRaw<TransactionRowScalars[]>`
        SELECT "txhash", "msgIndex", "address", "kind"::text AS "kind",
               "shares", "nhash", "navAtHeight", "height", "blockTime"
        FROM "indexed"."transactions"
        WHERE "address" = ${address} ${keysetCursor(cursor, TX_KEY)}
        ORDER BY "height" ASC, "msgIndex" ASC
        LIMIT ${take}`,
      toTxFacts,
    );
  }

  /** Prisma row -> the pure mappers' fact shape. Decimal(39,0) tally counts and
   * weights cross as BIGINT, never through a JS number: they are unbounded member
   * weight sums with no protocol ceiling. */
  function toGovProposalFacts(r: {
    proposalId: bigint;
    groupPolicyAddress: string;
    groupId: bigint;
    proposers: string[];
    status: string;
    executorResult: string;
    metadata: string | null;
    title: string;
    summary: string;
    messages: unknown;
    submitTime: Date;
    votingPeriodEnd: Date;
    yesCount: Prisma.Decimal;
    noCount: Prisma.Decimal;
    abstainCount: Prisma.Decimal;
    noWithVetoCount: Prisma.Decimal;
    groupVersion: bigint;
    groupPolicyVersion: bigint;
    decisionPolicy: unknown;
    observedHeight: bigint;
    observedAt: Date;
    height: bigint | null;
    txhash: string | null;
    prunedAtHeight: bigint | null;
  }): GovProposalFacts {
    return {
      ...r,
      yesCount: toBigint(r.yesCount),
      noCount: toBigint(r.noCount),
      abstainCount: toBigint(r.abstainCount),
      noWithVetoCount: toBigint(r.noWithVetoCount),
    };
  }

  function toGovVoteFacts(r: {
    proposalId: bigint;
    voter: string;
    option: string;
    metadata: string | null;
    weight: Prisma.Decimal | null;
    submitTime: Date;
    height: bigint | null;
    txhash: string | null;
  }): GovVoteFacts {
    return {
      ...r,
      // Null stays null. A weight the indexer could not recover must never arrive
      // as a 0 that reads as "this member's vote counted for nothing".
      weight: r.weight === null ? null : toBigint(r.weight),
    };
  }

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

  /**
   * First height the governance stream ingested. Read from the stream's own
   * configured start rather than guessed: `indexed_from_height` exists so a page
   * cannot imply completeness it lacks, and a wrong value there is worse than a
   * null. Null when the stream has never committed a window.
   */
  async function governanceStreamStart(): Promise<number | null> {
    const row = await prisma.indexerCheckpoint.findUnique({ where: { stream: "governance" } });
    if (row === null) return null;
    // The worker's start height is 1 (D13). A committed cursor therefore certifies
    // coverage from 1 up to that cursor; anything pruned before the stream existed
    // is unrecoverable, which is exactly what this field warns a reader about.
    return 1;
  }

  return {
    // --- governance ------------------------------------------------

    async listGovProposals(page, filter) {
      // Newest first by id: x/group assigns ids monotonically chain-global, so id
      // order IS submission order and no tie-break is needed. Deliberately NOT
      // keyset-paged: proposals per policy number in the tens, not the 300 000
      // `operator_payments` rows that forced row-comparison streaming, and
      // cargo-culting that machinery onto a structurally tiny table would add
      // `$queryRaw` for nothing.
      const where = {
        ...(filter.policy === undefined ? {} : { groupPolicyAddress: filter.policy }),
        // Stored SCREAMING, filtered lower-case on the wire.
        ...(filter.status === undefined ? {} : { status: filter.status.toUpperCase() }),
      };
      const [rows, indexedFrom] = await Promise.all([
        prisma.govProposal.findMany({
          where,
          orderBy: { proposalId: "desc" },
          skip: page.offset,
          take: page.limit,
        }),
        governanceStreamStart(),
      ]);
      return {
        proposals: rows.map(toGovProposalFacts),
        indexedFromHeight: indexedFrom,
      };
    },

    async govProposal(proposalId) {
      const row = await prisma.govProposal.findUnique({ where: { proposalId } });
      // Null, never a fabricated shell: "the mirror never saw this id" is a
      // different answer from "it exists with no votes", and the route turns this
      // into a 404 rather than an empty 200.
      if (row === null) return null;
      const votes = await prisma.govVote.findMany({
        where: { proposalId },
        // Deterministic order so a trimmed list is trimmed reproducibly.
        orderBy: [{ submitTime: "asc" }, { voter: "asc" }],
        // Read ONE past the wire bound so the route can flag truncation without a
        // second COUNT query — the flag has to be honest, so it needs evidence
        // that a further row exists.
        take: MAX_GOV_VOTES_PER_PROPOSAL + 1,
      });
      return { proposal: toGovProposalFacts(row), votes: votes.map(toGovVoteFacts) };
    },

    async listGovPolicies() {
      // Aggregated in SQL rather than by folding rows in JS: the group-by is over
      // the whole mirror, and materializing every proposal to count them would
      // scale with history for a payload bounded at a few dozen rows.
      const grouped = await prisma.govProposal.groupBy({
        by: ["groupPolicyAddress"],
        _count: { proposalId: true },
        _max: { observedHeight: true, proposalId: true },
        orderBy: { _max: { observedHeight: "desc" } },
        take: MAX_GOV_POLICIES,
      });
      const facts: GovPolicyFacts[] = [];
      for (const g of grouped) {
        const newestId = g._max.proposalId;
        if (newestId === null) continue;
        // The decision policy is a SNAPSHOT off the newest proposal, not a live
        // read: the API has no chain client, and the live rule is 7.2's to fetch.
        const newest = await prisma.govProposal.findUnique({
          where: { proposalId: newestId },
          select: { groupId: true, decisionPolicy: true },
        });
        facts.push({
          address: g.groupPolicyAddress,
          groupId: newest?.groupId ?? 0n,
          proposalCount: g._count.proposalId,
          lastSeenHeight: g._max.observedHeight ?? 0n,
          decisionPolicy: newest?.decisionPolicy ?? null,
        });
      }
      return facts;
    },

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
      // The three reads are independent, so they run concurrently:
      // /metrics latency is the slowest of them, not their sum.
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
      // Latest sampled epoch per validator, via `DISTINCT ON` (2026-07-28
      // review). This is the PUBLIC endpoint and had the same non-pushed-down
      // `distinct` as `latestOperatorEpochs`: the validator SET is capped at
      // 100, but the rows scanned were `100 × epochs_ever`, all transferred to
      // return 100. The cap bounds the result, never the scan.
      const latest = await prisma.$queryRaw<
        Array<{
          valoper: string;
          epochIndex: bigint;
          uptimeBps: number;
          eligible: boolean;
          failingReasons: string[];
          programDelegation: { toFixed(dp: number): string };
          commissionDue: { toFixed(dp: number): string };
        }>
      >`
        SELECT DISTINCT ON ("valoper")
               "valoper", "epochIndex", "uptimeBps", "eligible", "failingReasons",
               "programDelegation", "commissionDue"
        FROM "indexed"."validator_epochs"
        ORDER BY "valoper" ASC, "epochIndex" DESC`;
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

    transactionsAscStream: txAscStream,

    async transactionsAscFor(address: string): Promise<TransactionFacts[]> {
      // `derivePortfolioMetrics` is a fold over the WHOLE history, so this one
      // genuinely needs the array — but it is built by draining the keyset
      // stream, so the quadratic OFFSET walk is gone here too. The CSV export
      // uses the stream directly and never materializes.
      const facts: TransactionFacts[] = [];
      for await (const chunk of txAscStream(address)) facts.push(...chunk);
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

    async redemptionsChangedSince(sinceHeight: number, afterId: string, limit: number): Promise<AlertRedemptionFact[]> {
      // Compound keyset pagination: `(lastHeight, requestId) > (sinceHeight,
      // afterId)` in `(lastHeight asc, requestId asc)` order, so a same-height
      // burst larger than one page (mass maturation at an epoch settlement)
      // pages through completely — a strictly-greater height cursor alone
      // would skip the overflow forever. `take` bounds the page; the
      // `@@index([lastHeight])` migration on this branch keeps the scan cheap.
      const height = BigInt(sinceHeight);
      const rows = await prisma.redemptionRequest.findMany({
        where: {
          OR: [
            { lastHeight: { gt: height } },
            { lastHeight: height, requestId: { gt: afterId } },
          ],
        },
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
      // Ascending by id past the cursor. No payload passthrough:
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
        // session to alert (— the join excludes unregisteredAt rows).
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

    // --- operator surface --------------------------------------------

    async operatorValopers(address: string): Promise<OperatorRegistryFacts[]> {
      // THE ownership mapping. Every other operator read is called with a
      // valoper that came from this list, so the address→valoper enforcement is
      // one query in one place — not a filter repeated per route.
      const rows = await prisma.validatorRegistry.findMany({
        where: { operator: address },
        orderBy: [{ moniker: "asc" }, { valoper: "asc" }],
        select: {
          valoper: true,
          operator: true,
          moniker: true,
          enrolledAt: true,
          unregisteredAt: true,
        },
      });
      return rows;
    },

    async latestOperatorEpochs(valopers: readonly string[]): Promise<OperatorEpochFacts[]> {
      if (valopers.length === 0) return [];
      // `DISTINCT ON`, not Prisma's `distinct` (2026-07-28 review). Prisma does
      // NOT push `distinct` down — the emitted SQL carried no `DISTINCT ON` and
      // no `LIMIT`, so it fetched every epoch row for every valoper across the
      // wire and discarded all but the newest in the query engine: 1 080 rows
      // transferred to return 10, growing as `validators × epochs_ever` with no
      // ceiling in time. `DISTINCT ON` does it in the database, returning
      // exactly one row per valoper.
      const rows = await prisma.$queryRaw<OperatorEpochScalars[]>`
        SELECT DISTINCT ON ("valoper")
               "valoper", "epochIndex", "uptimeBps", "eligible", "failingReasons",
               "tip", "commissionAccrued", "commissionPaid", "commissionDue",
               "programDelegation", "height", "observedAt"
        FROM "indexed"."validator_epochs"
        WHERE "valoper" IN (${Prisma.join([...valopers])})
        ORDER BY "valoper" ASC, "epochIndex" DESC`;
      return rows.map(toOperatorEpochFacts);
    },

    async validatorEpochsFor(valoper: string, page: Pagination): Promise<OperatorEpochFacts[]> {
      const rows = await prisma.validatorEpoch.findMany({
        where: { valoper },
        orderBy: { epochIndex: "desc" },
        skip: page.offset,
        take: page.limit,
      });
      return rows.map(toOperatorEpochFacts);
    },

    async operatorPaymentTotalsFor(
      valopers: readonly string[],
    ): Promise<OperatorPaymentTotalFacts[]> {
      if (valopers.length === 0) return [];
      // Sum in SQL: an operator's lifetime payment history is unbounded, so the
      // rows must never cross the wire just to be added up.
      const grouped = await prisma.operatorPayment.groupBy({
        by: ["valoper", "paymentType"],
        where: { valoper: { in: [...valopers] } },
        _sum: { amount: true },
        _count: { _all: true },
      });
      const byValoper = new Map<string, { commission: bigint; tip: bigint; count: number }>();
      for (const g of grouped) {
        const acc = byValoper.get(g.valoper) ?? { commission: 0n, tip: 0n, count: 0 };
        const sum = g._sum.amount === null ? 0n : toBigint(g._sum.amount);
        if (g.paymentType === "commission") acc.commission += sum;
        else acc.tip += sum;
        acc.count += g._count._all;
        byValoper.set(g.valoper, acc);
      }
      return [...byValoper.entries()].map(([valoper, acc]) => ({
        valoper,
        commissionPaidTotal: acc.commission,
        tipPaidTotal: acc.tip,
        paymentCount: acc.count,
      }));
    },

    async operatorPaymentsFor(valoper: string, page: Pagination): Promise<OperatorPaymentFacts[]> {
      const rows = await prisma.operatorPayment.findMany({
        where: { valoper },
        // The ordinal completes the sort key: without it siblings from one
        // batched message have no defined order between pages.
        orderBy: [{ height: "desc" }, { msgIndex: "desc" }, { ordinal: "desc" }],
        skip: page.offset,
        take: page.limit,
      });
      return rows.map(toOperatorPaymentFacts);
    },

    operatorPaymentsAscStream(valoper: string): AsyncIterable<readonly OperatorPaymentFacts[]> {
      return keysetStream(
        (cursor, take) => prisma.$queryRaw<OperatorPaymentScalars[]>`
          SELECT "txhash", "msgIndex", "ordinal", "valoper", "payer",
                 "paymentType"::text AS "paymentType",
                 "amount", "height", "occurredAt"
          FROM "indexed"."operator_payments"
          WHERE "valoper" = ${valoper} ${keysetCursor(cursor, PAYMENT_KEY)}
          ORDER BY "height" ASC, "msgIndex" ASC, "ordinal" ASC
          LIMIT ${take}`,
        toOperatorPaymentFacts,
      );
    },

    async epochBoundariesAsc(): Promise<EpochBoundary[]> {
      const CHUNK = 1000;
      const boundaries: EpochBoundary[] = [];
      for (let skip = 0; ; skip += CHUNK) {
        const rows = await prisma.epochSnapshot.findMany({
          orderBy: { endHeight: "asc" },
          skip,
          take: CHUNK,
          select: { epochIndex: true, endHeight: true },
        });
        for (const r of rows) boundaries.push({ epochIndex: r.epochIndex, endHeight: r.endHeight });
        if (rows.length < CHUNK) break;
      }
      return boundaries;
    },

    close: () => prisma.$disconnect(),
  };
}
