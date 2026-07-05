# ToolPlane

ToolPlane is a self-hosted control plane for agent tools, skills, MCP servers,
toolkits, and sandboxes. It gives a workspace one place to discover, run,
compose, observe, and attach capabilities to agents.

The repository is public, while each deployment keeps its own credentials,
workspace data, and runtime containers private.

## What It Does

- Browse MCP servers, MCP clients, and agent skills from a public directory.
- Deploy catalog or custom MCP servers from npm, PyPI, GitHub, or Docker.
- Compose deployed servers and skills into reusable toolkits.
- Install toolkits into Claude Code, Codex, and OpenCode-style clients with
  synced MCP and skill bundles.
- Build agents that use model providers, MCP tools, skills, toolkits,
  sub-agents, and sandboxes.
- Run Docker Linux sandboxes or user-machine connectors through a one-command
  WebSocket CLI.
- Observe gateway calls, latency, errors, and plugin sync telemetry.

## Architecture

One Next.js app serves three surfaces:

1. **Directory site** (`src/app/(site)/**`) for public browsing and discovery.
2. **Workspace console** (`src/app/app/[workspace]/**`) for authenticated
   runtime management.
3. **JSON API** (`src/app/api/v1/**`) for MCP JSON-RPC, toolkit manifests,
   connector bootstrap, plugin sync, skill downloads, and agent chat.

The runtime is real, not mocked. Each MCP deployment is a live child process
managed by `src/lib/process/supervisor.ts`, and the gateway proxies JSON-RPC
requests to the live process while recording observability data.

## Quick Start

Requirements:

- Node.js 20+
- pnpm
- Docker

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
pnpm install
pnpm db:migrate
pnpm tsx scripts/smoke-seed.ts
pnpm dev
```

Default smoke account:

```txt
smoke@example.com / password123
```

Local app URL:

```txt
http://localhost:3000
```

## Common Commands

```bash
pnpm dev
pnpm build
pnpm lint
pnpm test
pnpm test:e2e
pnpm db:migrate
pnpm db:generate
pnpm db:studio
pnpm connector:dev
```

Use `pnpm`; the lockfile is `pnpm-lock.yaml`.

## User Connector

User-machine sandboxes do not require SSH or Chisel. The user runs one command:

```bash
npx -y --package http://localhost:3000/api/v1/connectors/package.tgz connector connect \
  --server http://localhost:3000 \
  --token mcpcon_... \
  --root ~/toolplane-sandbox
```

The sandbox page generates the `mcpcon_...` token and stores only its hash.
The connector opens a WebSocket session to ToolPlane, then ToolPlane proxies
shell execution, file operations, and terminal streams through that session.

## Deployment Notes

ToolPlane should run as a single, always-on Node process because MCP and sandbox
deployments are supervised in memory. Use a VM, VPS, or container host rather
than serverless functions.

Docker Compose runs Postgres, a restricted Docker socket proxy, and the
prebuilt app image from GHCR:

```bash
docker compose pull app
docker compose up -d
```

The Compose app is published on `http://localhost:10030` by default. Override
`APP_HOST_PORT` if the host already uses that port.

Set `TOOLPLANE_IMAGE` when you want to pin a specific tag, for example
`ghcr.io/asharca/toolplane:sha-dc33d7f`. The published deployment image is
`linux/amd64`; `TOOLPLANE_PLATFORM` defaults to that for server deployments.

The app image includes the Docker CLI for Docker-source MCP deployments and for
admin-triggered online updates. It talks to Docker only through the restricted
socket proxy, so keep that proxy private to the Compose network.

Admins can update a deployed instance from the workspace sidebar, directly
under the ToolPlane logo. The update action pulls `TOOLPLANE_IMAGE`, creates a
replacement app container with the same Compose runtime settings, then starts a
short-lived helper container that stops the old app and starts the replacement.
This is intentionally a container replacement, not a plain restart, because
restarting would keep the old image.

The app image also bundles the Hermes Python adapters used by hosted agent
messaging channels. The GitHub image build downloads the pinned Hermes source
archive, installs the required messaging extras into
`/opt/toolplane-hermes-venv`, and points the app at `/opt/hermes-agent`.
Local `pnpm dev` can still use `TOOLPLANE_HERMES_ROOT` and `TOOLPLANE_PYTHON`
when you want to run those channel workers outside Docker.

For local debugging, layer `docker-compose.dev.yml` on top to expose Postgres on
`127.0.0.1:5433` and the connector broker port when running the app in Docker.

## GitHub Setup

Recommended repository settings:

- Default branch protection on `main`
- Required checks: `pnpm lint`, `pnpm test`, `pnpm build`
- Secrets: deployment credentials, registry credentials, production env vars

Suggested repository description:

```txt
ToolPlane: self-hosted control plane for agent tools, MCP servers, skills, toolkits, and sandboxes.
```

## References

- Deep architecture notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Sandbox and connector design: [docs/SANDBOXES.md](docs/SANDBOXES.md)
- Toolkit sync design: [docs/TOOLKIT_SYNC.md](docs/TOOLKIT_SYNC.md)
