# Indexer

Backend service that follows the chain, indexes liquid-staking contract events
and state into a queryable store, and keeps derived data (positions, rates,
history) up to date for the API.

It is the **sole writer of the `indexed` PostgreSQL schema** (ADR-001
Decision 1) and is fully rebuildable from chain. It serves no HTTP to users,
holds no keys, and signs nothing (implementation plan §1 ownership table).

## Status

PR 1.1 scaffold (app plan M1): TypeScript project, the Prisma multi-file
schema for the `indexed` tables (app-spec §9.1), migrations proven clean on an
empty database, and CI (typecheck, Vitest, plus the schema-allowlist and
log-scrubbing security gates). The worker loops, reconciler, and incident
derivation land in M2 (PRs 2.1–2.5).

## Layout

- `prisma/` — one `*.prisma` file per model (the nuva precedent). `schema.prisma`
  holds the datasource/generator; every table lives in the `indexed` schema.
- `prisma/migrations/` — one committed baseline migration, regenerated from the
  models rather than appended to (`migrate deploy` on an empty DB creates the
  `indexed` schema and all tables). See `CLAUDE.md`.
- `src/` — process shell: `config.ts` (env validated at the boundary),
  `logger.ts` (safe-field-only structured logger), `db.ts` (Prisma client),
  `index.ts` (worker entrypoint stub).
- `test/` — Vitest suites, including the security-executable gates under
  `test/security/`.

## Getting started

All JS tasks run in the containerized toolchain (never on the host — ADR-002):

```
./dev pnpm install                              # once
./dev pg up                                     # dev Postgres (host :5433)
cp services/indexer/.env.example services/indexer/.env
./dev pnpm --filter @nvhash/indexer run migrate:deploy
./dev pnpm --filter @nvhash/indexer run typecheck
./dev pnpm --filter @nvhash/indexer run test
```

See `CLAUDE.md` for the full command and CI-gate reference.
