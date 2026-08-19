# Build from the repo root: docker build -f apps/console/Dockerfile .
# Config is baked per Vite profile (spec §7); all three checked-in profiles are
# built in, and CONSOLE_PROFILE (devnet | test | production) selects one at start.
FROM node:22-bookworm-slim AS build
WORKDIR /repo/apps/console
COPY apps/console/package.json apps/console/package-lock.json ./
RUN npm ci
# vite.config.ts reads ../../packages/fixtures/fixtures/manifest.json.
COPY packages/fixtures /repo/packages/fixtures
COPY apps/console/ ./
RUN npm run build && mv dist dist-production \
  && npm run build:test && mv dist dist-test \
  && npm run build:devnet && mv dist dist-devnet

FROM nginxinc/nginx-unprivileged:1.28
COPY --from=build /repo/apps/console/dist-production /usr/share/nginx/profiles/production
COPY --from=build /repo/apps/console/dist-test /usr/share/nginx/profiles/test
COPY --from=build /repo/apps/console/dist-devnet /usr/share/nginx/profiles/devnet
COPY <<'EOF' /etc/nginx/templates/default.conf.template
server {
  listen 8080;
  root /usr/share/nginx/profiles/${CONSOLE_PROFILE};
  location / {
    try_files $uri /index.html;
  }
}
EOF
ENV CONSOLE_PROFILE=test
EXPOSE 8080
