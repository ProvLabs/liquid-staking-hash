# ADR-003: Deployment topology

**Status:** Proposed — accepted when the PR carrying it merges after review
**Date:** 2026-08-17
**Deciders:** Ira (review/merge)
**Delivers:** app implementation plan §2 PR 8.4 (deployment configs), indexer leg
**Related:** [ADR-001](2026-07-14-adr-001-app-component-architecture.md)
Decision 1 (the role/ownership split this must preserve),
[ADR-002](2026-07-14-adr-002-containerized-dev-toolchain.md) (the pinned
toolchain the images stay in lockstep with),
[`SECURITY.md`](../../SECURITY.md)

## Context

Every component has run only under `infra/dev/compose.yaml` against a devnet
node and a disposable Postgres. The first non-devnet deployment needs images in
a registry, charts under ArgoCD, and a pipeline — and ProvLabs already has all
three, established by `crates-rs`'s `vault-manager`: a per-component chart
directory, `values-<env>.yaml` plus a CI-managed `values-gha-<env>.yaml`, and
thin callers of the shared `ProvLabs/gha-workflows` reusable workflows.

Adopting that precedent is the cheap part. What needs deciding is where this
repository's own constraints — ADR-001's two-domain database ownership,
ADR-002's no-build-step execution, SECURITY.md's secrets-via-environment rule —
land inside it.

The indexer is the first component through, and it is deliberately the first:
it serves no HTTP, holds no keys, and signs nothing, so it exercises the
database and pipeline decisions without also forcing ingress, TLS and session
decisions.

## Decision

### 1. One image per component, built from the repo root with a per-Dockerfile context allowlist

Each component owns `Dockerfile` and `Dockerfile.dockerignore` beside its
source. The build context is the repository root, because a pnpm workspace's
lockfile and manifests live there.

The ignore file is **per-Dockerfile** rather than one shared root
`.dockerignore`, so each component excludes the others' trees — a shared file
could never say "the indexer's context has no business containing `apps/` or
`contracts/`". It is written as an **allowlist** (`**` then `!` re-inclusions):
a denylist admits every newly-added top-level directory silently, while an
allowlist fails at the `COPY` step. Measured context for the indexer: 8.32 kB.

This is BuildKit-only — the legacy builder ignores
`<dockerfile-name>.dockerignore` entirely, so local reproduction requires
`docker buildx build`.

### 2. Deployment is ArgoCD plus the shared ProvLabs workflows; the Application lives outside this repository

`services/<name>/argocd/` holds the chart. A thin caller workflow hands
`docker-file` and `argo-app` to
`docker_build_and_argo_deploy_test.yaml`, which builds, pushes, and opens a PR
bumping `values-gha-test.yaml`. Promotion to prod is a **separate,
manual-dispatch** workflow that re-tags the existing test image, so the artifact
running in prod is the digest that ran in test — never a rebuild.

The ArgoCD `Application` itself is **not** in this repository. The shared
workflow discovers the chart path and the values file by querying ArgoCD, which
means the Application must exist before the first deploy, and its
`helm.valueFiles` must include a filename containing `gha`.

### 3. Database access is Cloud SQL IAM auth, so component charts carry no secret material

`cloud-sql-proxy` runs as a native sidecar with `--auto-iam-authn`. Each
component connects as its own IAM principal, so `DATABASE_URL` carries a
principal and no password, and **the chart has no `SealedSecret` template at
all**. This is the strongest available reading of SECURITY.md's
secrets-via-environment rule: not "the secret is stored well", but "there is no
secret".

Preserving ADR-001 Decision 1 under IAM auth takes two statements per principal,
in `infra/cloudsql/roles.sql`:

```sql
GRANT indexer_writer TO "nvhash-indexer@provlabs-test.iam";
ALTER ROLE "nvhash-indexer@provlabs-test.iam" SET role = indexer_writer;
```

The second is the non-obvious one. Without it, a session authenticating as the
IAM principal creates objects owned by *that principal*, not by the domain role
— so the default privileges keyed to `indexer_writer` never fire and
`api_reader` silently cannot read anything the migration created. The domain
roles themselves are `NOLOGIN`, which is what lets that file live in the
repository containing no credential.

### 4. Schema migrations run as an initContainer sharing the app container's digest

