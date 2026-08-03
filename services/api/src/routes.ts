// The route registry — the single source of truth for what `/api/v1` exposes.
//
// Two invariants make the security posture structural rather than reviewed:
//   1. Every route is `method: "GET"`. There is no way to register a write in
//      this array; the read-only contract test asserts it, and the request
//      handler rejects any non-GET/HEAD verb with 405 before dispatch. This is
// how "no write endpoint of any kind" (SECURITY.md) is enforced.
//   2. Every route declares whether it carries the freshness envelope and what
//      zod schema (if any) bounds its query params. The envelope contract test
//      iterates THIS array, so a new route is automatically held to both the
//      envelope and query-bounds gates — the harness cannot silently miss one.
//
// The public program endpoints read real indexed data through the
// injected `IndexedReader` port (reader.ts) — `emptyReader` when no database
// is configured, so a dataless process still reports the honest null/empty
// state (app-spec §12.1), never a fabricated height or row. Envelope heights
// come from `reader.heads()` (latest reconciler run; worker-checkpoint
// fallback).

import type {
  AdminHolderCohorts,
  AdminIncidentRow,
  AdminProgramHealth,
  AdminUpkeepTimeliness,
  AdminValidatorCohorts,
  FreshnessSource,
  IncidentRow,
  OperatorEpochRow,
  OperatorPaymentRow,
  GovPolicyRow,
  GovProposalDetail,
  GovProposalsPayload,
  OperatorSummary,
  ProgramMetrics,
  EpochRow,
} from "@nvhash/api-types";
import {
  CONCENTRATION_BAND_DEPTH,
  FUNNEL_WINDOW_DAYS,
  MAX_ADMIN_EPOCH_POINTS,
  MAX_ADMIN_RETENTION_CURVES,
  MAX_HOLDER_LIFECYCLES,
  MAX_UPKEEP_SAMPLES,
  MIN_COHORT_SIZE,
} from "@nvhash/api-types";
import type { z } from "zod";
import {
  epochLagSeconds,
  toAdoption,
  toConcentration,
  toHealthPoints,
  toRetentionCurves,
  toUpkeepDistribution,
  toValidatorPoints,
} from "./admin-derive.ts";
import {
  operatorPaymentsCsvHeader,
  operatorPaymentsCsvRows,
  transactionsCsvHeader,
  transactionsCsvRows,
} from "./csv.ts";
import {
  deriveOperatorSummary,
  toAdminIncidentRow,
  toGovPolicyRow,
  toGovProposalDetail,
  toGovProposalRow,
  resolveOwnedValoper,
  toOperatorEpochRow,
  toOperatorPaymentRow,
  toTransactionRow,
  type OperatorPaymentFacts,
} from "./derive.ts";
import { derivePortfolioMetrics } from "./portfolio-metrics.ts";
import {
  alertIncidentsQuerySchema,
  alertRedemptionsQuerySchema,
  govProposalQuerySchema,
  govProposalsQuerySchema,
  type GovProposalQuery,
  type GovProposalsQuery,
  operatorEpochsQuerySchema,
  operatorPaymentsQuerySchema,
  operatorSummaryQuerySchema,
  paginationSchema,
  portfolioQuerySchema,
  transactionsQuerySchema,
  type AlertIncidentsQuery,
  type AlertRedemptionsQuery,
  type OperatorEpochsQuery,
  type OperatorPaymentsQuery,
  type Pagination,
  type TransactionsQuery,
} from "./query.ts";
import type { ApiConfig } from "./config.ts";
import type { IndexedReader } from "./reader.ts";

/** Everything under the versioned prefix lives beneath this base. */
export const API_BASE = "/api/v1";

/** Context handed to a route handler; `query` is the parsed, bounded input. */
export interface RouteContext<Q> {
  readonly query: Q;
  readonly url: URL;
  /** Injectable clock (deterministic in tests); drives `generated_at`. */
  readonly now: () => Date;
  readonly appEnv: ApiConfig["appEnv"];
  /** The indexed-data port — every data read goes through it. */
  readonly reader: IndexedReader;
  /** What `/status` reports as the wired data source. */
  readonly dataSource: "unwired" | "api_reader";
}

/** What an enveloped route returns; the handler wraps it as `{ data, meta }`. */
export interface EnvelopedPayload {
  readonly data: unknown;
  readonly source: FreshnessSource;
  /** Omit / null until a data plane is wired (scaffold reports null). */
  readonly chainHeight?: number | null;
  readonly indexedHeight?: number | null;
}

/**
 * Route authorization requirement (ADR-001 Decision 2), declared IN the
 * registry so enforcement is structural like the envelope gate: the handler
 * pipeline reads this field — a new address-scoped route cannot forget the
 * check, and the cross-address contract tests iterate the registry.
 * - "public": unauthenticated, read-only, rate-limited.
 * - "address": requires an `address:<bech32>` assertion whose scope equals
 *   the route's zod-parsed `?address=` target exactly (mismatch → 403;
 *   absent/expired/invalid assertion → 401).
 * - "internal:notifier": the notifier's read-only surface (ADR-001
 * Decision 3) — never grants address routes.
 * - "admin": the §8.8 admin analytics surface (ADR-001 Decision 2, amendment
 *   2026-07-28). Requires an `admin:<bech32>` assertion. Program-wide, so
 *   there is NO scope↔target match to make — and no other scope kind reaches
 *   it (403), including `address:` for the very address that minted it.
 */
