# MCP Station

A self-hosted hub for the **Model Context Protocol** — browse a directory of MCP
servers, **deploy and actually run** them as live processes, compose them into
toolkits, and build agents that call them (and each other).

![docker](https://github.com/asharca/mcp-station/actions/workflows/docker.yml/badge.svg)

> The MCP runtime is real, not mocked: each deployment is a live Node child
> process managed by a supervisor, and the console proxies tool calls to it.

---

## What it is

One Next.js app with three zones:

1. **Public directory** (`/`) — browse MCP servers, clients and skills. No auth.
2. **Console** (`/app/[workspace]`) — authenticated workspace. Deploy MCP servers
   (catalog or custom from npm / PyPI / GitHub / Docker), group them into
   **toolkits**, install **skills**, and run **agents**.
3. **JSON API** (`/api/v1`) — MCP JSON-RPC gateway, toolkit/workspace manifests,
   skill/plugin endpoints, and the agent chat endpoint.

## Features

- **Real MCP runtime** — deploying a server spawns a child process (`npx` / `uvx`
  / `docker run`), bridged to an HTTP JSON-RPC gateway. A supervisor tracks live
  state and reconciles it against the database; a boot reconciler re-spawns
  running deployments after a restart.
- **Toolkits** — freely group a workspace's deployed servers + installed skills,
  each exporting its own manifest.
- **Auto-sync install** — install a toolkit into Claude Code as a single local
  plugin via `curl … | bash`: MCP tools stay live each session, skills sync via a
  SessionStart hook, and usage is reported back (skill-invocation / sync
  telemetry surfaced on the Observability → Plugin tab).
- **Agents** — bind a model provider + model, a system prompt, and tool sources
  (servers, skills, toolkits). An agent can also **delegate to sub-agents** in the
  same workspace (each runs its own loop with its own model), bounded by cycle +
  depth guards.
- **Observability** — every gateway call is logged; usage, latency (incl. p95),
  errors, and plugin telemetry are aggregated live.

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Prisma 7 (`@prisma/adapter-pg`)
· PostgreSQL · Vercel AI SDK v6 (`@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`)
· Tailwind · Vitest. **Package manager: pnpm only.**

---

## Quick start (local dev)

Requires **Node 20+**, **pnpm**, and **Docker** (for Postgres).

```bash
cp .env.example .env          # set DATABASE_URL, AUTH_SECRET, NEXT_PUBLIC_APP_URL
docker compose up -d postgres # Postgres on :5433 (user/pass/db = mcp/mcp/mcpmarket)
pnpm install
pnpm db:migrate               # apply migrations
pnpm tsx scripts/smoke-seed.ts  # seed a test account → smoke@example.com / password123
pnpm dev                      # http://localhost:3000
```

> Restart the dev server after adding/changing a Prisma model — the running
> process keeps the stale client otherwise.

## Self-hosted deployment (Docker)

The app spawns long-lived child processes and keeps them in an in-memory table,
so it must run as a **single, always-on Node process** — **not** on serverless
(Vercel functions / Lambda). A VM, VPS, or container host works.

One command brings up the app + Postgres:

```bash
# .env needs at least:
#   AUTH_SECRET=<openssl rand -hex 32>
#   NEXT_PUBLIC_APP_URL=https://your-domain   # baked at build time
docker compose up --build -d
```

The entrypoint runs `prisma migrate deploy` (retrying until the DB is up) then
`next start`; on boot the app re-spawns deployments the DB marks as running.

The runtime image bundles `npx` (npm/GitHub sources), `uv`/`uvx` (PyPI sources),
and the `docker` CLI (Docker sources). Docker-source MCPs run via the **host**
Docker daemon — `docker-compose.yml` mounts `/var/run/docker.sock`, which grants
the container host-root-equivalent power. Comment that mount out if you don't use
Docker-source MCPs.

CI builds and publishes the image to **GHCR** on every push to `main` and on
`v*` tags: `ghcr.io/asharca/mcp-station` (private — `docker login ghcr.io` to pull).

## Commands

```bash
pnpm dev                                  # next dev on :3000
pnpm build                                # next build
pnpm lint                                 # eslint
pnpm test                                 # vitest run (unit + integration)
pnpm vitest run tests/unit/auth.test.ts   # a single test file
pnpm db:migrate                           # prisma migrate dev
pnpm db:generate                          # prisma generate
pnpm db:studio                            # prisma studio
pnpm test:e2e                             # node e2e/dashboard.e2e.mjs (needs dev running)
```

## Architecture

- **Route groups** — `src/app/(site)/**` (public), `src/app/app/(auth)/**` (login/
  signup), `src/app/app/[workspace]/**` (console).
- **Process supervisor** (`src/lib/process/supervisor.ts`) — spawns/tracks MCP
  child processes on `globalThis` (survives HMR); `effectiveStatus` reconciles the
  live table against the DB.
- **Gateway** (`/api/v1/mcp/[deploymentId]/rpc`) — auth → workspace check → proxy
  to the live process → log to `RequestLog`.
- **Agents** (`src/lib/agents/*`) — `resolveAgentTools` → `buildAgentToolSet`
  (MCP tools + sub-agent tools) + `assembleSystemPrompt` + `buildModel`, run with
  the AI SDK's `streamText` / `generateText`.

The canonical deep reference is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
(written in Chinese; trust the code where it and the doc disagree).

---

A personal project — a 1:1 study clone of mcpmarket.com that grew its own MCP
runtime, agent system, and self-hosting setup.
