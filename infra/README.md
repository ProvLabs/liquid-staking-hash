# Infrastructure

Deployment and infrastructure configuration that spans the services: local
development stacks, deployment manifests, and environment configuration.

- [`devnet/`](devnet/) — the shared local Provenance dev chain environment
  (lifecycle, vault/contract bootstrap, one-shot operation wrappers, tools).
  Used by the contract drills, the console's devnet profile, and the indexer.
- [`dev/`](dev/) — the containerized dev toolchain (ADR-002): the compose
  file behind the repo-root `./dev` wrapper (pinned node/pnpm task runner,
  disposable postgres, the shared `nvhash-dev` network the dev node joins).
  As of plan PR 1.5 it also carries the `app` profile (indexer/api/web) and the
  two-domain Postgres role split (`dev/postgres/roles.sql`, ADR-001 Decision 1).

## Local full-stack (PR 1.5)

`infra/devnet/stack.sh up` is the one command: it stands up Postgres + indexer +
api + web against the dev node (applying the role split, migrating the `indexed`
schema as `indexer_writer`, then waiting for each component healthy).
`stack.sh verify` runs the grant-boundary gate; `stack.sh down` stops the app
services. Devnet targets only — throwaway credentials, no non-devnet endpoint.

Service-specific runtime code stays with each service under `services/`;
this directory holds what wires them together and deploys them.
