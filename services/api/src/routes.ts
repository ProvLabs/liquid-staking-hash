// The route registry — the single source of truth for what `/api/v1` exposes.
//
// Two invariants make the security posture structural rather than reviewed:
//   1. Every route is `method: "GET"`. There is no way to register a write in
//      this array; the read-only contract test asserts it, and the request
//      handler rejects any non-GET/HEAD verb with 405 before dispatch. This is
//      how "no write endpoint of any kind" (plan §1, SECURITY.md) is enforced.
//   2. Every route declares whether it carries the freshness envelope and what
//      zod schema (if any) bounds its query params. The envelope contract test
//      iterates THIS array, so a new route is automatically held to both the
//      envelope and query-bounds gates — the harness cannot silently miss one.
//
// PR 3.1: the public program endpoints read real indexed data through the
// injected `IndexedReader` port (reader.ts) — `emptyReader` when no database
// is configured, so a dataless process still reports the honest null/empty
// state (app-spec §12.1), never a fabricated height or row. Envelope heights
// come from `reader.heads()` (latest reconciler run; worker-checkpoint
// fallback). `/market` lands with PR 3.2; the address-scoped endpoints with
// PR 3.3.

import type { FreshnessSource, IncidentRow, ProgramMetrics, EpochRow } from "@nvhash/api-types";
import type { z } from "zod";
import { paginationSchema, type Pagination } from "./query.ts";
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
  /** The indexed-data port (PR 3.1) — every data read goes through it. */
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

interface BaseRoute<Q> {
  readonly method: "GET";
  readonly path: string;
  readonly querySchema: z.ZodType<Q> | null;
  readonly summary: string;
}

export interface EnvelopedRoute<Q> extends BaseRoute<Q> {
  readonly enveloped: true;
  handle(ctx: RouteContext<Q>): EnvelopedPayload | Promise<EnvelopedPayload>;
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
 * the reader — the M4.1 chrome consumes this envelope for the footer
 * freshness line, so it must never claim a plane that is not connected.
 */
const statusRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/status`,
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
 * reconciler-derived `incidents` (app-spec §9.6; row shape frozen by PR 4.2).
 * A healthy program legitimately has zero incidents; null heights mean no
 * indexer height certifies the list yet (§12.1).
 */
const incidentsRoute = defineEnveloped({
  method: "GET",
  path: `${API_BASE}/incidents`,
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
 * NAV step chart and the §8.5 views (row shape frozen by PR 4.2; `nav`
 * widened to `string | null` by PR 3.1 — an empty-vault epoch has no NAV).
 * A fresh program legitimately has zero settled epochs.
 */
const epochsRoute = defineEnveloped({
  method: "GET",
  path: `${API_BASE}/epochs`,
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
 * `ValidatorSetHealth`, @nvhash/api-types); PR 4.3's public page consumes
 * them. Per-epoch fields are null before the first sample — honest, never a
 * fabricated zero.
 */
const validatorsRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/validators`,
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
 * `GET /api/v1/health` — operational liveness for load balancers. Deliberately
 * NOT enveloped: it is not chain-derived data, so forcing a freshness envelope
 * onto it would misuse the contract. Registered as operational so the envelope
 * gate correctly scopes itself to data routes.
 */
const healthRoute = defineOperational<unknown>({
  method: "GET",
  path: `${API_BASE}/health`,
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
  healthRoute,
];

/** Find a registered route by exact path, ignoring method (for 405 vs 404). */
export function findRoute(path: string): Route | undefined {
  return routes.find((route) => route.path === path);
}
