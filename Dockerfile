# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
ARG CADDY_IMAGE=caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d

FROM ${NODE_IMAGE} AS dependencies
ARG PNPM_VERSION=10.33.0
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update \
 && apt-get install --yes --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /app/runtime
COPY runtime/package.json runtime/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY seed-profiles /opt/dsh-seed
COPY config /app/config
COPY scripts/build-seed-profile.mjs /app/scripts/build-seed-profile.mjs
COPY scripts/brand-auth-gate-login.mjs /app/scripts/brand-auth-gate-login.mjs
COPY scripts/enable-remote-settings.mjs /app/scripts/enable-remote-settings.mjs
RUN node /app/scripts/enable-remote-settings.mjs --runtime /app/runtime \
 && pnpm --dir /opt/dsh-seed/base install --frozen-lockfile --prod \
 && pnpm --dir /opt/dsh-seed/workbench install --frozen-lockfile --prod \
 && auth_smoke_home="$(mktemp -d)" \
 && printf '%s\n' 'build-only-auth-gate-password' | DSH_HOME="$auth_smoke_home" node /opt/dsh-seed/base/node_modules/dsh-auth-gate/lib/cli.js user add build-smoke --password-stdin \
 && test -s "$auth_smoke_home/auth/users.yaml" \
 && node /app/scripts/brand-auth-gate-login.mjs --profile /opt/dsh-seed/base \
 && node /app/scripts/brand-auth-gate-login.mjs --profile /opt/dsh-seed/workbench \
 && node /app/scripts/build-seed-profile.mjs --preset base --profile /opt/dsh-seed/base \
 && node /app/scripts/build-seed-profile.mjs --preset workbench --profile /opt/dsh-seed/workbench

FROM ${CADDY_IMAGE} AS caddy

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install --yes --no-install-recommends tini util-linux ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 dsh \
 && useradd --uid 10001 --gid dsh --no-create-home --home-dir /data/workspace --shell /usr/sbin/nologin dsh

WORKDIR /app
COPY --from=dependencies /app/runtime /app/runtime
COPY --from=dependencies /opt/dsh-seed /opt/dsh-seed
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY config /app/config
COPY src /app/src
COPY scripts /app/scripts
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod 0755 /app/docker/entrypoint.sh \
 && /usr/bin/caddy fmt --overwrite /app/config/Caddyfile \
 && mkdir -p /data/dsh /data/dsh-server /data/workspace \
 && chown dsh:dsh /data/dsh /data/dsh-server /data/workspace

ENV DSH_HOME=/data/dsh \
    DSH_SERVER_HOME=/data/dsh-server \
    WORKSPACE_ROOT=/data/workspace \
    HOME=/data/workspace \
    DSH_INTERNAL_PORT=3080 \
    STATUS_PORT=9000 \
    DSH_UI_PRESET=base \
    DSH_SETUP_PROTECTION=open

EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "const fs = require('node:fs'); let headers = {}; try { headers = { Host: JSON.parse(fs.readFileSync('/data/dsh-server/runtime-config.json', 'utf8')).trustedHost }; } catch {} fetch('http://127.0.0.1:8080/healthz', { headers }).then((res) => process.exit(res.status === 200 ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
