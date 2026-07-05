# syntax=docker/dockerfile:1
#
# toolplane — self-hosted image.
#
# NOT serverless-compatible: the app spawns long-lived MCP child processes
# (scripts/mcp-*.mjs) and keeps them in an in-memory table, so it must run as a
# single, always-on Node process. The runtime image bundles Node, the docker CLI
# for docker-source MCPs, and Hermes Python runners for hosted agent messaging;
# docker-source MCPs additionally need the host Docker socket mounted (see
# docker-compose.yml).

ARG NODE_IMAGE=node:24-bookworm-slim
ARG PNPM_VERSION=10.14.0
ARG HERMES_REPO=https://github.com/NousResearch/hermes-agent.git
ARG HERMES_REF=7e8f50a14176e02b514631b0b04470acaadae32a
ARG HERMES_ARCHIVE_URL=

# ---- python runtime base: shared by app runtime and Hermes build stage ----
FROM ${NODE_IMAGE} AS python-runtime-base
RUN set -eux; \
    echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries; \
    echo 'Acquire::http::Timeout "30";' >> /etc/apt/apt.conf.d/80-retries; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      python3; \
    rm -rf /var/lib/apt/lists/*

# ---- deps: full install (incl. dev) for build + runtime prisma CLI ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build: prisma generate + next build ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm exec prisma generate
# NEXT_PUBLIC_* is baked into the client bundle at build time, so it must be set
# here. DATABASE_URL only needs to be *present* — src/lib/db.ts throws on import
# if it is unset — and every data page is force-dynamic, so no real database is
# contacted during the build. AUTH_SECRET is read lazily at request time, so the
# build does not need it.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- hermes: source checkout + Python deps for hosted messaging channels ----
FROM python-runtime-base AS hermes
WORKDIR /opt
ARG HERMES_REPO
ARG HERMES_REF
ARG HERMES_ARCHIVE_URL
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      python3-venv; \
    rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    repo="${HERMES_REPO%.git}"; \
    archive_url="${HERMES_ARCHIVE_URL:-${repo}/archive/${HERMES_REF}.tar.gz}"; \
    node -e "const fs = require('node:fs'); const [url, out] = process.argv.slice(1); fetch(url).then((res) => { if (!res.ok) throw new Error(res.status + ' ' + res.statusText); return res.arrayBuffer(); }).then((buf) => fs.writeFileSync(out, Buffer.from(buf)));" "$archive_url" /tmp/hermes-agent.tgz; \
    mkdir -p /opt/hermes-agent; \
    tar -xzf /tmp/hermes-agent.tgz --strip-components=1 -C /opt/hermes-agent; \
    rm /tmp/hermes-agent.tgz; \
    cd /opt/hermes-agent \
    && python3 -m venv /opt/toolplane-hermes-venv \
    && /opt/toolplane-hermes-venv/bin/python -m pip install --upgrade pip setuptools wheel \
    && /opt/toolplane-hermes-venv/bin/pip install ".[messaging,wecom,dingtalk]" \
    && chown -R node:node /opt/hermes-agent /opt/toolplane-hermes-venv

# ---- runtime ----
FROM python-runtime-base AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HERMES_ROOT=/opt/hermes-agent \
    TOOLPLANE_HERMES_ROOT=/opt/hermes-agent \
    TOOLPLANE_PYTHON=/opt/toolplane-hermes-venv/bin/python

# The app issues one `docker run` per custom MCP (through the socket proxy), and
# it starts hosted Python runners for native agent messaging channels.
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=hermes --chown=node:node /opt/hermes-agent /opt/hermes-agent
COPY --from=hermes --chown=node:node /opt/toolplane-hermes-venv /opt/toolplane-hermes-venv

# Full node_modules (prisma is a devDependency, needed for the startup
# `migrate deploy`), the built app, and the files referenced at runtime — all
# owned by the non-root `node` user.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/next.config.ts ./next.config.ts
# Spawned by the supervisor via process.cwd()/scripts — Next never bundles them.
COPY --from=build --chown=node:node /app/scripts ./scripts
# Needed by `prisma migrate deploy` on startup.
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Non-root: the app reaches Docker over TCP via the proxy, so it needs no socket
# group membership.
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
