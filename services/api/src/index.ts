// services/api entrypoint (scaffold).
//
// The API is a read-only HTTP service over `/api/v1` (app-spec §9.4): every
// enveloped route carries the freshness envelope, every query param is
// zod-bounded, and requests are rate-limited. It reads only — no write endpoint
// of any kind, no keys, no signing (ownership table). The indexed-data
// reader (`api_reader`, ADR-001 Decision 1) and the real program/address-scoped
// endpoints land; this scaffold establishes the serving shell + gates.
//
// Live invocation under `./dev` is wired with the full-stack compose
// (as with the indexer, whose workers also land later); CI here is typecheck +
// unit + the envelope/read-only/bounds contract harness, none of which needs a
// listening socket or a database.

import { loadConfig } from "./config.ts";
import { createApiServer, scheduleWindowSweep } from "./http-server.ts";
import type { IndexedReader } from "./reader.ts";

export { loadConfig, type ApiConfig } from "./config.ts";
export { createApiServer, clientKey, scheduleWindowSweep, type ApiServer } from "./http-server.ts";
export { createHandler, type HandlerDeps, type RequestMeta } from "./handler.ts";
export { RateLimiter, type RateLimitResult } from "./rate-limit.ts";
export { routes, findRoute, API_BASE, type Route } from "./routes.ts";
export {
  paginationSchema,
  bech32AddressSchema,
  bech32ValoperSchema,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_PAGE_OFFSET,
} from "./query.ts";
export { emptyReader, type IndexedReader, type Heads } from "./reader.ts";
export {
  verifyAssertion,
  MAX_ASSERTION_LIFETIME_SECONDS,
  MAX_CLOCK_SKEW_SECONDS,
  type VerifiedScope,
  type VerifyResult,
} from "./auth.ts";
export {
  transactionsCsv,
  transactionsCsvHeader,
  transactionsCsvRows,
  operatorPaymentsCsv,
  operatorPaymentsCsvHeader,
  operatorPaymentsCsvRows,
  csvField,
  TRANSACTIONS_CSV_COLUMNS,
  OPERATOR_PAYMENTS_CSV_COLUMNS,
} from "./csv.ts";

export async function main(): Promise<void> {
  const config = loadConfig();
  // The Prisma reader is dynamically imported so a dataless process (and the
  // DB-free test suite) never loads the generated client. DATABASE_URL is the
  // SELECT-only `api_reader` role (ADR-001 Decision 1).
  let reader: IndexedReader | undefined;
  let closeReader: (() => Promise<void>) | undefined;
  if (config.databaseUrl !== undefined) {
    const { createPrismaReader } = await import("./reader-prisma.ts");
    const prismaReader = createPrismaReader(config.databaseUrl);
    reader = prismaReader;
    closeReader = () => prismaReader.close();
  }
  const { server, limiter } = createApiServer(config, undefined, reader);
  // Long-lived process: evict expired rate-limit windows so the limiter's map
  // does not grow unbounded with unique client keys over the process lifetime.
  scheduleWindowSweep(limiter, config.rateLimitWindowMs);

  // Graceful shutdown: on SIGTERM/SIGINT (orchestrator pod
  // drain, ctrl-c) stop accepting connections, let in-flight responses
  // finish, then release the reader's connection pool via $disconnect so the
  // database sees a clean close instead of an abrupt drop.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => {
      void (async () => {
        await closeReader?.();
        process.stdout.write(
          `${JSON.stringify({ level: "info", message: "api stopped", signal })}\n`,
        );
        process.exit(0);
      })();
    });
    // Idle keep-alive sockets would otherwise hold `close` open indefinitely.
    server.closeIdleConnections();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(config.port, () => {
    // One structured line; no client identifiers, no connection string
    // (SECURITY.md data minimization / secrets via environment only).
    process.stdout.write(
      `${JSON.stringify({
        level: "info",
        message: "api listening",
        port: config.port,
        env: config.appEnv,
        data_source: reader === undefined ? "unwired" : "api_reader",
      })}\n`,
    );
  });
}

// Only run when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
