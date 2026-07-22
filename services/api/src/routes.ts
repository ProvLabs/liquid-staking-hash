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
// The M1 scaffold has no indexed data source wired (the `api_reader` client and
// the workers land in M2/M3). Enveloped routes therefore report null heights —
// the honest "not certified fresh" state (app-spec §12.1) — never a fabricated
// height. The real public program endpoints (`/metrics`, `/epochs`,
// `/validators`, `/market`) and address-scoped endpoints land in M3 (PRs
// 3.1–3.3) and register here.

import type {
  FreshnessSource,
  IncidentRow,
  ProgramMetrics,
  EpochRow,
  ValidatorSetEpochRow,
} from "@nvhash/api-types";
import type { z } from "zod";
import { paginationSchema } from "./query.ts";
import type { ApiConfig } from "./config.ts";

/** Everything under the versioned prefix lives beneath this base. */
export const API_BASE = "/api/v1";

/** Context handed to a route handler; `query` is the parsed, bounded input. */
export interface RouteContext<Q> {
  readonly query: Q;
  readonly url: URL;
  /** Injectable clock (deterministic in tests); drives `generated_at`. */
  readonly now: () => Date;
  readonly appEnv: ApiConfig["appEnv"];
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
 * `GET /api/v1/status` — enveloped service descriptor. Honest in a dataless
 * scaffold: service metadata with a null-height envelope (no chain read
 * performed). Proves the envelope on a route that cannot misstate chain state.
 */
const statusRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/status`,
  enveloped: true,
  querySchema: null,
  summary: "API service + freshness descriptor",
  handle: (ctx) => ({
    data: {
      service: "nvhash-api",
      api_version: "v1",
      environment: ctx.appEnv,
      // No indexed reader or LCD is wired in the M1 scaffold; say so plainly
      // rather than implying a live data plane exists (SECURITY.md honesty).
      data_source: "unwired",
    },
    source: "indexed",
    chainHeight: null,
    indexedHeight: null,
  }),
});

/**
 * `GET /api/v1/incidents` — enveloped, paginated collection. The demonstrator
 * for the query-bounds harness: `?limit=&offset=` are zod-bounded (400 on
 * out-of-range). A healthy program legitimately has zero incidents; the null
 * `indexed_height` marks that no indexer height certifies this list yet
 * (app-spec §12.1). PR 3.1 fills in the real derivation and heights; the shape
 * is unchanged.
 */
const incidentsRoute = defineEnveloped({
  method: "GET",
  path: `${API_BASE}/incidents`,
  enveloped: true,
  querySchema: paginationSchema,
  summary: "Program incident history (paginated)",
  handle: () => ({
    // Row shape frozen by PR 4.2 (`IncidentRow`, @nvhash/api-types); PR 3.1
    // fills in the real derivation and heights against it.
    data: [] as IncidentRow[],
    source: "indexed" as const,
    chainHeight: null,
    indexedHeight: null,
  }),
});

/**
 * `GET /api/v1/metrics` — enveloped program aggregates (participant count,
 * program age, epoch count; app-spec §8.1 proof strip). Shape frozen by PR
 * 4.2 (`ProgramMetrics`, @nvhash/api-types); every field null until PR 3.1
 * wires the `api_reader` derivations — null is the honest "not yet indexed"
 * state the UI renders as "n/a" (§12.1), never a fabricated number.
 */
const metricsRoute = defineEnveloped<unknown>({
  method: "GET",
  path: `${API_BASE}/metrics`,
  enveloped: true,
  querySchema: null,
  summary: "Program-level aggregates (participants, age, epochs)",
  handle: () => ({
    data: {
      participant_count: null,
      program_started_at: null,
      epoch_count: null,
    } satisfies ProgramMetrics,
    source: "indexed" as const,
    chainHeight: null,
    indexedHeight: null,
  }),
});

/**
 * `GET /api/v1/epochs` — enveloped, paginated per-epoch history (newest
 * first), the series behind the Learn NAV step chart and the §8.5 views.
 * Row shape frozen by PR 4.2 (`EpochRow`, @nvhash/api-types); empty until
 * PR 3.1 reads the indexer's `epoch_snapshots`. A fresh program legitimately
 * has zero settled epochs, so an empty list is not a degraded state.
 */
const epochsRoute = defineEnveloped({
  method: "GET",
  path: `${API_BASE}/epochs`,
  enveloped: true,
  querySchema: paginationSchema,
  summary: "Per-epoch program history (paginated, newest first)",
  handle: () => ({
    data: [] as EpochRow[],
    source: "indexed" as const,
    chainHeight: null,
    indexedHeight: null,
  }),
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

/**
 * `GET /api/v1/validators` — enveloped, paginated per-settlement validator-set
 * health (newest first), the §8.6 public aggregates. Row shape frozen by PR
 * 4.3 (`ValidatorSetEpochRow`, @nvhash/api-types); empty until PR 3.1 derives
 * it from the indexer's validator tables. A fresh program legitimately has no
 * settled history, so an empty list is not a degraded state.
 */
const validatorsRoute = defineEnveloped({
  method: "GET",
  path: `${API_BASE}/validators`,
  enveloped: true,
  querySchema: paginationSchema,
  summary: "Per-settlement validator-set health (paginated, newest first)",
  handle: () => ({
    data: [] as ValidatorSetEpochRow[],
    source: "indexed" as const,
    chainHeight: null,
    indexedHeight: null,
  }),
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
