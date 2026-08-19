# Deployment (M8.4)

Production packaging for the app-side components: image builds and CI
publishing. Deployment itself (manifests, config, secrets) lives in the
consumer's own system; this repo only produces the public images.

## Images

`./build-images.sh [tag]` builds all four locally from the repo root context
(default tag: git short SHA). Each Dockerfile lives with its component.

| Image | Entrypoint | Notes |
|---|---|---|
| `nvhash-indexer` | `node src/index.ts` | Liveness: `scripts/healthcheck.mjs`. Migration job: same image, `./node_modules/.bin/prisma migrate deploy`. |
| `nvhash-api` | `node src/index.ts` | Liveness: `GET /api/v1/health`. Stateless. |
| `nvhash-web` | `react-router-serve` | Liveness: `GET /healthz`. Notifier worker: same image, command `node notifier/index.ts`. App-schema migration job: `./node_modules/.bin/prisma migrate deploy`. |
| `nvhash-console` | nginx on port 8080 | Static Vite builds of all three checked-in profiles; `CONSOLE_PROFILE=devnet\|test\|production` (default `test`) selects one at start. Liveness: `GET /`. |

Config and secrets arrive via environment at runtime (SECURITY.md); nothing
secret is baked at build. The console is the exception on config: its `VITE_*`
profiles are client-public and compiled in per Vite mode, so changing profile
values means a rebuild, not an env change. Indexer and web fail closed on
blank/malformed `CONTRACT_ADDRESS`/`VAULT_ADDRESS`.

## Publishing

`.github/workflows/publish-images.yaml` publishes all four images to
`ghcr.io/provlabs/nvhash-{indexer,api,web,console}` on every merge to main.
Each publish carries three tags:

- `vX.Y.Z`: the highest existing `v*` git tag patch-bumped (first publish is
  `v1.0.0`). The workflow pushes the git tag to this repo after all images
  publish successfully, so the tag list is the version source of truth.
- the git short SHA, for pinning a deploy to an exact commit.
- `latest`, a moving tag on the newest main build.

One-time setup after the first publish: GHCR packages start private, so an org
admin must set each of the four packages to public (package settings →
Change visibility → Public).
