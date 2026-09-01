# AGENTS.md

This file guides AI coding agents (pi, Codex, Claude Code, …) working in this repository. `CLAUDE.md` points here; `docs/` holds the deep feature references.

## What this is

ToolPlane is a self-hosted control plane for agent tools, MCP servers, skills,
toolkits, and sandboxes. Three distinct zones share one Next.js app:

1. **Public directory site** — `src/app/(site)/**` — browse/search MCP servers, clients, and skills. No auth, no personal data. Server Components read Prisma directly via `src/lib/queries/*`.
2. **Console** — `src/app/app/[workspace]/**` — authenticated workspace (agents, mcp, skills, toolkits, sandboxes, observability, market/seller, members, settings). Deploying an MCP server **spawns a real Node subprocess** running a JSON-RPC server; the console proxies tool calls to it and records observability.
3. **JSON API** — `src/app/api/v1/**` — MCP JSON-RPC gateway, skill downloads, toolkit/workspace manifests, **agent chat**, public **agent endpoints**, messaging **agent channels**, and the workspace **agent-control MCP** server.

The MCP runtime is real, not mocked: each `Deployment` = one live child process managed by `src/lib/process/supervisor.ts`.

`docs/ARCHITECTURE.md` is the deep reference for the core platform (written in Chinese). **It predates the agents feature** — for agents, read the feature docs instead: `docs/HERMES_AGENT_RUNTIME.md`, `docs/AGENT_MESSAGING_PLATFORMS.md`, `docs/AGENT_PUBLIC_API.md`, `docs/AGENT_CONTROL_MCP.md`, `docs/SANDBOXES.md`. Trust the code over any doc where they conflict.

## Commands

**Use pnpm — npm crashes in this repo and only `pnpm-lock.yaml` is committed.**

```bash
pnpm dev                       # next dev on :3000
pnpm build                     # next build
pnpm lint                      # eslint (flat config, next core-web-vitals + ts)
pnpm test                      # vitest run (unit + integration)
pnpm test:watch                # vitest watch
pnpm vitest run tests/unit/auth.test.ts          # single test file
pnpm vitest run -t "verifies token"              # single test by name

pnpm db:migrate                # prisma migrate dev
pnpm db:generate               # prisma generate
pnpm db:seed                   # tsx scripts/smoke-seed.ts
pnpm db:studio                 # prisma studio
```

Database is Postgres via `docker-compose.yml` plus the dev override (`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres`, port **5433**, user/pass/db all `mcp`/`mcp`/`toolplane`). Copy `.env.example` → `.env`. Required vars: `DATABASE_URL`, `AUTH_SECRET` (JWT signing), `NEXT_PUBLIC_APP_URL`.

Seed a test account: `pnpm db:seed` → `smoke@example.com` / `password123`. The seed is a standalone tsx script and imports `dotenv/config`.

## Critical gotchas

- **Restart the dev server after adding/changing a Prisma model.** `prisma generate` only rewrites the on-disk client; the running Next process keeps the stale client and you'll get `db.<model> is undefined` → 500.
- **Prisma 7**: uses `@prisma/adapter-pg` driver adapter (see `src/lib/db.ts`), not a direct connection string in the client. For manual migration diffs use `migrate diff --to-schema` (not `--to-schema-datamodel`). `prisma.config.ts` auto-loads dotenv.
- **Vitest runs test files sequentially** (`fileParallelism: false`) — integration tests share one Postgres DB and concurrent upserts of the same row race the unique constraint. Don't re-enable parallelism without isolating DB state.
- Tests stub `server-only` via `tests/stubs/server-only.ts` (aliased in `vitest.config.ts`). Files that do server work import `'server-only'` at the top.
- Trust `tsc` / `pnpm build` over the editor LSP for type errors here — the harness LSP can lag the generated Prisma client.

## Architecture notes that span multiple files

### Route groups (URL ≠ folder)
- `src/app/(site)/**` → public site, wrapped in `(site)/layout.tsx` (Header/Footer). No auth.
- `src/app/app/(auth)/{login,signup}` → URLs `/app/login`, `/app/signup`, centered auth layout.
- `src/app/app/[workspace]/**` → console, wrapped in `DashboardChrome` (sidebar + topbar). `/app` redirects to the default workspace.

### Dual-channel auth
`src/lib/auth/request-user.ts` `resolveRequestUser(req)` tries `Authorization: Bearer <token>` first, then falls back to the session cookie. This is why every `api/v1` route works for both CLI/agents (token) and the browser (cookie). Sessions are `jose` JWTs in an HTTP-only cookie (`src/lib/auth/session.ts`); API tokens are stored hashed (`tokenHash`, never plaintext) in `src/lib/auth/tokens.ts`. `getCurrentUser()` is React-`cache`d per request.

