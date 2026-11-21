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

ARG NODE_IMAGE=node:26-bookworm-slim
ARG PNPM_VERSION=10.14.0
ARG SANDBOX_BASE_IMAGE=mcr.microsoft.com/devcontainers/javascript-node:26-bookworm

# ---- sandbox: default Agent workspace, independent of the application image ----
FROM ${SANDBOX_BASE_IMAGE} AS sandbox
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium python3 fonts-liberation fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
ENV TOOLPLANE_CHROMIUM_PATH=/usr/bin/chromium
# Keep the original devcontainer's root user: managed workspace volumes start
# root-owned, and the trusted turn preparer bootstraps HOME/SDK state there.
# Runtime isolation still drops all capabilities and forbids privilege escalation.
WORKDIR /workspace

# ---- mcp-runtime: managed stdio commands, no application files or credentials ----
FROM node:26-bookworm AS mcp-runtime
ARG PNPM_VERSION
COPY --from=ghcr.io/astral-sh/uv:0.11.16 /uv /uvx /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends build-essential default-jre-headless python3-pip python-is-python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-update-notifier pnpm@${PNPM_VERSION} bun@1.3.13 deno@2.7.12 \
    && install -d -o node -g node /workspace
ENV HOME=/tmp DENO_DIR=/tmp/deno BUN_INSTALL_CACHE_DIR=/tmp/bun-cache
WORKDIR /workspace
USER node
ENTRYPOINT []

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
WORKDIR /opt/pi-sdk
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git; \
    rm -rf /var/lib/apt/lists/*; \
    npm install --global --no-update-notifier pnpm@${PNPM_VERSION}
# The actual SDK entry anchors its locked semver/undici dependency resolution.
RUN node -e "require('node:fs').writeFileSync('package.json', JSON.stringify({name:'pi-sdk',private:true,pnpm:{overrides:{semver:'7.8.5',undici:'8.12.3'}}}))" \
    && pnpm add --prod --ignore-scripts --save-exact --config.auto-install-peers=false @earendil-works/pi-coding-agent@1.5.2 \
    && node --input-type=module -e "import {createRequire} from 'node:module'; import {realpathSync} from 'node:fs'; const r=createRequire(realpathSync('/opt/pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/index.js')); if(r('semver/package.json').version!=='7.8.5'||r('undici/package.json').version!=='8.12.3')process.exit(1)"
# Distribute debugpy separately from the immutable SDK archive. No sandbox
# network is required, and existing SDK installations are not replaced.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-pip \
    && python3 -m pip install --no-cache-dir --no-compile --no-deps --target /opt/toolplane-tools/debugpy debugpy==1.8.17 \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/pi-package-capture.mjs scripts/pi-package-archive.py scripts/omp-plugin-resources.mjs /app/scripts/
WORKDIR /app
USER node
ENTRYPOINT ["node", "/app/scripts/pi-package-capture.mjs"]

# ---- sandbox-desktop: Agent sandbox image with a takeover-capable desktop ----
# Agent sandboxes run `sleep infinity`; the entrypoint starts a loopback-only
# VNC display, openbox and Chromium (CDP on loopback) before that command.
# ToolPlane relays the display through `docker exec`; no port is published.
FROM sandbox AS sandbox-desktop
RUN set -eux; \
    echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      fonts-noto-color-emoji \
      imagemagick \
      openbox \
      tigervnc-standalone-server \
      tini \
      x11-xserver-utils \
      xdotool; \
    rm -rf /var/lib/apt/lists/*
COPY --chmod=755 scripts/sandbox-desktop-entrypoint.sh /usr/local/bin/toolplane-desktop
ENV TOOLPLANE_DESKTOP_DISPLAY=:1 \
    TOOLPLANE_DESKTOP_RFB_PORT=5900 \
    TOOLPLANE_DESKTOP_CDP_PORT=9222 \
    TOOLPLANE_DESKTOP_SIZE=1280x800
LABEL io.toolplane.desktop.rfb-port="5900" \
      io.toolplane.desktop.size="1280x800"
# tini reaps Chromium descendants orphaned to PID 1 when the browser restarts.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/toolplane-desktop"]
CMD ["sleep", "infinity"]

# ---- lsp-tools: independent optional tool artifact; never alters the SDK image ----
FROM pi-package-capture AS lsp-tools
USER root
WORKDIR /opt/toolplane-lsp
RUN node -e "require('node:fs').writeFileSync('package.json', JSON.stringify({name:'toolplane-lsp',private:true}))" \
    && pnpm add --prod --ignore-scripts --save-exact --config.auto-install-peers=false typescript-language-server@5.0.1 typescript@5.9.3 pyright@1.1.407
USER node
ENTRYPOINT ["node"]

# ---- deps: full workspace install for the build stages ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ARG PNPM_VERSION
RUN npm install --global --no-update-notifier pnpm@${PNPM_VERSION}
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
RUN npm install --global --no-update-notifier pnpm@${PNPM_VERSION}
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
    && chown -R node:node /app

# Non-root: the app reaches Docker over TCP via the proxy, so it needs no socket
# group membership.
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
