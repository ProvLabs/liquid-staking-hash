// @nvhash/db-indexed — the read-only Prisma client over the `indexed` schema
// for services/api (the seam services/indexer/src/db.ts and
// services/api/CLAUDE.md have named).
//
// This package is a typed VIEW, not an owner: the canonical schema and its
// migrations live in services/indexer/prisma (ADR-001 Decision 1), and the
// `dbIndexed` generator block there emits this client into ./generated (built
// on demand, gitignored). Read-only is enforced by the SELECT-only
// `api_reader` database role — asserted by the standing grant-boundary CI
// gate — never by anything in this package: a compromised API process with
// this client still cannot write `indexed`.

export { Prisma, PrismaClient } from "../generated/client/index.js";
