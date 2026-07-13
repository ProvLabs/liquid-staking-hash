# CLAUDE.md — api

Query API over the indexer's data store.

## Conventions

- Read-only over indexed data; transaction submission happens client-side via
  wallets, not through this API.
- Version the public API surface; `apps/web/` is the primary consumer.
- Keep response shapes documented in `docs/specs/` once stable.

## Commands

To be filled in when the service scaffold lands.
