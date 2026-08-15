# services/indexer — sole writer of the `indexed` schema (ADR-001 Decision 1).
# Build context is the REPO ROOT (the pnpm workspace needs the root lockfile).
#
# Runtime shape (plan 8.4 §2.1): no TS build — Node runs the sources directly,
# and NOT in strip-only mode: runtime/streams.ts uses TS parameter properties,
# so --experimental-transform-types is load-bearing (the container exits at
# boot without it). `prisma generate` is the only build step; the client lands
# in the explicit generated/client path (never the hoisted @prisma/client —
# the prisma-generator-output gate's rule).
#
# Base pinned to the ADR-002 toolchain tag; the digest pin is applied by the
# images job when the registry (plan §7 Q6, an ops overlay parameter) exists —
# a tag-only base never ships to an environment.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN corepack pnpm fetch
COPY . .
RUN corepack pnpm install --frozen-lockfile --offline

FROM deps AS build
WORKDIR /repo/services/indexer
RUN corepack pnpm exec prisma generate

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    # TS parameter properties in runtime/streams.ts: transform mode required.
    NODE_OPTIONS=--experimental-transform-types
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/services/indexer ./services/indexer
USER node
WORKDIR /repo/services/indexer
# Liveness is the heartbeat FILE (no HTTP is served, by design) — k8s probes
# exec this the way the compose healthcheck does.
HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=40s \
  CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "src/index.ts"]
