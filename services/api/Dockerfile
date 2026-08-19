# Build from the repo root: docker build -f services/api/Dockerfile .
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
# @nvhash/indexer is included because Prisma resolves its CLI from the
# canonical schema's package when db-indexed generates below.
RUN corepack pnpm install --frozen-lockfile --offline --filter @nvhash/api... --filter @nvhash/indexer
# @nvhash/db-indexed generates its client from the indexer's canonical schema.
RUN corepack pnpm --filter @nvhash/db-indexed run generate

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo /repo
WORKDIR /repo/services/api
USER node
# Liveness probe: GET /api/v1/health.
CMD ["node", "src/index.ts"]
