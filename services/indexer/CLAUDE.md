# CLAUDE.md — indexer

Chain-event indexer feeding the query store used by `services/api/`.

## Conventions

- Indexing must be idempotent and resumable: reprocessing a block range must
  not corrupt or duplicate derived data.
- Treat chain data as the source of truth; derived tables are rebuildable.
- **Owns the `indexed` schema** (ADR-001 Decision 1,
  [`docs/architecture/2026-07-14-adr-001-app-component-architecture.md`](../../docs/architecture/2026-07-14-adr-001-app-component-architecture.md)):
  the Prisma schema and migrations for all indexed tables live here and run as
  the `indexer_writer` role — the only role with write access to that schema.
  This service never touches the `app` schema. Migrations must run cleanly on
  an empty database.
- The reconciler and incident derivation live in this service (spec §9.6);
  the notifier does not (it is an `apps/web` worker).
- The generated read-only Prisma client for the `indexed` schema is published
  as the `@nvhash/db-indexed` workspace package for `services/api`.
- Security ([`SECURITY.md`](../../SECURITY.md)): persist only public chain
  data plus minimal operational data — no user-identifiable information, no
  IP-to-address linkage (including logs); treat indexed events as untrusted
  input; never hold keys or sign. Schema lint (no PII columns) and the
  log-scrubbing check gate CI (plan §4).

## Commands

Part of the root pnpm workspace (ADR-001 Decision 4); all JS tasks run in the
containerized toolchain (ADR-002): `./dev pnpm --filter @nvhash/indexer
<script>`. Dev database via `./dev pg up` (host port 5433); the dev chain is
reachable in-network as `http://dev-node:1317`.

Package scripts (`./dev pnpm --filter @nvhash/indexer run <script>`):

- `typecheck` — `prisma generate` then `tsc --noEmit`. Generate runs first so
  the client types exist; it reads only the schema, so no database is needed
  (this is why CI can typecheck without Postgres).
- `test` — Vitest. Includes the two security-executable gates below; no DB.
- `generate` — regenerate the Prisma client from `prisma/`.
- `migrate:dev` / `migrate:deploy` / `migrate:status` / `migrate:reset` —
  Prisma migration lifecycle. These DO need a database: bring one up with
  `./dev pg up` and set `DATABASE_URL`. Prisma auto-loads a gitignored
  `services/indexer/.env`; from inside the tools container the dev DB is
  `postgresql://nvhash:nvhash-dev@postgres:5432/nvhash?schema=indexed`
  (the `?schema=indexed` selects this service's schema; `migrate deploy`
  creates it on an empty database). Copy `.env.example` to start.

### CI gates (standing from PR 1.1)

`pnpm -r run typecheck` and `pnpm -r run test` in the `app-ci` workflow pick
these up automatically. `test` includes the security-executable gates
(SECURITY.md, plan §4), which fail CI on violation:

- **Schema-field allowlist** (`test/schema-allowlist.test.ts`): every `indexed`
  column must be on the SECURITY.md allowed-fields list
  (`test/security/allowed-fields.ts`) — a column outside it, or matching a
  PII/IP/device substring, fails. Adding a column is a design-review event:
  edit the allowlist, don't just migrate. The same suite asserts amount
  discipline (every amount column is `Decimal(39,0)`, no `Float`).
- **Log scrubbing** (`test/log-scrubbing.test.ts`): the source tree must never
  reference an IP/device/identity token (`test/security/scan-logs.ts`); the
  logger's `SAFE_FIELDS` allowlist is asserted identity-free.

The role split (`indexer_writer` owning `indexed`) and the grant-boundary
integration test land with PR 1.5 (ADR-001 action item 4); PR 1.1 proves
migrations clean on an empty database as the dev superuser.
