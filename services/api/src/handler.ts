// The request handler: a framework-free `(Request) => Response` core built on
// the Web Fetch API (Node 22 globals). Keeping it a pure function makes the
// whole stack — read-only guard, rate limit, query bounds, envelope wrapping —
// testable without opening a socket, while the node:http adapter (http-server.ts)
// exercises the same function over a real port for the supertest-style harness.
//
// Order of enforcement, PINNED by the [R4] review resolution
// and encoded in the contract
// tests (all before any handler runs):
//   1. Rate limit            → 429   (SECURITY.md: defensive, rate-limited)
//   2. Path match            → 404
// 3. Read-only method gate → 405 (SECURITY.md/: no writes, ever)
//   4. Credential validity   → 401   (non-public routes; BEFORE query
//        validation, so an unauthenticated probe learns nothing about
//        parameter validity — ADR-001 Decision 2)
//   5. zod query bounds      → 400   (SECURITY.md: bound every query param)
//   6. Scope ↔ target match  → 403   (needs the parsed `?address=`, so it
//        necessarily FOLLOWS zod; cross-address rejection is enforced here,
//        in-process, never by topology)
//   7. handler → envelope wrap / raw body (a route may return a raw
//        Response — the CSV export path — which passes through with the
//        defensive headers merged in)

import { envelope, type FreshnessSource } from "@nvhash/api-types";
import { verifyAssertion, type VerifiedScope } from "./auth.ts";
import type { ApiConfig } from "./config.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { IndexedReader } from "./reader.ts";
import { findRoute, type EnvelopedPayload, type Route } from "./routes.ts";
import { searchParamsToRecord } from "./query.ts";

const ALLOWED_METHODS = ["GET", "HEAD"] as const;

export interface HandlerDeps {
  readonly limiter: RateLimiter;
  readonly appEnv: ApiConfig["appEnv"];
  /** The indexed-data port. `emptyReader` when no DB is configured. */
  readonly reader: IndexedReader;
  /** What `/status` reports as the wired data source — never a fabrication. */
  readonly dataSource: "unwired" | "api_reader";
  /**
   * HMAC key for service-assertion verification (ADR-001 Decision 2).
   * Absent = fail closed: every non-public route answers 401.
   */
  readonly assertionKey?: string;
  /** Injectable clock; defaults to wall clock. Drives `generated_at`. */
  readonly now?: () => Date;
}

/** Per-request metadata the transport adapter supplies (never client-trusted). */
export interface RequestMeta {
  /** Opaque client identifier for rate limiting (see http-server clientKey). */
  readonly clientKey: string;
  /** Raw `Authorization` header value, if any (verified by auth.ts only). */
  readonly authorization?: string;
}

/** JSON stringify with BigInt→string (amount discipline: never lose precision). */
function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => (typeof val === "bigint" ? val.toString() : val));
}

/** Security + content headers applied to every response. */
function baseHeaders(): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  // Defensive headers (SECURITY.md: APIs are read-only and defensive).
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  // Freshness lives in the envelope, not shared caches: don't let a proxy serve
  // a stale chain-derived value as current (app-spec §12.1).
  headers.set("cache-control", "no-store");
  return headers;
}

function withRateLimitHeaders(headers: Headers, limit: number, remaining: number, resetAt: number, now: number): Headers {
  headers.set("ratelimit-limit", String(limit));
  headers.set("ratelimit-remaining", String(remaining));
  headers.set("ratelimit-reset", String(Math.max(0, Math.ceil((resetAt - now) / 1000))));
  return headers;
}

function jsonResponse(status: number, body: unknown, headers: Headers): Response {
  return new Response(jsonStringify(body), { status, headers });
}

function errorResponse(status: number, code: string, message: string, headers: Headers, extra?: Record<string, unknown>): Response {
  // Errors are not chain data, so they are not enveloped.
  return jsonResponse(status, { error: { code, message, ...extra } }, headers);
}

