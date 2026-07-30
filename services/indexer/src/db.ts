// Prisma client for the `indexed` schema. The indexer is the sole writer of
// this schema (role `indexer_writer`, ADR-001 Decision 1). The generated
// read-only client for the same schema is published separately as
// `@nvhash/db-indexed` for `services/api` (/1.3).

import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;

/** Lazily constructed singleton so tests and workers share one pool. */
export function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}
