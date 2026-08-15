# apps/console — static files behind a minimal server. UNLIKE the web image,
# the console is built PER ENVIRONMENT: every console value is a VITE_*
# compile-time constant and the CSP `connect-src` is generated into the HTML
# from the profile's VITE_LCD_URL at build (the 8.4b mechanism, which throws
# on anything wider than one exact origin). One image tag per environment,
# e.g. console:testnet-<sha>. Build context is the REPO ROOT (the console is
# outside the pnpm workspace; only apps/console is used).
#
# The bundle guard runs IN the build for every non-devnet mode: a devnet
# identity literal reaching this image fails the build here as well as in CI
# (spec §10.1 compile-time exclusion).
#
# Bases pinned to tags; digest pins applied by the images job when the
# registry (plan §7 Q6) exists.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:stable-alpine
# The Vite mode / deploy profile: test (pilot) | production. NOT devnet —
# devnet stays on the compose substrate.
ARG CONSOLE_MODE=test

FROM ${NODE_IMAGE} AS build
ARG CONSOLE_MODE
WORKDIR /repo/apps/console
COPY apps/console/package.json apps/console/package-lock.json ./
RUN npm ci
# The certification-caveat fact (plan 8.4 §2.7.2): vite.config.ts bakes the
# fixture-corpus manifest status, read by repo-relative path.
COPY packages/fixtures/fixtures/manifest.json /repo/packages/fixtures/fixtures/manifest.json
COPY apps/console/ ./
RUN npm run "build:${CONSOLE_MODE}" \
  && node scripts/check-bundle.mjs \
  && node scripts/check-certification-caveat.mjs

FROM ${NGINX_IMAGE} AS runtime
# SPA-fallback rewrite (8.4b handoff (a), plan §4 invariant 14): the console's
# PAGE PATHS (/validators, /governance, …) must serve index.html or every
# deep verify link 404s at the host. The CSP response header is layered by
# the ingress from the same overlay facts (handoff (b)); this nginx conf
# serves only bytes and the rewrite.
COPY infra/deploy/docker/console-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/console/dist /usr/share/nginx/html
