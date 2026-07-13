# CLAUDE.md — api

Query API over the indexer's data store.

## Conventions

- Read-only over indexed data; transaction submission happens client-side via
  wallets, not through this API.
- Version the public API surface; `apps/web/` is the primary consumer.
- Keep response shapes documented in `docs/specs/` once stable.
- Security ([`SECURITY.md`](../../SECURITY.md)): validate and bound all query
  parameters; rate-limit; serve nothing not derivable from public chain data;
  no user-identifiable information collected or stored; secrets via
  environment only.

## Commands

To be filled in when the service scaffold lands.