The component that owns a schema owns its migrations. `prisma migrate deploy`
runs in a run-to-completion initContainer built from the **same image and
digest** as the app container, so schema and the code reading it cannot be
different commits. `migrate deploy` is a no-op when current, so re-running on
every Pod start is free.

Ordering needs no extra plumbing: the proxy is a native sidecar (an
initContainer with `restartPolicy: Always`), which starts and stays running
before later initContainers execute.

The cost is that dev dependencies are not pruned from the image — the `prisma`
CLI and its engines are ~111 MB of a ~910 MB image. That is the price of the
same-digest guarantee, and the alternative (a separate prod-only runtime image)
trades the guarantee away.

### 5. Services run their TypeScript sources directly in the deployed image

ADR-002's no-build-step property extends to production: the image uses the same
`node:22-bookworm-slim` base as the tools plane and the `app-ci` job containers,
the same sources, and the same `--experimental-transform-types` flag. "Works
under `./dev`" and "works in the cluster" stay one claim rather than two.

The entrypoint is `node <entry>.ts` directly, **not** the package's `start`
script, which runs `prisma generate` first — generating at container start would
need a writable tree and defeat `readOnlyRootFilesystem`.

### Options considered

- **Bundle to a single JS file (esbuild).** Smaller, faster to boot,
  distroless-friendly. Rejected: it introduces a build step for services the
  repo deliberately builds no step for, and diverges the deployed artifact from
  the tested one.
- **`pnpm deploy --prod` into distroless Node.** Hardest runtime surface.
  Rejected for now: it drops the `prisma` CLI that Decision 4 needs in the same
  image, and Prisma's engine/libssl expectations on distroless are unverified.
- **Password in a `SealedSecret`** (vault-manager's shape). Rejected while IAM
  auth works, because it reintroduces long-lived credential material the IAM
  path removes entirely. It remains the fallback if IAM auth proves unworkable
  for a component's driver.
- **Reproducible builds** (`reproducible: true`, as `vault-manager` uses).
  Rejected: it disables provenance and SBOM attestations, and a Node dependency
  tree benefits more from an SBOM than from digest stability. `vault-manager`
  earned reproducibility with hand-pinned digests and a verification script; the
  trade is worse here.

### Out of scope, deliberately

- **`dd-trace`.** Datadog labels and `DD_*` environment are set so logs tag
  correctly, but no tracing dependency is added: that is a reviewed-dependency
  decision under SECURITY.md, not a side effect of a deployment change.
- **Load-tested resource requests.** First-cut values only; the load test that
  sizes them is separate work.
- **Ingress, TLS, and session topology.** The indexer needs none of it. Those
  decisions belong to the api and web legs.

## Consequences

- A component's deployment is three files plus a chart: `Dockerfile`,
  `Dockerfile.dockerignore`, a caller workflow, and `argocd/`. The api and web
  legs follow this shape rather than inventing one.
- **Chart-shaped security properties need gating checks, not review.** A Helm
  chart is exactly where a control degrades into a topology assumption — a
  `replicas: 1` that someone "improves" to RollingUpdate reads as an
  optimization. Properties asserted only by reading YAML are not enforced under
  SECURITY.md's bar.
- **Deployed-instance state is outside CI's reach.** The grant-boundary gate
  asserts ownership against the dev substrate; nothing in CI can observe Cloud
  SQL. `infra/cloudsql/roles.sql` and `infra/dev/postgres/roles.sql` must agree
  by review, and that gap is a recorded open question rather than a solved
  problem.
- Prisma resolves its `openssl-1.1.x` engine on this base because
  `node:22-bookworm-slim` ships no libssl. That is the configuration every
  existing gate already exercises and it works; adding an `apt-get` to silence
  the install warning would move the engine away from the tested one.

## Action items

1. Provision the per-component GCP service account, Cloud SQL database and IAM
   user, and apply `infra/cloudsql/roles.sql` — none of it deliverable from this
   repository.
2. Create the ArgoCD `Application` per cluster with a `gha`-named values file.
3. Verify Prisma over Cloud SQL IAM auth before the first sync. The engine half
   is proven (migrations and the supervisor both run from the image against
   Postgres); the IAM half is not.
4. Add the gating checks Consequences names, or record their absence with an
   owner.