async function runEnvelopedRoute(route: Extract<Route, { enveloped: true }>, ctx: Parameters<typeof route.handle>[0], headers: Headers): Promise<Response> {
  const payload: EnvelopedPayload | Response = await route.handle(ctx);
  // A route may return a raw Response for non-JSON representations (the
  // `?format=csv` export, [R3]): freshness rides in its X- headers instead
  // of the JSON envelope — a recorded §9.4 deviation, not an exemption from
  // the defensive headers, which are merged in (route-set values win).
  if (payload instanceof Response) {
    headers.forEach((value, key) => {
      if (!payload.headers.has(key)) payload.headers.set(key, value);
    });
    return payload;
  }
  const source: FreshnessSource = payload.source;
  const body = envelope(payload.data, {
    source,
    chainHeight: payload.chainHeight ?? null,
    indexedHeight: payload.indexedHeight ?? null,
    generatedAt: ctx.now(),
  });
  return jsonResponse(200, body, headers);
}

/** Build the request handler with its dependencies (limiter, clock, env). */
export function createHandler(deps: HandlerDeps): (request: Request, meta: RequestMeta) => Promise<Response> {
  const now = deps.now ?? (() => new Date());

  return async function handle(request: Request, meta: RequestMeta): Promise<Response> {
    const url = new URL(request.url);
    const nowMs = now().getTime();

    // 1. Rate limit first — protects unknown paths too (anti-scan).
    const rl = deps.limiter.hit(meta.clientKey);
    const headers = withRateLimitHeaders(baseHeaders(), rl.limit, rl.remaining, rl.resetAt, nowMs);
    if (!rl.allowed) {
      headers.set("retry-after", String(Math.max(1, Math.ceil((rl.resetAt - nowMs) / 1000))));
      return errorResponse(429, "rate_limited", "Too many requests.", headers);
    }

    // 2. Path match (method-agnostic, so we can distinguish 405 from 404).
    const route = findRoute(url.pathname);
    if (route === undefined) {
      return errorResponse(404, "not_found", `No route for ${url.pathname}.`, headers);
    }

    // 3. Read-only method gate. The registry only holds GET routes; HEAD is
    //    served as GET-without-body. Any write verb is refused here.
    if (!ALLOWED_METHODS.includes(request.method as (typeof ALLOWED_METHODS)[number])) {
      headers.set("allow", ALLOWED_METHODS.join(", "));
      return errorResponse(405, "method_not_allowed", `${request.method} is not allowed; this API is read-only.`, headers);
    }

    // 4. Credential validity on non-public routes (ADR-001 Decision 2) —
    //    BEFORE query validation ([R4]): absent/expired/invalid → 401 with a
    //    single undifferentiated reason. The verified scope is held for the
    //    post-zod target match; it is never derived from topology.
    let scope: VerifiedScope | null = null;
    if (route.auth !== "public") {
      const result = verifyAssertion(meta.authorization, deps.assertionKey, Math.floor(nowMs / 1000));
      if (!result.ok) {
        return errorResponse(401, "unauthorized", "A valid service assertion is required.", headers);
      }
      scope = result.scope;
    }

    // 5. Bound query params with zod (400 on out-of-range — never clamp silently).
    let query: unknown = {};
    if (route.querySchema !== null) {
      const parsed = route.querySchema.safeParse(searchParamsToRecord(url.searchParams));
      if (!parsed.success) {
        return errorResponse(400, "invalid_query", "Query parameters failed validation.", headers, {
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        });
      }
      query = parsed.data;
    }

    // 6. Scope ↔ target match (403). The cross-address rejection: an
    //    `address:` scope grants exactly ONE address, compared against the
    //    zod-parsed target; any other scope kind on an address route (e.g.
    //    `internal:notifier`) is refused — it never grants personal reads.
    if (route.auth === "address") {
      const target = (query as { address?: unknown }).address;
      if (
        scope === null ||
        scope.kind !== "address" ||
        typeof target !== "string" ||
        scope.address !== target
      ) {
        return errorResponse(403, "forbidden", "The assertion scope does not grant this address.", headers);
      }
    } else if (route.auth === "internal:notifier" && (scope === null || scope.kind !== "internal")) {
      return errorResponse(403, "forbidden", "The assertion scope does not grant this surface.", headers);
    }

    // 7. Dispatch.
    const ctx = { query, url, now, appEnv: deps.appEnv, reader: deps.reader, dataSource: deps.dataSource };
    let response: Response;
    if (route.enveloped) {
      response = await runEnvelopedRoute(route, ctx, headers);
    } else {
      response = jsonResponse(200, await route.handle(ctx), headers);
    }

    // HEAD: same headers/status, empty body.
    if (request.method === "HEAD") {
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  };
}
