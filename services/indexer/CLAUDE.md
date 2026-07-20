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
- `test` — Vitest (default config). Includes the two security-executable gates
  below; no DB (the DB-backed grant-boundary test is a separate config/script,
  so `pnpm -r run test` stays Postgres-free).
- `test:grants` — the grant-boundary integration test (needs Postgres, see
  "Full-stack wiring" below).
- `generate` — regenerate the Prisma client from `prisma/`.
- `start` — `prisma generate` then run the scaffold supervisor (`src/index.ts`):
  it connects to the `indexed` schema as `indexer_writer`, proves the connection
  stays live via a periodic ping written to a heartbeat file, and idles until a
  signal — the shape M2 workers slot into. Serves no HTTP (plan §1). Used by the
  full-stack `app` compose service (PR 1.5); needs `DATABASE_URL`.
- `migrate:dev` / `migrate:deploy` / `migrate:status` / `migrate:reset` —
  Prisma migration lifecycle. These DO need a database: bring one up with
  `./dev pg up` and set `DATABASE_URL`. Prisma auto-loads a gitignored
  `services/indexer/.env`; from inside the tools container the dev DB is
  `postgresql://nvhash:nvhash-dev@postgres:5432/nvhash?schema=indexed`
  (the `?schema=indexed` selects this service's schema; `migrate deploy`
  creates it on an empty database). Copy `.env.example` to start.

### Full-stack wiring (PR 1.5)

`infra/devnet/stack.sh up` brings up Postgres + this indexer + api + web against
the dev node in one command: it applies the two-domain role split
(`infra/dev/postgres/roles.sql` — `indexer_writer`/`api_reader`/`app_writer`,
ADR-001 Decision 1), migrates the `indexed` schema **as `indexer_writer`** so it
owns every table, then starts the `app` compose profile and waits for each
component healthy. `infra/devnet/stack.sh verify` runs the grant-boundary gate;
`… down` stops the app services. The indexer's own health is the DB-ping
heartbeat (`scripts/healthcheck.mjs`), not an endpoint.

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

- **Grant boundary** (`test/integration/grant-boundary.test.ts`, standing from
  PR 1.5): against a live Postgres bootstrapped by `roles.sql` and this
  service's migration, it asserts the ADR-001 Decision 1 ownership split —
  `api_reader` may SELECT but not INSERT/UPDATE `indexed`; `app_writer` may not
  SELECT `indexed`; `indexer_writer` has no privileges on `app`. It runs in the
  dedicated app-ci `db-grants` job (Postgres service, no devnet node) on every
  PR, kept out of the DB-free `pnpm -r run test` via a separate vitest config.
  A regression in `roles.sql` fails it.

PR 1.1 proved migrations clean on an empty database as the dev superuser; PR 1.5
delivers the role split (`indexer_writer` owning `indexed`) and the
grant-boundary gate (ADR-001 action item 4).
