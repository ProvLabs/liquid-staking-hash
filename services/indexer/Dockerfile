# syntax=docker/dockerfile:1

# Runtime image for the chain-event indexer.
#
# The service runs its TypeScript sources directly on Node's type stripping;
# there is deliberately no build step (ADR-002,
# docs/architecture/2026-07-14-adr-002-containerized-dev-toolchain.md). This
# image keeps that property: the same base as the dev tools plane and the
# app-ci job containers, the same sources, the same flags — so "works under
# ./dev" and "works in the cluster" are one claim.
#
# The base digest is pinned by hand; there is no automation. Re-resolve with:
#   docker buildx imagetools inspect node:22-bookworm-slim
# Use the `Digest:` line (the multi-arch index digest, which is what FROM
# pins). Do NOT use `docker manifest inspect -v` — it returns one descriptor
# per platform and gives the wrong value.
#
# Keep the base tag in LOCKSTEP with infra/dev/compose.yaml and the container
# images in .github/workflows/app-ci.yaml. That lockstep is by TAG: those two
# track the floating `node:22-bookworm-slim`, while the digest below is the
# snapshot of it that ships. Nothing detects drift between them, so re-resolving
# on a deliberate bump is what keeps "works under ./dev" and "works in the
# cluster" the same claim.

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

FROM base AS deps
# Manifests and the lockfile only, so this layer is keyed on dependencies and
# survives source-only commits.
#
# Every workspace manifest is copied, not just the indexer's:
# --frozen-lockfile validates the lockfile's importers against the manifests
# present, and a filtered install with manifests missing reports the lockfile
# as out of sync. Listing them means adding a workspace package fails HERE,
# loudly, rather than drifting. pnpm-workspace.yaml is required for --filter to
# resolve anything at all.
#
# This base ships no libssl, so Prisma cannot detect an OpenSSL version and
# resolves its engines to the openssl-1.1.x build. That is the configuration
# the app-ci `db-grants` job and the infra/dev/compose.yaml indexer service
# already run against Postgres, so it is load-bearing as-is: do NOT add an
# apt-get for openssl/libssl3 to "fix" the install warning. Changing it would
# move the engine Prisma selects away from the one every gate exercises.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY services/indexer/package.json services/indexer/
COPY apps/web/package.json apps/web/
COPY services/api/package.json services/api/
COPY packages/api-types/package.json packages/api-types/
COPY packages/chain-client/package.json packages/chain-client/
COPY packages/db-indexed/package.json packages/db-indexed/
COPY packages/fixtures/package.json packages/fixtures/
RUN corepack pnpm install --frozen-lockfile --filter @nvhash/indexer

FROM deps AS build
COPY services/indexer/ services/indexer/
# --generator=client selects the client generator ONLY. The schema also
# declares a `dbIndexed` generator whose output is
# packages/db-indexed/generated/client; running it would require that package
# in the build context. Selecting the generator keeps packages/ out of the
# image.
RUN corepack pnpm --filter @nvhash/indexer exec prisma generate --generator=client

FROM base AS final
# Transform mode, not strip-only: src/runtime/streams.ts uses TS parameter
# properties, which Node's default strip-only type stripping rejects.
ENV NODE_OPTIONS=--experimental-transform-types \
    NODE_ENV=production \
    INDEXER_HEARTBEAT_FILE=/heartbeat/indexer.heartbeat

COPY --from=build --chown=node:node /app /app

# The heartbeat directory exists in the image so the container is runnable on
# its own: the supervisor treats a failed heartbeat write as a fatal boot error,
# so without this the image only ever starts when something mounts this path.
# In the cluster an emptyDir mounts over it, which is what makes
# readOnlyRootFilesystem possible.
RUN mkdir -p /heartbeat && chown node:node /heartbeat

USER node

# Dev dependencies are NOT pruned: the `prisma` CLI and prisma/migrations in
# this image are what the deployment's migrate initContainer runs, which is
# what makes schema and code the same digest by construction.
#
# That costs real space — the image is ~910 MB, of which node_modules is
# ~400 MB: @prisma/client 96 MB, the prisma CLI 69 MB and @prisma/engines
# 42 MB are all load-bearing, and Biome (58 MB) arrives because a filtered
# pnpm install always includes the workspace root project. Do not try to trim
# this by deleting entries out of node_modules/.pnpm: that store is a graph of
# symlinks, and a hand-pruned one fails at runtime rather than at build time.
# Splitting a separate prod-only runtime image is the real option, and it
# trades away the same-digest guarantee above.
#
# The entrypoint bypasses `pnpm run start` on purpose. That script is
# `prisma generate && node src/index.ts`; generating at container start would
# require a writable tree and defeat readOnlyRootFilesystem. Generation happens
# in the `build` stage above.
CMD ["node", "services/indexer/src/index.ts"]
