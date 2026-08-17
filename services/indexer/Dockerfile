# Build from the repo root: docker build -f services/indexer/Dockerfile .
# Same pinned node line as the dev toolchain (ADR-002).
FROM node:22-bookworm-slim AS build
# Prisma engine selection needs OpenSSL present.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
# Lockfile-only layer: source edits don't re-fetch dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack pnpm fetch
COPY . .
RUN corepack pnpm install --frozen-lockfile --offline --filter @nvhash/indexer...
RUN corepack pnpm --filter @nvhash/indexer run generate

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo /repo
WORKDIR /repo/services/indexer
USER node
# runtime/streams.ts uses TS parameter properties; strip-only mode rejects them.
ENV NODE_OPTIONS=--experimental-transform-types
# Liveness probe: node scripts/healthcheck.mjs (heartbeat file, no HTTP).
# Migration job: same image, command ./node_modules/.bin/prisma migrate deploy
CMD ["node", "src/index.ts"]
