# ToolPlane

ToolPlane is a self-hosted control plane for agent tools, skills, MCP servers,
toolkits, and sandboxes. It gives a workspace one place to discover, run,
compose, observe, and attach capabilities to agents.

This is a private repository.

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
docker compose up -d postgres
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
  --token <one-time-token> \
  --root ~/toolplane-sandbox
```

The connector opens a WebSocket session to ToolPlane. ToolPlane then proxies
shell execution, file operations, and terminal streams through that session.

## Deployment Notes

ToolPlane should run as a single, always-on Node process because MCP and sandbox
deployments are supervised in memory. Use a VM, VPS, or container host rather
than serverless functions.

Docker Compose runs Postgres and the app. The app image includes the Docker CLI
for Docker-source MCP deployments; those deployments use the configured Docker
daemon, so keep that host access restricted.

## Private GitHub Setup

Recommended repository settings:

- Visibility: private
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
