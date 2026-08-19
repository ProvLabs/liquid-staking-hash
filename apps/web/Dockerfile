# Build from the repo root: docker build -f apps/web/Dockerfile .
# One image, two entrypoints: web SSR (default CMD) and the notifier worker
# (override command with: node notifier/index.ts).
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
RUN corepack pnpm install --frozen-lockfile --offline --filter @nvhash/web...
RUN corepack pnpm --filter @nvhash/web run generate
RUN corepack pnpm --filter @nvhash/web run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo /repo
WORKDIR /repo/apps/web
USER node
# Liveness probe: GET /healthz.
# Migration job (app schema): ./node_modules/.bin/prisma migrate deploy
CMD ["./node_modules/.bin/react-router-serve", "./build/server/index.js"]