### MCP process supervisor
`src/lib/process/supervisor.ts` keeps the process table on `globalThis.__mcpSupervisor` so it survives dev HMR. `startProcess` spawns `scripts/mcp-server.mjs` with `MCP_PORT=0` (OS picks port), parses `LISTENING <port>` from stdout, and a ppid watchdog kills orphans. Pages and the gateway read live state via `liveStatus`/`livePort` and reconcile it against the DB `Deployment.status` (so a dead process doesn't show as "running"). `scripts/mcp-tools.mjs` holds the 5 built-in tools + `createRpcHandler()`. Server-side callers use `src/lib/process/mcp-client.ts` (`mcpRpc`, `listMcpTools`).

### Gateway flow (`POST /api/v1/mcp/[deploymentId]/rpc`)
auth → verify deployment belongs to the caller's workspace → `livePort()` → `fetch http://127.0.0.1:<port>/` (3s timeout) → pass-through → `logRequest` to `RequestLog`. 503 if process not running, 502 if unreachable. `RequestLog` is the real source for `/observability` (aggregated live, including p95).

### Toolkits = free assembly
A `Toolkit` freely groups a workspace's deployed MCPs (`ToolkitServer`) and installed skills (`ToolkitSkill`). Each toolkit exports its own manifest (`/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/manifest`); the workspace-level manifest exports everything. Backend actions in `src/lib/toolkits/actions.ts` all enforce workspace authorization — preserve that on any new mutation.

### Agent runtime
An `Agent` belongs to a workspace and binds: a model (single `ModelProvider` + model id for the native runtime, multiple via `AgentModelProvider` for Hermes), an optional system prompt, `maxSteps`, and tool sources (attached `AgentServer`s, `AgentSkill`s, `AgentToolkit`s, `AgentSandbox`es, and sub-agents via `AgentSubAgent`). Two runtimes:

- **Native** (default) — in-process, built on the **Vercel AI SDK v6** (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`, `@ai-sdk/react`).
- **Hermes** (`agent.runtime?.kind === 'hermes'`) — one Docker container + persistent volume per agent (`src/lib/agents/hermes/`). ToolPlane stays the control plane; the container never sees Postgres or provider keys. Docs: `docs/HERMES_AGENT_RUNTIME.md`.

Core flow:

- Chat: `POST /api/v1/agents/[agentId]/chat` (`runtime = 'nodejs'`) — `streamText` + `createUIMessageStreamResponse` + `convertToModelMessages` (async in v6) + `stepCountIs(resolveMaxSteps(agent.maxSteps))`; Hermes turns stream through `hermes/client.ts`. Turns persist to `Conversation`/`Message` via `mutations.ts` (`appendMessage`) only when the `conversationId` belongs to that agent. Messages store AI-SDK `parts` as JSON; the UI renders assistant replies as markdown via Streamdown/assistant-ui.
- `src/lib/agents/run.ts` `runAgentTurn()` — shared non-streaming engine for sub-agents (`AGENT_MAX_DEPTH = 3`, cycle guard); `resolve.ts` `resolveAgentTools()` dedupes directly-attached + toolkit-derived deployments/skills; `tools.ts` `buildToolSet()` wraps each **running** deployment's MCP tools as AI-SDK tools proxied via `mcpRpc` (keys `<dep8>__<toolName>`); `skill-tools.ts` builds the skill toolset; `system-prompt.ts` concatenates the base prompt + each skill's `SKILL.md`; `model.ts` `buildModel()` — `format === 'anthropic'` → `createAnthropic`, else `createOpenAICompatible` (models fetched dynamically via `models-fetch.ts`).
- **Sandboxes** — `AgentSandbox` exposes a workspace as MCP tools plus a PTY terminal (`/api/v1/agents/[agentId]/terminal/**`, `@xterm`). Docs: `docs/SANDBOXES.md`.
- **Messaging channels** — an `AgentChannelConnection` + `platforms.ts` (telegram/discord/slack/whatsapp/email/open_webui/…) connect an external ecosystem to one agent; `channel-*.ts` handle encrypted credentials, pairing, and the hosted runner. API: `src/app/api/v1/agent-channels/**`. Docs: `docs/AGENT_MESSAGING_PLATFORMS.md`.
- **Public API** — published `AgentEndpoint`s expose an OpenAI-compatible responses/conversations API through `src/lib/agents/public-api/**` (`src/app/api/v1/agent-endpoints/**`). Never exposes the Hermes container API, runtime tokens, or provider keys. Docs: `docs/AGENT_PUBLIC_API.md`.
- **Control MCP** — each workspace is a Streamable HTTP MCP server (`POST /api/v1/workspaces/[slug]/agents/mcp`) for creating/using agents from Claude Code/Codex/Cursor; `control-mcp.ts` + `control-service.ts`. Docs: `docs/AGENT_CONTROL_MCP.md`.
- **Market** — `AgentListing` (public metadata) → immutable `AgentRelease` (allowlisted manifest, no secrets) → `AgentInstall`; `market*.ts`. Console: `/app/[workspace]/market` (buy) + `seller` (publish).

### Data model
Prisma schema (`prisma/schema.prisma`) splits into directory content (`Server`, `Client`, `Skill`, `Category`, `DailySnapshot`) and runtime/account state (`User`, `PasswordResetToken`, `ApiToken`, `SystemSetting`, `Workspace`, `Membership`, `Deployment`, `DeploymentConfigFile`, `Sandbox*`, `InstalledSkill`, `RequestLog`, `Toolkit*`, `ModelProvider`, and the agent family: `Agent`, `AgentServer/Skill/Toolkit/Sandbox/SubAgent`, `AgentRuntime`, `AgentAttachment`, `AgentChannelConnection`, `AgentModelProvider`, `AgentListing/Release/Install`, `AgentEndpoint*`, `Conversation`, `Message`).

## Security invariants to preserve

- Every workspace-scoped query/mutation must verify the resource belongs to the caller's workspace (past IDOR bugs were fixed here — gateway, manifests, agent chat conversation scoping).
- Never persist a chat turn to a conversation that doesn't belong to the agent in the URL.
- Public endpoints are the only public door: they never expose the Hermes container API/dashboard, runtime tokens, provider keys, or MCP runtime tokens (`docs/AGENT_PUBLIC_API.md`).
- API tokens: return plaintext exactly once on creation; only the hash is stored.
