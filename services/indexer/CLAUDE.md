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
reachable in-network as `http://dev-node:1317`. Concrete scripts land with
the PR 1.1 scaffold.
