# services/api — the read-only public /api/v1 tier (api_reader role; absent
# DATABASE_URL serves the honest dataless mode). Build context is the REPO
# ROOT. No build step at all: strip-only TS runs directly on Node 22. The
# @nvhash/db-indexed client it reads through is GENERATED at image build from
# the indexer's canonical schema (its own package's generate script), never
# the hoisted @prisma/client.
#
# Base pinned to the ADR-002 toolchain tag; digest pin applied by the images
# job when the registry (plan §7 Q6) exists.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN corepack pnpm fetch
COPY . .
RUN corepack pnpm install --frozen-lockfile --offline

FROM deps AS build
RUN corepack pnpm --filter @nvhash/db-indexed run generate

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/services/api ./services/api
USER node
WORKDIR /repo/services/api
HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT??'8080')+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/index.ts"]
