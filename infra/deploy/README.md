# Deployment (M8.4)

Production packaging for the app-side components. ArgoCD manifests land here
next; this directory currently holds image builds.

## Images

`./build-images.sh [tag]` builds all three from the repo root context
(default tag: git short SHA). Each Dockerfile lives with its component.

| Image | Entrypoint | Notes |
|---|---|---|
| `nvhash-indexer` | `node src/index.ts` | Liveness: `scripts/healthcheck.mjs`. Migration job: same image, `./node_modules/.bin/prisma migrate deploy`. |
| `nvhash-api` | `node src/index.ts` | Liveness: `GET /api/v1/health`. Stateless. |
| `nvhash-web` | `react-router-serve` | Liveness: `GET /healthz`. Notifier worker: same image, command `node notifier/index.ts`. App-schema migration job: `./node_modules/.bin/prisma migrate deploy`. |

The console is not imaged: it is a static per-environment Vite build
(`apps/console`), deployed to static hosting by CI.

All config and secrets arrive via environment at runtime (SECURITY.md);
nothing is baked at build. Indexer and web fail closed on blank/malformed
`CONTRACT_ADDRESS`/`VAULT_ADDRESS`.