export type RouteAuth = "public" | "address" | "internal:notifier" | "admin";

interface BaseRoute<Q> {
  readonly method: "GET";
  readonly path: string;
  readonly auth: RouteAuth;
  /** Output type is `Q`; the input type is free so `.default()` fields fit. */
  readonly querySchema: z.ZodType<Q, z.ZodTypeDef, unknown> | null;
  readonly summary: string;
}

export interface EnvelopedRoute<Q> extends BaseRoute<Q> {
  readonly enveloped: true;
  /**
   * Returns the payload for envelope wrapping — or a raw `Response` for a
   * non-JSON representation (the CSV export), which the handler passes
   * through with the defensive headers merged ([R3] recorded deviation).
   */
  handle(ctx: RouteContext<Q>): EnvelopedPayload | Response | Promise<EnvelopedPayload | Response>;
}

export interface OperationalRoute<Q> extends BaseRoute<Q> {
  readonly enveloped: false;
  /** Raw JSON body — operational routes (e.g. liveness) are not chain data. */
  handle(ctx: RouteContext<Q>): unknown;
}

/** A registered route with its query type erased for storage in the registry. */
export type Route = EnvelopedRoute<unknown> | OperationalRoute<unknown>;

/** Preserve per-route query typing while erasing it into the registry. */
function defineEnveloped<Q>(route: EnvelopedRoute<Q>): Route {
  return route as unknown as Route;
}
function defineOperational<Q>(route: OperationalRoute<Q>): Route {
  return route as unknown as Route;
}

// --- Routes -----------------------------------------------------------------

/**
 * `GET /api/v1/status` — enveloped service descriptor. `data_source` reports
 * what is actually wired ("api_reader" | "unwired") and the heights come from
 * the reader — the chrome consumes this envelope for the footer
 * freshness line, so it must never claim a plane that is not connected.
 */
const statusRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/status`,
  auth: "public",
  enveloped: true,
  querySchema: null,
  summary: "API service + freshness descriptor",
  handle: async (ctx) => {
    const heads = await ctx.reader.heads();
    return {
      data: {
        service: "nvhash-api",
        api_version: "v1",
        environment: ctx.appEnv,
        data_source: ctx.dataSource,
      },
      source: "indexed",
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/incidents` — enveloped, paginated collection over the
 * reconciler-derived `incidents` (app-spec §9.6; row shape frozen by).
 * A healthy program legitimately has zero incidents; null heights mean no
 * indexer height certifies the list yet (§12.1).
 */
