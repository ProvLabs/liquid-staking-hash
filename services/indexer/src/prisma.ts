// The ONE import site for the indexer's generated Prisma client.
//
// The `client` generator emits into generated/client (explicit, gitignored,
// a SIBLING of prisma/ — anything inside prisma/ is read as multi-file schema
// source) so `apps/web` stays the repo's sole writer of the hoisted
// node_modules/@prisma/client — two default-output generators race, and the
// last `prisma generate` in a process tree wins globally. Every other module
// imports `Prisma`/`PrismaClient` from here, so a future output move touches
// this file alone. The path itself is gated by
// test/prisma-generator-output.test.ts.

export { Prisma, PrismaClient } from "../generated/client/index.js";
