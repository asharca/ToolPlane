# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal 1:1 clone of mcpmarket.com. Three distinct zones share one Next.js app:

1. **Public directory site** — `src/app/(site)/**` — browse/search MCP servers, clients, and skills. No auth, no personal data. Server Components read Prisma directly via `src/lib/queries/*`.
2. **Console / Hub** — `src/app/app/[workspace]/**` — authenticated workspace. Deploying an MCP server **spawns a real Node subprocess** running a JSON-RPC server; the console proxies tool calls to it and records observability.
3. **JSON API** — `src/app/api/v1/**` — MCP JSON-RPC gateway, skill downloads, toolkit/workspace manifests, and the **agent chat** endpoint.

The MCP runtime is real, not mocked: each `Deployment` = one live child process managed by `src/lib/process/supervisor.ts`.

`docs/ARCHITECTURE.md` is the canonical deep reference (written in Chinese). **It predates the agents feature** — it still calls `/agents` a "Coming soon" placeholder, but agents are now fully implemented (see "Agent runtime" below). Trust the code over that doc where they conflict.

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
pnpm test:e2e                  # node e2e/dashboard.e2e.mjs — needs `pnpm dev` already running

pnpm db:migrate                # prisma migrate dev
pnpm db:generate               # prisma generate
pnpm db:studio                 # prisma studio
```

Database is Postgres via `docker-compose.yml` (port **5433**, user/pass/db all `mcp`/`mcp`/`mcpmarket`). Copy `.env.example` → `.env`. Required vars: `DATABASE_URL`, `AUTH_SECRET` (JWT signing), `NEXT_PUBLIC_APP_URL`.

Seed a test account: run `scripts/smoke-seed.ts` with tsx (`pnpm tsx scripts/smoke-seed.ts`) → `smoke@example.com` / `password123`. Scrapers in `scraper/*.ts` and the seed are standalone tsx scripts (they `import 'dotenv/config'` and use the `@/` path alias).

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

### Agent runtime (newer than ARCHITECTURE.md)
An `Agent` belongs to a workspace and binds: a `ModelProvider` + model id, an optional system prompt, `maxSteps`, and tool sources (attached `AgentServer`s, `AgentSkill`s, and whole `AgentToolkit`s). Chat lives at `POST /api/v1/agents/[agentId]/chat` (`runtime = 'nodejs'`), built on the **Vercel AI SDK v6** (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`, `@ai-sdk/react`):

- `src/lib/agents/resolve.ts` `resolveAgentTools()` — dedupes the agent's directly-attached + toolkit-derived deployments and skills into `{ deploymentIds, skills }`.
- `src/lib/agents/tools.ts` `buildToolSet()` — for each **running** deployment, lists its MCP tools and wraps each as an AI-SDK `tool` whose `execute` proxies through `mcpRpc(..., 'tools/call', ...)`. Tool keys are `<dep8>__<toolName>` (sanitized).
- `src/lib/agents/system-prompt.ts` — concatenates the agent's base prompt with each attached skill's `SKILL.md` (via `src/lib/skills/artifact.ts`).
- `src/lib/agents/model.ts` `buildModel()` — provider `format === 'anthropic'` → `createAnthropic`, otherwise `createOpenAICompatible`. Providers store `baseUrl` + `apiKey`; `models` are fetched dynamically (`src/lib/agents/models-fetch.ts`).
- The route uses `streamText` + `convertToModelMessages` (async in v6) + `stepCountIs(agent.maxSteps)`, and persists user/assistant turns to `Conversation`/`Message` only when `conversationId` belongs to that agent. Messages store AI-SDK `parts` as JSON; the UI renders assistant replies as markdown via Streamdown.

### Data model
Prisma schema (`prisma/schema.prisma`) splits into directory content (`Server`, `Client`, `Skill`, `Category`, `DailySnapshot`, `ScrapeCheckpoint`) and runtime/account state (`User`, `ApiToken`, `Workspace`, `Membership`, `Deployment`, `InstalledSkill`, `RequestLog`, `Toolkit*`, `ModelProvider`, `Agent*`, `Conversation`, `Message`). Note: the legacy `User.hubServers` Hub-favorites relation was removed in code but may linger in schema — the Hub feature is gone; toolkits replaced it.

## Security invariants to preserve

- Every workspace-scoped query/mutation must verify the resource belongs to the caller's workspace (past IDOR bugs were fixed here — gateway, manifests, agent chat conversation scoping).
- Never persist a chat turn to a conversation that doesn't belong to the agent in the URL.
- API tokens: return plaintext exactly once on creation; only the hash is stored.
