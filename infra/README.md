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

## Deployment (PR 8.4)

[`deploy/`](deploy/) is the greenfield non-devnet deployment tree — the first
code allowed to touch a real network (the devnet scripts never are;
SECURITY.md's "drills point at nothing else" rule stands):

- `deploy/docker/` — one multi-stage Dockerfile per workload (indexer, api,
  web+notifier, console) built from the REPO-ROOT context. The web image
  bakes the bundle (config stays runtime — one image serves every
  environment); the console image is built PER ENVIRONMENT (`VITE_*` + the
  generated CSP are compile-time). `.dockerignore` exclusions are ENFORCED by
  the `images` CI job's sentinel layer scan.
- `deploy/k8s/` — kustomize bases per workload plus overlays
  `{testnet concrete, mainnet shape-only}`. ArgoCD sync waves mirror
  `stack.sh`: db-provision → the two migration Jobs (each schema AS its
  owning role) → grant-verify → workloads. Devnet stays on compose,
  deliberately — no devnet overlay exists.
- `deploy/argocd/` — the app-of-apps (one Application per environment).
- `deploy/bootstrap/` — the testnet pilot's entry points, IN ORDER:
  `probe-accept-asset.sh` (the D27 go/no-go; fail ⇒ the pilot WAITS) →
  `testnet-group-bootstrap.sh` (group + BOTH policies before anything else)
  → `testnet-deploy.sh` (marker → vault → NAV seed → store → instantiate
  with BOTH authorities on the admin policy → wiring, every step asserted by
  chain reads) → `testnet-deploy.sh verify` (re-assertable end state; the
  post-pilot acceptance check). Keys come ONLY from the secret store
  (`store_get` on PATH); every script fails closed on missing or
  placeholder-shaped values — gated in CI.
- `deploy/scripts/` — the supply-chain gates (`scan-image-secrets.sh`,
  `scan-repo-secrets.sh`) and `generate-vapid.sh` (store-only key
  generation).

Secrets: external-secrets-operator (D24, plan 8.4 §7.1 Q1) — the repo holds
`ExternalSecret` REFERENCES, the store holds values, and a repo clone
contains zero secret bytes.
