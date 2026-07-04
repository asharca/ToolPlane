# syntax=docker/dockerfile:1
#
# toolplane — self-hosted image.
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
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

# The app issues one `docker run` per custom MCP (through the socket proxy), so
# it needs the docker CLI. npx/uvx run INSIDE those per-MCP wrapper containers,
# not here, so the app image doesn't bundle them.
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker

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
