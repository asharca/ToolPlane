# syntax=docker/dockerfile:1
#
# mcp-market — self-hosted image.
#
# NOT serverless-compatible: the app spawns long-lived MCP child processes
# (scripts/mcp-*.mjs) and keeps them in an in-memory table, so it must run as a
# single, always-on Node process. The runtime image bundles npx (node), uv/uvx
# (PyPI-source MCPs) and the docker CLI (docker-source MCPs); docker-source MCPs
# additionally need the host Docker socket mounted (see docker-compose.yml).

ARG NODE_IMAGE=node:24-bookworm-slim
ARG PNPM_VERSION=10.14.0

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

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ARG PNPM_VERSION
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# uv/uvx for PyPI-source MCPs (uv fetches a managed Python at runtime); docker
# CLI for docker-source MCPs (talks to the mounted host daemon socket).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker

# Full node_modules (prisma is a devDependency and is needed for the startup
# `migrate deploy`), the built app, and the files referenced at runtime.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
# Spawned by the supervisor via process.cwd()/scripts — Next never bundles them.
COPY --from=build /app/scripts ./scripts
# Needed by `prisma migrate deploy` on startup.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
