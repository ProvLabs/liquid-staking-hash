# CLAUDE.md — api

Query API over the indexer's data store.

## Conventions

- Read-only over indexed data; transaction submission happens client-side via
  wallets, not through this API.
- **Reads the `indexed` schema via the SELECT-only `api_reader` role**
  (ADR-001 Decision 1,
  [`docs/architecture/2026-07-14-adr-001-app-component-architecture.md`](../../docs/architecture/2026-07-14-adr-001-app-component-architecture.md)):
  this service runs no migrations and performs no database writes of any
  kind. It consumes the `@nvhash/db-indexed` client generated from the
  indexer's schema.
- **Address-scoped and admin endpoints are authorized in-process** (ADR-001
  Decision 2): a short-lived HMAC service assertion from the web tier's
  session layer must carry an `address:<bech32>` scope matching the requested
  address exactly (mismatch → 403; absent/expired/invalid → 401). Never rely
  on network topology or "the web app is the only caller" — the
  cross-address-rejection contract tests gate this service's CI from PR 3.3.
- Every response carries the freshness envelope from `@nvhash/api-types`
  (spec §9.4); public endpoints stay unauthenticated, read-only, rate-limited.
- Version the public API surface; `apps/web/` is the primary consumer.
- Keep response shapes documented in `docs/specs/` once stable.
- Security ([`SECURITY.md`](../../SECURITY.md)): validate and bound all query
  parameters (zod at every route boundary); rate-limit; serve nothing not
  derivable from public chain data; no user-identifiable information
  collected or stored; secrets via environment only.

## Commands

Part of the root pnpm workspace (ADR-001 Decision 4); all JS tasks run in the
containerized toolchain (ADR-002): `./dev pnpm --filter @nvhash/api <script>`.
Dev database via `./dev pg up` (host port 5433). Concrete scripts land with
the PR 1.2 scaffold.
