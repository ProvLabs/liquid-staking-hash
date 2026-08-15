# apps/web — the user web tier, AND the notifier (two workloads, one image:
# ADR-001 Decision 3 — the notifier Deployment overrides the command to
# `node notifier/index.ts`). Build context is the REPO ROOT.
#
# The bundle is baked at IMAGE build time (react-router build) — the recorded
# stale-bundle trap of building at container start (web-design-notes "Live
# e2e re-run trap", CO-18) cannot recur. Config stays RUNTIME: the client-safe
# subset is serialized from server env at request time through the root
# loader (app-spec §7), no VITE_* baking — one web image serves every
# environment. Webfonts are fetched at build time, checksum-pinned
# (plan §2.8); the build FAILS on a mismatch rather than shipping an
# unpinned asset.
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
WORKDIR /repo/apps/web
RUN corepack pnpm exec prisma generate \
  && node scripts/fetch-fonts.mjs --require \
  && corepack pnpm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/web ./apps/web
USER node
WORKDIR /repo/apps/web
HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=30s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT??'3000')+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["corepack", "pnpm", "run", "start"]
