// services/api entrypoint (scaffold, app plan PR 1.2).
//
// The API is a read-only HTTP service over `/api/v1` (app-spec §9.4): every
// enveloped route carries the freshness envelope, every query param is
// zod-bounded, and requests are rate-limited. It reads only — no write endpoint
// of any kind, no keys, no signing (plan §1 ownership table). The indexed-data
// reader (`api_reader`, ADR-001 Decision 1) and the real program/address-scoped
// endpoints land in M3; this scaffold establishes the serving shell + gates.
//
// Live invocation under `./dev` is wired with the PR 1.5 full-stack compose
// (as with the indexer, whose workers also land later); CI here is typecheck +
// unit + the envelope/read-only/bounds contract harness, none of which needs a
// listening socket or a database.

import { loadConfig } from "./config.ts";
import { createApiServer, scheduleWindowSweep } from "./http-server.ts";

export { loadConfig, type ApiConfig } from "./config.ts";
export { createApiServer, clientKey, scheduleWindowSweep, type ApiServer } from "./http-server.ts";
export { createHandler, type HandlerDeps, type RequestMeta } from "./handler.ts";
export { RateLimiter, type RateLimitResult } from "./rate-limit.ts";
export { routes, findRoute, API_BASE, type Route } from "./routes.ts";
export { paginationSchema, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, MAX_PAGE_OFFSET } from "./query.ts";

export function main(): void {
  const config = loadConfig();
  const { server, limiter } = createApiServer(config);
  // Long-lived process: evict expired rate-limit windows so the limiter's map
  // does not grow unbounded with unique client keys over the process lifetime.
  scheduleWindowSweep(limiter, config.rateLimitWindowMs);
  server.listen(config.port, () => {
    // One structured line; no client identifiers (SECURITY.md data minimization).
    process.stdout.write(JSON.stringify({ level: "info", message: "api scaffold listening", port: config.port, env: config.appEnv }) + "\n");
  });
}

// Only run when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