const incidentsRoute = defineEnveloped({
  method: "GET",
  path: `${API_BASE}/incidents`,
  auth: "public",
  enveloped: true,
  querySchema: paginationSchema,
  summary: "Program incident history (paginated)",
  handle: async (ctx) => {
    const [heads, data] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.listIncidents(ctx.query as Pagination),
    ]);
    return {
      data: data satisfies IncidentRow[],
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/metrics` — enveloped program aggregates (participant count,
 * program age, epoch count; app-spec §8.1 proof strip; shape frozen by PR
 * 4.2). `participant_count` is distinct addresses across all transaction
 * kinds ([R5], §9.4 revision note). All-null until a worker stream has
 * committed — the honest "not yet indexed" state (§12.1).
 */
const metricsRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/metrics`,
  auth: "public",
  enveloped: true,
  querySchema: null,
  summary: "Program-level aggregates (participants, age, epochs)",
  handle: async (ctx) => {
    const [heads, data] = await Promise.all([ctx.reader.heads(), ctx.reader.programMetrics()]);
    return {
      data: data satisfies ProgramMetrics,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/epochs` — enveloped, paginated per-epoch history (newest
 * first) from the indexer's `epoch_snapshots`, the series behind the Learn
 * NAV step chart and the §8.5 views (row shape frozen; `nav`
 * widened to `string | null` — an empty-vault epoch has no NAV).
 * A fresh program legitimately has zero settled epochs.
 */
const epochsRoute = defineEnveloped({
  method: "GET",
  path: `${API_BASE}/epochs`,
  auth: "public",
  enveloped: true,
  querySchema: paginationSchema,
  summary: "Per-epoch program history (paginated, newest first)",
  handle: async (ctx) => {
    const [heads, data] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.listEpochs(ctx.query as Pagination),
    ]);
    return {
      data: data satisfies EpochRow[],
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/validators` — the public set view (app-spec §8.6): registry
 * enrollment joined with each validator's latest sampled epoch, plus the
 * set-health aggregates. Shapes frozen by this PR (`ValidatorRow` /
 * `ValidatorSetHealth`, @nvhash/api-types); the public page consumes
 * them. Per-epoch fields are null before the first sample — honest, never a
 * fabricated zero.
 */
const validatorsRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/validators`,
  auth: "public",
  enveloped: true,
  querySchema: null,
  summary: "Program validator set + set-health aggregates",
  handle: async (ctx) => {
    const [heads, data] = await Promise.all([ctx.reader.heads(), ctx.reader.listValidators()]);
    return {
      data,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/market` — the §8.5 secondary-market summary (shapes
 * `MarketSummary`/`MarketSample` frozen in @nvhash/api-types). Market data
 * has no chain-canonical plane, so venue + sample time ride IN the payload,
 * and the premium/discount is computed against the NAV current at the
 * sample's time ([R6], §9.5(4)). With the sampler parked pending
 * §14.3, this serves the honest empty state — the v1 "coming soon" shell
 * (§13 decision 4) with a stable shape ahead of the data.
 */
const marketRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/market`,
  auth: "public",
  enveloped: true,
  querySchema: null,
  summary: "Secondary-market summary (latest sample + bridged supply)",
  handle: async (ctx) => {
    const [heads, data] = await Promise.all([ctx.reader.heads(), ctx.reader.latestMarket()]);
    return {
      data,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/redemptions/stats` — the program-wide typical time-to-payout
 * (app-spec §8.4, §9.5.3, §14.12). PUBLIC and aggregate over the
 * recent terminal-request cohort — no owner keying, so no PII. The ≥ 10-
 * terminal threshold and the epoch cold-start gate are applied in the
 * derivation (median/p90 null below them), and the physical 21–60-day band
 * rides in the payload — the web tier renders the honest state without
 * re-deciding the rule. Honest-empty (`sample_count: 0`, null stats,
 * `cold_start: true`) until data and a completed epoch exist.
 */
const payoutStatsRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/redemptions/stats`,
  auth: "public",
  enveloped: true,
  querySchema: null,
  summary: "Typical time-to-payout (median/p90, gated + banded)",
  handle: async (ctx) => {
    const [heads, data] = await Promise.all([ctx.reader.heads(), ctx.reader.payoutStats()]);
    return {
      data,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/portfolio?address=` — address-scoped (ADR-001
 * Decision 2): the indexed facts for one address — first activity, event
 * count, escrowed shares, active redemptions. Deliberately NO balance and no
 * derived metrics ([R2]: balance is the web tier's live read; cost basis /
 * effective yield). The registry `auth: "address"` declaration is
 * what the handler enforces — reaching this handler means the assertion's
 * scope already equals `?address=` exactly.
 */
const portfolioRoute = defineEnveloped<z.infer<typeof portfolioQuerySchema>>({
  method: "GET",
  path: `${API_BASE}/portfolio`,
  auth: "address",
  enveloped: true,
  querySchema: portfolioQuerySchema,
  summary: "Address-scoped indexed portfolio facts",
  handle: async (ctx) => {
    const [heads, data] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.portfolioFor(ctx.query.address),
    ]);
    return {
      data,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/portfolio/metrics?address=` — address-scoped: the
 * derived cost-basis, realized-gain, effective-yield, and accrual figures for
 * one address, produced by the pure `derivePortfolioMetrics` fold over the
 * address's FULL indexed history plus the epoch step series. A sibling of
 * `/portfolio` (indexed facts): the registry `auth: "address"` declaration is
 * enforced by the handler, so reaching here means the assertion scope already
 * equals `?address=` exactly, and the standing cross-address gate holds this
 * path too.
 */
const portfolioMetricsRoute = defineEnveloped<z.infer<typeof portfolioQuerySchema>>({
  method: "GET",
  path: `${API_BASE}/portfolio/metrics`,
  auth: "address",
  enveloped: true,
  querySchema: portfolioQuerySchema,
  summary: "Address-scoped derived portfolio metrics (M6.1)",
  handle: async (ctx) => {
    const [heads, txs, epochs] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.transactionsAscFor(ctx.query.address),
      ctx.reader.listEpochsAsc(),
    ]);
    return {
      data: derivePortfolioMetrics(ctx.query.address, txs, epochs),
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/transactions?address=&format=` — address-scoped per-event
 * history (newest first, paginated; app-spec §8.2). `format=csv` returns the
 * §14.11 statement-of-fact export as `text/csv` with freshness in the
 * X-Chain-Height / X-Indexed-Height / X-Generated-At headers — the [R3]
 * recorded deviation from the JSON envelope (a CSV body cannot carry it).
 */
const transactionsRoute = defineEnveloped<TransactionsQuery>({
  method: "GET",
  path: `${API_BASE}/transactions`,
  auth: "address",
  enveloped: true,
  querySchema: transactionsQuerySchema,
  summary: "Address-scoped transaction history (paginated; CSV export)",
  handle: async (ctx) => {
    if (ctx.query.format === "csv") {
      // §14.11 amendment: the export is the COMPLETE indexed history
      // ascending by (height, msg_index) — a statement of fact, never a
      // paginated slice. `limit`/`offset` are deliberately ignored here (they
      // bound only the JSON view); the full stream comes from the chunked
      // `transactionsAscFor`, mapped through the same per-row fact mapping.
      const heads = await ctx.reader.heads();
      const headers = new Headers();
      headers.set("content-type", "text/csv; charset=utf-8");
      headers.set("content-disposition", 'attachment; filename="transactions.csv"');
      // [R3]: freshness rides in headers for the non-JSON representation —
      // same values the envelope would carry, never omitted.
      if (heads.chainHeight !== null) headers.set("x-chain-height", String(heads.chainHeight));
      if (heads.indexedHeight !== null)
        headers.set("x-indexed-height", String(heads.indexedHeight));
      headers.set("x-generated-at", ctx.now().toISOString());
      return new Response(
        csvStream(
          ctx.reader.transactionsAscStream(ctx.query.address),
          transactionsCsvHeader(),
          (facts) => transactionsCsvRows(facts.map(toTransactionRow)),
        ),
        { status: 200, headers },
      );
    }
    const [heads, rows] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.transactionsFor(ctx.query.address, {
        limit: ctx.query.limit,
        offset: ctx.query.offset,
      }),
    ]);
    return {
      data: rows,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/** An unowned/absent valoper streams a header-only CSV — the honest-empty
 * answer, byte-identical to an operator with no payments yet. Yields nothing;
 * the header comes from the stream wrapper, not from a chunk. */
async function* emptyPaymentStream(): AsyncIterable<readonly OperatorPaymentFacts[]> {}

/**
 * Render a §14.11 export as a stream: the header, then one rendered block per
 * chunk the reader yields. Nothing accumulates, so peak memory is one chunk
 * regardless of history size. BOTH exports (holder and operator) use this —
 * they had drifted apart, with only the operator one streaming.
 *
 * A read that fails mid-export errors the stream after a 200 has already been
 * sent, so the client sees a truncated download rather than an error status.
 * That is the accepted cost of streaming an unbounded body, and it is the safe
 * direction: a short file is visibly short, whereas the alternative was an
 * export that could not complete at all above a few hundred thousand rows.
 */
function csvStream<Fact>(
  source: AsyncIterable<readonly Fact[]>,
  header: string,
  renderChunk: (facts: readonly Fact[]) => string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = source[Symbol.asyncIterator]();
  let sentHeader = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHeader) {
        sentHeader = true;
        controller.enqueue(encoder.encode(header));
        return;
      }
      const next = await iterator.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(renderChunk(next.value)));
    },
    async cancel(reason) {
      // A client that disconnects mid-download must not leave the reader's
      // keyset walk running against Postgres.
      await iterator.return?.(reason);
    },
  });
}

// --- operator surface (address-scoped) --------------------------------
//
// The three reads behind `/validators/mine` (app-spec §8.6). All `auth:
// "address"`, so they join the standing cross-address gate automatically; on
// top of that they carry an OWNERSHIP check the other personal routes do not
// need: the address→valoper mapping is resolved server-side from
// `validator_registry.operator`, and a valoper the address does not operate is
// answered honest-empty. Not 403 — a 403 would confirm the valoper exists and
// belongs to someone else, an oracle on who operates what.

/**
 * `GET /api/v1/operator/summary?address=` — every validator this address
 * operates: registry enrollment, the latest sampled epoch's economics, and
 * lifetime commission/TIP totals. An address that operates none gets
 * `{ address, validators: [] }` — the honest-empty answer, indistinguishable
 * from an address that operates none on a dataless process.
 *
 * Peer context (`rank_by_tip`, eligible/enrolled counts) is deliberately ABSENT
 * — §7 Q5 was not approved, so no other validator's ordinal position is
 * computed onto this personal surface.
 */
const operatorSummaryRoute = defineEnveloped<z.infer<typeof operatorSummaryQuerySchema>>({
  method: "GET",
  path: `${API_BASE}/operator/summary`,
  auth: "address",
  enveloped: true,
  querySchema: operatorSummaryQuerySchema,
  summary: "Operator-scoped validator standing + lifetime payment totals",
  handle: async (ctx) => {
    const [heads, registry] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.operatorValopers(ctx.query.address),
    ]);
    const valopers = registry.map((r) => r.valoper);
    const [latest, totals] = await Promise.all([
      ctx.reader.latestOperatorEpochs(valopers),
      ctx.reader.operatorPaymentTotalsFor(valopers),
    ]);
    return {
      data: deriveOperatorSummary(
        ctx.query.address,
        registry,
        new Map(latest.map((row) => [row.valoper, row])),
        new Map(totals.map((row) => [row.valoper, row])),
      ) satisfies OperatorSummary,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/operator/epochs?address=&valoper=` — one owned validator's
 * per-epoch economics, newest first, paginated. This is the history the console
 * cannot show (§8.6). A valoper the address does not operate serves `[]`.
 */
const operatorEpochsRoute = defineEnveloped<OperatorEpochsQuery>({
  method: "GET",
  path: `${API_BASE}/operator/epochs`,
  auth: "address",
  enveloped: true,
  querySchema: operatorEpochsQuerySchema,
  summary: "Operator-scoped per-epoch validator history (paginated)",
  handle: async (ctx) => {
    const [heads, owned] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.operatorValopers(ctx.query.address),
    ]);
    const valoper = resolveOwnedValoper(owned, ctx.query.valoper);
    const rows =
      valoper === null
        ? []
        : await ctx.reader.validatorEpochsFor(valoper, {
            limit: ctx.query.limit,
            offset: ctx.query.offset,
          });
    return {
      data: rows.map(toOperatorEpochRow) satisfies OperatorEpochRow[],
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/operator/payments?address=&valoper=&format=` — one owned
 * validator's per-payment commission/TIP history. `format=csv` serves the
 * §14.11 operator export: the COMPLETE history ascending (the 6.1
 * completeness precedent — `limit`/`offset` bound only the JSON view), with
 * freshness in the X- headers ([R3]).
 *
 * `epoch_index` is derived here by joining the epoch boundaries, because the
 * indexer cannot know a payment's crediting epoch at ingest (app-spec §9.1).
 */
const operatorPaymentsRoute = defineEnveloped<OperatorPaymentsQuery>({
  method: "GET",
  path: `${API_BASE}/operator/payments`,
  auth: "address",
  enveloped: true,
  querySchema: operatorPaymentsQuerySchema,
  summary: "Operator-scoped payment history (paginated; §14.11 CSV export)",
  handle: async (ctx) => {
    const [heads, owned] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.operatorValopers(ctx.query.address),
    ]);
    const valoper = resolveOwnedValoper(owned, ctx.query.valoper);

    if (ctx.query.format === "csv") {
      // STREAMED, not materialized: the reader yields keyset-paged chunks and
      // each is rendered and released, so peak memory is one chunk rather than
      // the operator's whole history. That matters because `operator_payments`
      // is fed by a PERMISSIONLESS write path — anyone may PayTip for any
      // validator — so nothing bounds its row count, and the pre-stream
      // version measured 14.8 s and +323 MB RSS per concurrent request at 300
      // 000 rows (2026-07-28 review).
      //
      // The epoch boundaries are read ONCE and closed over: they are ~one row
      // per calendar month, and every chunk derives its `epoch_index` from the
      // same snapshot, so a mid-export epoch close cannot make the file
      // internally inconsistent.
      const boundaries = valoper === null ? [] : await ctx.reader.epochBoundariesAsc();
      const source =
        valoper === null ? emptyPaymentStream() : ctx.reader.operatorPaymentsAscStream(valoper);
      const headers = new Headers();
      headers.set("content-type", "text/csv; charset=utf-8");
      headers.set("content-disposition", 'attachment; filename="operator-payments.csv"');
      if (heads.chainHeight !== null) headers.set("x-chain-height", String(heads.chainHeight));
      if (heads.indexedHeight !== null)
        headers.set("x-indexed-height", String(heads.indexedHeight));
      headers.set("x-generated-at", ctx.now().toISOString());
      return new Response(
        csvStream(source, operatorPaymentsCsvHeader(), (facts) =>
          operatorPaymentsCsvRows(facts.map((f) => toOperatorPaymentRow(f, boundaries))),
        ),
        { status: 200, headers },
      );
    }

    const [facts, boundaries] =
      valoper === null
        ? [[], []]
        : await Promise.all([
            ctx.reader.operatorPaymentsFor(valoper, {
              limit: ctx.query.limit,
              offset: ctx.query.offset,
            }),
            ctx.reader.epochBoundariesAsc(),
          ]);
    return {
      data: facts.map((f) => toOperatorPaymentRow(f, boundaries)) satisfies OperatorPaymentRow[],
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

// --- internal alert-facts surface (`internal:notifier` scope) ---------
//
// The notifier's cross-address evaluation reads (ADR-001 Decision 3; app-spec
// §9.4). All `auth: "internal:notifier"`: the handler pipeline enforces that
// declaration (401 without a valid assertion; 403 for an `address:` scope on
// these paths — the standing INTERNAL_PATHS matrix in cross-address.test.ts),
// and `internal:notifier` never grants a personal endpoint. Enveloped, so
// their freshness heights ride the same contract every route carries — a
// stale indexer is observable, never fabricated.

/**
 * `GET /api/v1/internal/alert-facts/redemptions` — redemptions whose lifecycle
 * advanced past the notifier's height cursor (`since_height`), ascending by
 * height, bounded page. Owner-keyed transitions have no public surface; the
 * notifier keys `redemption_update` off these terminal timestamps.
 */
const alertRedemptionsRoute = defineEnveloped<AlertRedemptionsQuery>({
  method: "GET",
  path: `${API_BASE}/internal/alert-facts/redemptions`,
  auth: "internal:notifier",
  enveloped: true,
  querySchema: alertRedemptionsQuerySchema,
  summary: "Internal: redemption transitions since a height cursor",
  handle: async (ctx) => {
    const [heads, data] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.redemptionsChangedSince(
        ctx.query.since_height,
        ctx.query.after_id,
        ctx.query.limit,
      ),
    ]);
    return {
      data,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/internal/alert-facts/incidents` — incidents past the notifier's
 * id cursor (`since_id`), ascending by id, bounded page. No payload
 * passthrough: identity only (id + `(kind, dedupe_key)`), the replay-stable
 * pair the notifier's dedupe keys off (/§2.4). Public `/incidents`
 * omits the dedupe identity, so this surface is not redundant with it.
 */
const alertIncidentsRoute = defineEnveloped<AlertIncidentsQuery>({
  method: "GET",
  path: `${API_BASE}/internal/alert-facts/incidents`,
  auth: "internal:notifier",
  enveloped: true,
  querySchema: alertIncidentsQuerySchema,
  summary: "Internal: incidents since an id cursor (identity only)",
  handle: async (ctx) => {
    const [heads, data] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.incidentsSince(ctx.query.since_id, ctx.query.limit),
    ]);
    return {
      data,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/internal/alert-facts/arrears` — validators with commission due
 * in the latest sampled epoch, joined to their operator account (active
 * registry rows only). No cursor: arrears is a point-in-time "who owes now"
 * read. Operator economics are excluded from public `/validators`, so this
 * surface is not redundant with it.
 */
const alertArrearsRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/internal/alert-facts/arrears`,
  auth: "internal:notifier",
  enveloped: true,
  querySchema: null,
  summary: "Internal: validators in commission arrears (latest epoch)",
  handle: async (ctx) => {
    const [heads, data] = await Promise.all([ctx.reader.heads(), ctx.reader.latestArrears()]);
    return {
      data,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/governance/proposals` — the §8.7 proposal list, newest first,
 * optionally filtered by `?policy=` (bech32) and `?status=` (closed enum).
 *
 * PUBLIC, and that is structural rather than a choice: proposals and votes are
 * public chain facts with NO address keying, so there is nothing to scope and no
 * `PERSONAL_PATHS` entry is created. The registry-derived cross-address suite
 * confirms it stays that way.
 *
 * `indexed_from_height` rides the payload and is the field to understand:
 * `x/group` prunes, so a proposal that closed before the indexer existed is
 * unrecoverable, and a list that omitted it silently would imply a completeness it
 * does not have (§12.1 — never lie about state). Null means no height certifies
 * the window yet.
 */
const governanceProposalsRoute = defineEnveloped({
  method: "GET",
  path: `${API_BASE}/governance/proposals`,
  auth: "public",
  enveloped: true,
  querySchema: govProposalsQuerySchema,
  summary: "Mirrored x/group proposals (paginated, newest first)",
  handle: async (ctx) => {
    const query = ctx.query as GovProposalsQuery;
    const [heads, result] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.listGovProposals(
        { limit: query.limit, offset: query.offset },
        {
          ...(query.policy === undefined ? {} : { policy: query.policy }),
          ...(query.status === undefined ? {} : { status: query.status }),
        },
      ),
    ]);
    return {
      data: {
        proposals: result.proposals.map(toGovProposalRow),
        indexed_from_height: result.indexedFromHeight,
      } satisfies GovProposalsPayload,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/governance/proposal?id=` — one proposal with its votes.
 *
 * A QUERY PARAM, not a path segment: `findRoute` is an exact string match and
 * this service has no path-parameter support at all (M7 overview finding F3).
 * The web tier is React Router and may use `/governance/:proposalId` for its own
 * URL — the two need not match.
 *
 * A proposal the mirror has never seen is a 404. Not an empty 200: "we hold no
 * record of this id" and "this proposal exists and is empty" are different
 * answers, and conflating them would let a mistyped id look like a real, blank
 * proposal.
 */
const governanceProposalRoute = defineEnveloped({
  method: "GET",
  path: `${API_BASE}/governance/proposal`,
  auth: "public",
  enveloped: true,
  querySchema: govProposalQuerySchema,
  summary: "One mirrored x/group proposal with its votes",
  handle: async (ctx) => {
    const query = ctx.query as GovProposalQuery;
    const [heads, found] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.govProposal(BigInt(query.id)),
    ]);
    if (found === null) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return {
      data: toGovProposalDetail(found.proposal, found.votes) satisfies GovProposalDetail,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/governance/policies` — the HISTORICAL policy set observed in the
 * mirror, with each policy's proposal count and last-seen height.
 *
 * Historical, not live, and the distinction is load-bearing: this service has no
 * chain client by design (ADR-001 Decision 1), so it cannot enumerate the policy
 * set the chain holds right now, nor current membership. Those are web-tier live
 * reads at 7.2 — the same division `/market` and `/portfolio` already use. A
 * policy that exists on chain but has never had a proposal is therefore ABSENT
 * here, which is correct for a mirror and would be wrong for a live set.
 */
const governancePoliciesRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/governance/policies`,
  auth: "public",
  enveloped: true,
  querySchema: null,
  summary: "Historical x/group policy set observed in the mirror",
  handle: async (ctx) => {
    const [heads, policies] = await Promise.all([ctx.reader.heads(), ctx.reader.listGovPolicies()]);
    return {
      data: policies.map(toGovPolicyRow) satisfies GovPolicyRow[],
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

// --- §8.8 admin analytics (`admin` scope) ------------------------------
//
// The cohort-satisfaction dashboard the no-backend console cannot render
// (app-spec §8.8). All `auth: "admin"`, so they join the ADMIN_PATHS matrix in
// test/cross-address.test.ts automatically — no scope but `admin:` reaches
// them, and `admin:` reaches nothing else.
//
// THE GATE IS A CAPABILITY GATE, NEVER A SAFETY GATE (SECURITY.md: never gate a
// safety property on who calls). Nothing here is a write to program state, and
// every figure is derivable from public chain history, aggregated. The gate
// exists because the AGGREGATION is a product surface for administrators, not
// because the underlying facts are secret. Stated so nobody later reasons "it
// is behind the admin gate, therefore it is safe to expose X."
//
// Panels degrade INDIVIDUALLY: each is its own endpoint, so an unavailable
// input nulls one panel rather than blanking the dashboard.

/**
 * `GET /api/v1/admin/program-health` — TVL and net-APR trend, net deposit flow
 * per epoch, and the depositor count (app-spec §8.8 header panel).
 *
 * `depositor_count` is null rather than 0 on a dataless process: "we cannot
 * count depositors" and "nobody has deposited" are different answers.
 *
 * It also carries the funnel's terminal stage, `first_deposits_in_window`,
 * windowed to `FUNNEL_WINDOW_DAYS`. It lives here because this is the route
 * that owns depositor facts — and it is a SEPARATE field from
 * `depositor_count` because the funnel's upper stages are windowed counters:
 * one all-time figure under a windowed caption would put the bottom of the
 * funnel above its top (plan invariant 15).
 */
const adminProgramHealthRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/admin/program-health`,
  auth: "admin",
  enveloped: true,
  querySchema: null,
  summary: "Admin: program-health header + per-epoch trend",
  handle: async (ctx) => {
    // The window is computed from one shared constant, not a query parameter:
    // the funnel's two halves are derived in different tiers, so the window is
    // not the caller's to vary (and an unbounded one would need bounding).
    const windowStart = new Date(ctx.now().getTime() - FUNNEL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const [heads, epochs, depositorCount, firstDepositsInWindow] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.adminEpochsAsc(MAX_ADMIN_EPOCH_POINTS),
      ctx.reader.depositorCount(),
      ctx.reader.firstDepositorsSince(windowStart),
    ]);
    return {
      data: {
        depositor_count: depositorCount,
        first_deposits_in_window: firstDepositsInWindow,
        funnel_window_days: FUNNEL_WINDOW_DAYS,
        epochs: toHealthPoints(epochs),
        // A full page is reported as truncated rather than assumed complete —
        // an unflagged trim presents a partial trend as the whole history.
        epochs_truncated: epochs.length >= MAX_ADMIN_EPOCH_POINTS,
      } satisfies AdminProgramHealth,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/admin/holder-cohorts` — adoption, retention curves by
 * first-deposit epoch, redemption mix, and banded TVL concentration (§8.8).
 *
 * The minimum-group-size gate is applied HERE, server-side, and `min_cohort_size`
 * rides in the payload as data so the web tier renders the honest state without
 * re-deciding the rule (the `/redemptions/stats` precedent). Concentration is
 * null entirely below it: a top-1 share among three holders names one of them
 * without any address being returned.
 */
const adminHolderCohortsRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/admin/holder-cohorts`,
  auth: "admin",
  enveloped: true,
  querySchema: null,
  summary: "Admin: holder adoption, retention, redemption mix, concentration",
  handle: async (ctx) => {
    const [heads, epochs, lifecycles, positions, mix] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.adminEpochsAsc(MAX_ADMIN_EPOCH_POINTS),
      ctx.reader.holderLifecycles(MAX_HOLDER_LIFECYCLES),
      // Only the deepest band's positions cross the wire. The holder count and
      // the denominator come back from the SAME statement, aggregated over
      // every positive position — so this cap bounds the transfer and can never
      // move a reported share.
      ctx.reader.holderPositions(CONCENTRATION_BAND_DEPTH),
      ctx.reader.redemptionMix(),
    ]);
    const retention = toRetentionCurves(epochs, lifecycles);
    return {
      data: {
        min_cohort_size: MIN_COHORT_SIZE,
        adoption: toAdoption(epochs, lifecycles),
        adoption_truncated: epochs.length >= MAX_ADMIN_EPOCH_POINTS,
        retention: retention.slice(0, MAX_ADMIN_RETENTION_CURVES),
        retention_truncated: retention.length > MAX_ADMIN_RETENTION_CURVES,
        redemption_mix: mix,
        concentration: toConcentration(positions),
        holders_truncated: lifecycles.length >= MAX_HOLDER_LIFECYCLES,
      } satisfies AdminHolderCohorts,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/admin/validator-cohorts` — enrollment/churn totals plus the
 * per-epoch eligibility, arrears, TIP-participation and purge timeline (§8.8).
 */
const adminValidatorCohortsRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/admin/validator-cohorts`,
  auth: "admin",
  enveloped: true,
  querySchema: null,
  summary: "Admin: validator enrollment, eligibility, arrears, TIP, purges",
  handle: async (ctx) => {
    const [heads, epochs, aggregates, counts] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.adminEpochsAsc(MAX_ADMIN_EPOCH_POINTS),
      ctx.reader.validatorEpochAggregates(MAX_ADMIN_EPOCH_POINTS),
      ctx.reader.validatorRegistryCounts(),
    ]);
    return {
      data: {
        enrolled_now: counts.enrolledNow,
        churned_total: counts.churnedTotal,
        timeline: toValidatorPoints(epochs, aggregates),
        timeline_truncated: epochs.length >= MAX_ADMIN_EPOCH_POINTS,
      } satisfies AdminValidatorCohorts,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/admin/upkeep` — time-lag distributions for the permissionless
 * cranks (§8.8), derived from crank timing already in the indexed history. No
 * new indexing: epoch lag comes from the settlement series, redemption latency
 * from the request lifecycle.
 *
 * `capture_cadence` is null and stays null — §8.8 names it, but no
 * capture-signal series is indexed, so serving it as null with the panel saying
 * why is the honest answer. Deriving it is an indexer change, not an API one.
 */
const adminUpkeepRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/admin/upkeep`,
  auth: "admin",
  enveloped: true,
  querySchema: null,
  summary: "Admin: upkeep-timeliness lag distributions",
  handle: async (ctx) => {
    const [heads, epochs, latencies] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.adminEpochsAsc(MAX_ADMIN_EPOCH_POINTS),
      ctx.reader.redemptionLatencySeconds(MAX_UPKEEP_SAMPLES),
    ]);
    return {
      data: {
        // The epoch series is already capped upstream, so its lag sample is
        // bounded by the epoch cap and carries that flag rather than its own.
        epoch_lag: toUpkeepDistribution(
          epochLagSeconds(epochs),
          epochs.length >= MAX_ADMIN_EPOCH_POINTS,
        ),
        // The flag comes FROM the read: rows that yield no payout time are
        // dropped, so `seconds.length` cannot answer "did the cap bind".
        redemption_latency: toUpkeepDistribution(latencies.seconds, latencies.truncated),
        capture_cadence: null,
      } satisfies AdminUpkeepTimeliness,
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/admin/incidents` — the §9.6 incident feed WITH ids, newest
 * first, paginated under the shared page bound.
 *
 * The id is the only difference from public `/incidents`, and it is the point:
 * acknowledgment references an incident by id across the schema boundary
 * (ADR-001 Decision 1), and the ack route validates a submitted id against
 * THIS read rather than trusting the client's number.
 */
const adminIncidentsRoute = defineEnveloped({
  method: "GET",
  path: `${API_BASE}/admin/incidents`,
  auth: "admin",
  enveloped: true,
  querySchema: paginationSchema,
  summary: "Admin: incident feed with ids (paginated, newest first)",
  handle: async (ctx) => {
    const [heads, rows] = await Promise.all([
      ctx.reader.heads(),
      ctx.reader.adminIncidents(ctx.query as Pagination),
    ]);
    return {
      data: rows.map(toAdminIncidentRow) satisfies AdminIncidentRow[],
      source: "indexed" as const,
      chainHeight: heads.chainHeight,
      indexedHeight: heads.indexedHeight,
    };
  },
});

/**
 * `GET /api/v1/health` — operational liveness for load balancers. Deliberately
 * NOT enveloped: it is not chain-derived data, so forcing a freshness envelope
 * onto it would misuse the contract. Registered as operational so the envelope
 * gate correctly scopes itself to data routes.
 */
const healthRoute = defineOperational<unknown>({
  method: "GET",
  path: `${API_BASE}/health`,
  auth: "public",
  enveloped: false,
  querySchema: null,
  summary: "Liveness probe",
  handle: () => ({ status: "ok" }),
});

/** The registry. Adding a route here opts it into every CI gate automatically. */
export const routes: readonly Route[] = [
  statusRoute,
  incidentsRoute,
  metricsRoute,
  epochsRoute,
  validatorsRoute,
  marketRoute,
  payoutStatsRoute,
  portfolioRoute,
  portfolioMetricsRoute,
  transactionsRoute,
  operatorSummaryRoute,
  operatorEpochsRoute,
  operatorPaymentsRoute,
  alertRedemptionsRoute,
  alertIncidentsRoute,
  alertArrearsRoute,
  governanceProposalsRoute,
  governanceProposalRoute,
  governancePoliciesRoute,
  adminProgramHealthRoute,
  adminHolderCohortsRoute,
  adminValidatorCohortsRoute,
  adminUpkeepRoute,
  adminIncidentsRoute,
  healthRoute,
];

/** Find a registered route by exact path, ignoring method (for 405 vs 404). */
export function findRoute(path: string): Route | undefined {
  return routes.find((route) => route.path === path);
}
