# syntax=docker/dockerfile:1
#
# toolplane — self-hosted image.
#
# NOT serverless-compatible: the app spawns long-lived MCP child processes
# (scripts/mcp-*.mjs) and keeps them in an in-memory table, so it must run as a
# single, always-on Node process. The runtime image bundles Node, the docker CLI
# for docker-source MCPs, and Python for agent archive imports;
# docker-source MCPs additionally need the host Docker socket mounted (see
# docker-compose.yml).

ARG NODE_IMAGE=node:24-bookworm-slim
ARG PNPM_VERSION=10.14.0

# ---- Python is used only for agent archive imports, not channels ----
FROM ${NODE_IMAGE} AS python-runtime-base
RUN set -eux; \
    echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries; \
    echo 'Acquire::http::Timeout "30";' >> /etc/apt/apt.conf.d/80-retries; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      gzip \
      openssh-client \
      python3 \
      tar; \
    rm -rf /var/lib/apt/lists/*

# ---- pi-package-capture: isolated package capture sandbox ----
# Used to capture npm/git packages for the Pi extension market.
# Runs as non-root node user; network=none at runtime; proxy via stdin/stdout.
FROM python-runtime-base AS pi-package-capture
ARG PNPM_VERSION
ENV COREPACK_HOME=/opt/corepack COREPACK_DEFAULT_TO_LATEST=0
WORKDIR /opt/pi-sdk
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git; \
    rm -rf /var/lib/apt/lists/*; \
    corepack enable; \
    corepack prepare pnpm@${PNPM_VERSION} --activate; \
    chmod -R a+rX /opt/corepack
# The actual SDK entry anchors its locked semver/undici dependency resolution.
RUN node -e "require('node:fs').writeFileSync('package.json', JSON.stringify({name:'pi-sdk',private:true,pnpm:{overrides:{semver:'7.8.5',undici:'8.10.2'}}}))" \
    && pnpm add --prod --ignore-scripts --save-exact --config.auto-install-peers=false @earendil-works/pi-coding-agent@0.87.1 \
    && node --input-type=module -e "import {createRequire} from 'node:module'; import {realpathSync} from 'node:fs'; const r=createRequire(realpathSync('/opt/pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/index.js')); if(r('semver/package.json').version!=='7.8.5'||r('undici/package.json').version!=='8.10.2')process.exit(1)"
COPY scripts/pi-package-capture.mjs scripts/pi-package-archive.py /app/scripts/
WORKDIR /app
USER node
ENTRYPOINT ["node", "/app/scripts/pi-package-capture.mjs"]

# ---- deps: full workspace install for the build stages ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/connector/package.json ./packages/connector/package.json
COPY runtime/migrator/package.json runtime/migrator/pnpm-lock.yaml runtime/migrator/pnpm-workspace.yaml ./runtime/migrator/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile \
    && pnpm --config.auto-install-peers=false --dir runtime/migrator install --prod --frozen-lockfile

# ---- build: prisma generate + next build ----
# Match runtime OpenSSL so assembly bundles the engine used by offline migrations.
FROM python-runtime-base AS build
WORKDIR /app
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/connector/node_modules ./packages/connector/node_modules
COPY --from=deps /app/runtime/migrator/node_modules ./runtime/migrator/node_modules
COPY . .
RUN pnpm exec prisma generate
# NEXT_PUBLIC_* is baked into the client bundle at build time, so it must be set
# here. DATABASE_URL only needs to be *present* — src/lib/db.ts throws on import
# if it is unset — and every data page is force-dynamic, so no real database is
# contacted during the build. AUTH_SECRET is read lazily at request time, so the
# build does not need it.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG TOOLPLANE_VERSION=dev
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm runtime:assemble

# Exported by the release workflow so the tarball and image use the exact same
# assembled runtime files.
FROM scratch AS runtime-artifact
COPY --from=build /app/dist/release/app/ /

# ---- runtime ----
FROM python-runtime-base AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# The app issues one `docker run` per custom MCP through the socket proxy.
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker

# The assembler combines Next's traced standalone output with the dynamic MCP,
# connector, native PTY, and isolated migration runtimes.
COPY --from=build --chown=node:node /app/dist/release/app/ ./

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /var/lib/toolplane/imports \
    && chown -R node:node /app /var/lib/toolplane

# Non-root: the app reaches Docker over TCP via the proxy, so it needs no socket
# group membership.
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
