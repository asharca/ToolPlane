# ToolPlane — Architecture

> **中文**：[ARCHITECTURE.md](./ARCHITECTURE.md)
>
> ToolPlane is a self-hosted agent tool control plane: a **standalone public product site**, a **signed-in console with a real marketplace and MCP/Agent/Sandbox runtimes**, an **admin console**, and a **JSON API**.

---

## 1. Overview

ToolPlane is an MCP (Model Context Protocol) and agent ecosystem platform with four functional areas:

1. **Public product site** `(site)` — showcases ToolPlane's value and capabilities only; never reads or mirrors real MCP/Skill/Agent marketplace data.
2. **Console / Hub** `app/[workspace]` — the signed-in workspace: browse the real marketplace, deploy MCP servers, install skills and agents, **freely assemble** resources into Toolkits, run agents (Native / Hermes sandbox), chat assistants, knowledge bases, Work task flows, call tools through the gateway, and inspect observability.
3. **Admin console** `admin/` — administrators review marketplace entries and manage the catalog (Servers/Skills/Agents/Assistants/categories), users, workspaces, system settings, and log auditing.
4. **JSON API** `api/v1/*` + `api/openai/v1/*` — MCP JSON-RPC gateway, skill downloads, Toolkit/workspace manifest export, the Agent public API, the Agent Control MCP, channel events, and admin endpoints; also exposes `api/v1/openapi.json`.

Key trait: MCPs in the console are not mock data — a deployment can be a builtin child process, a remote MCP (streamable-http / sse), or a Docker bridge container; the gateway proxies requests to it and records observability.

Topic docs:

- [`docs/TOOLKIT_SYNC.md`](./TOOLKIT_SYNC.md) — how Toolkits sync to Claude Code, Codex, opencode, Hermes
- [`docs/SANDBOXES.md`](./SANDBOXES.md) — Agent sandbox Docker/Connector runtime
- [`docs/HERMES_AGENT_RUNTIME.md`](./HERMES_AGENT_RUNTIME.md) — Hermes-first agent runtime architecture
- [`docs/AGENT_MESSAGING_PLATFORMS.md`](./AGENT_MESSAGING_PLATFORMS.md) — Telegram/Lark(Feishu)/QQ/WeChat/Discord/Slack channels
- [`docs/AGENT_PUBLIC_API.md`](./AGENT_PUBLIC_API.md) — public API for published Agent Endpoints and deployment topology constraints
- [`docs/AGENT_CONTROL_MCP.md`](./AGENT_CONTROL_MCP.md) — workspace-level Agent Control MCP
- [`docs/OBSERVABILITY.md`](./OBSERVABILITY.md) — unified logging/audit model, capture and retention
- [`docs/WORKSPACES.md`](./WORKSPACES.md) — workspace members, invitations, deletion lifecycle
- [`docs/UI_LIBRARY.md`](./UI_LIBRARY.md), [`docs/RELEASES.md`](./RELEASES.md) — shared UI package and release process

---

## 2. Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.2.9 (App Router + Turbopack), React 19.2 |
| Language | TypeScript 5 (Node >= 22) |
| Styling | Tailwind CSS v4 + shared UI package `@asharca/ui` (published to npm, source in a separate repo) |
| Theme | next-themes (`class` strategy, dark/light) |
| i18n | next-intl (`messages/en.json`, `messages/zh.json`) |
| ORM | Prisma 7.8 + `@prisma/adapter-pg` driver adapter + `pg` |
| Database | PostgreSQL |
| Auth | jose (signs/verifies JWT session cookies) + hashed API tokens + Agent API keys; admins identified via `ADMIN_EMAILS` |
| Agent/Chat | Vercel AI SDK 7 (`ai` + `@ai-sdk/react`), assistant-ui, streamdown |
| MCP | `@modelcontextprotocol/sdk`, in-house gateway/bridges (`mcp-http-bridge` / `mcp-stdio-bridge`) |
| Channels | grammy (Telegram), `@larksuiteoapi/node-sdk` (Feishu), etc. |
| Terminal/Desktop | node-pty + xterm, noVNC (sandbox screen), ws |
| Icons | lucide-react, @primer/octicons-react |
| Testing | Vitest 4 (~1800+ cases: 259 unit files, 56 integration files, a few `.live.` cases), raw Playwright library for e2e |

Key environment variables (`.env.example`): `DATABASE_URL`, `AUTH_SECRET`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPPORT_EMAIL`, `ADMIN_EMAILS`, `CONNECTOR_WS_*` (Connector onboarding), `HERMES_DASHBOARD_*`, `TOOLPLANE_IMAGE/PLATFORM/UPDATE_*` (self-update), `TOOLPLANE_MCP_STARTUP_*` (startup timeouts).

---

## 3. Top-Level Architecture

```
                          ┌──────────────────────────────────────────┐
   Browser                │            Next.js (App Router)           │
   ──────                 │                                          │
   Public visitor ──────► │  (site)  Static product marketing        │
   Signed-in user ──────► │  app/[workspace]  Console + real market  │
   Administrator ───────► │  admin/  Review, catalog, users, logs    │
   Agent / CLI ─────────► │  api/v1/* + api/openai/v1/*  JSON API    │
                          └───────┬──────────────┬───────────────────┘
                                  │              │
              ┌───────────────────▼───────┐  ┌───▼────────────────────────┐
              │ MCP Deployment runtime    │  │ Agent Runtime              │
              │ builtin child process /   │  │ Native in-process /        │
              │ Docker bridge container / │  │ Hermes container + volume /│
              │ remote MCP (HTTP/SSE)     │  │ Sandbox: Docker/Connector  │
              └───────────────────────────┘  └────────────────────────────┘
```

**Route groups:**

- `src/app/(site)/...` — standalone public product site, static marketing content only, **never reads real marketplace or personal data**.
- `src/app/app/(auth)/...` — login/signup (URLs `/app/login`, `/app/signup`).
- `src/app/app/[workspace]/...` — workspace console wrapped in `DashboardChrome`; plus `@modal` intercepting routes (e.g. the settings/account modal).
- `src/app/admin/...` — admin console (own layout, admin required).
- `src/app/api/v1/...`, `src/app/api/openai/v1/...` — UI-less JSON routes.

---

## 4. Directory Layout

```
src/
├─ app/
│  ├─ (site)/            Static public product site (page/server/client/agents/
│  │                     categories/daily/leaderboards/news/search/sell/submit/
│  │                     privacy/terms/what-is-an-mcp-server)
│  ├─ app/
│  │  ├─ page.tsx                /app → restore/select workspace (see WORKSPACES.md)
│  │  ├─ (auth)/login, signup    /app/login, /app/signup
│  │  └─ [workspace]/   Workspace console: mcp, skills, toolkits, market/{mcp,skills,
│  │                     agents,assistants,toolkits,installed,items,publish},
│  │                     agents, chat, knowledge, work,
│  │                     sandboxes, providers, observability, members, seller,
│  │                     settings{,/account,/tokens,/channels,/providers}, @modal
│  ├─ admin/            Admin console: agents, assistants, categories, logs,
│  │                     market, reviews, servers, settings, skills, users, workspaces
│  └─ api/
│     ├─ v1/            Main JSON API (see §10)
│     └─ openai/v1/     OpenAI-compatible endpoints (models, chat/completions)
├─ components/
│  ├─ layout/  home/  cards/  server/  theme/  timezone/  marketing/  auth/
│  ├─ dashboard/        All console components (Chrome/Sidebar/Header/Tabs,
│  │                    MCP inspector, ToolPlayground, Toolkits, Agent, chat, ...)
│  ├─ admin/            Admin console components
│  └─ ui/               Local primitives (shared components mostly come from @asharca/ui)
├─ lib/
│  ├─ auth/        session(jose), tokens, password, current-user, request-user,
│  │               safe-redirect, actions, token-format
│  ├─ process/     supervisor, spawn-spec(builtin/remote/bridge), mcp-gateway,
│  │               deployment-gateway, deployment-runtime-container,
│  │               deployment-config-volume, mcp-client, mcp-tool-catalog,
│  │               mcp-prompts, mcp-resources, mcp-result-redaction,
│  │               reconcile, sandbox, sandbox-mcp-client, git-source
│  ├─ agents/      Agent domain: run/native/sandbox-runtime/hermes/, channels/,
│  │               control-mcp, control-service, public-api/, market*, messaging,
│  │               conversation-*, model/provider catalog, platform runner, ...
│  ├─ sandboxes/   Sandboxes: connector*(WS onboarding/auth/broker), runtime, images,
│  │               reconcile, file-list, actions/queries
│  ├─ chat/        Chat assistants: service, branches, web-search
│  ├─ work/        Work task flows: coordinator, sessions, state-machine, run-control
│  ├─ knowledge/   Knowledge bases
│  ├─ market/      Unified marketplace: listings, artifact, skill/assistant manifest,
│  │               copy-updates, publisher-management, secret-scan
│  ├─ observability/ events(LogEvent), log, audit, http, queries, redaction,
│  │               maintenance, settings, system, plugin-telemetry
│  ├─ workspace/ toolkits/ skills/ seller/ admin/ system/ security/ http/
│  ├─ attachments/ plugin/ remote-mcp/ i18n/ marketing/ queries/
│  └─ db.ts        Prisma client + pg adapter
├─ i18n/            next-intl config
scripts/
│  ├─ mcp-server.mjs / mcp-tools.mjs     Builtin demo MCP server and tools
│  ├─ mcp-http-bridge.mjs / mcp-stdio-bridge.mjs / sandbox-mcp-server.mjs
│  ├─ native-runtime-session.mjs / dsh-runtime-driver.mjs   Agent runtime drivers
│  ├─ assemble-runtime.mjs / start-server.cjs / bridge-env.mjs  Packaging and startup
│  └─ smoke-seed.ts / seed-real-mcp-skills.ts / import-*.ts / sync-tp-skills.ts
packages/
│  ├─ connector/    Sandbox host-side Connector (`pnpm connector:dev`)
│  └─ ui/           (placeholder; shared UI moved to the separate @asharca/ui repo)
runtime/migrator/   Deployment migrator
prisma/
│  ├─ schema.prisma (68 models)
│  └─ migrations/   72 migrations (0_init … 20260908000000_workspace_lifecycle)
tests/ (unit/ integration/ stubs/), e2e/
```

---

## 5. Data Model (Prisma)

**68 models**, grouped by domain:

**Catalog content**

- `Server` — MCP servers (slug, recipe/verification, deployment source); `Client` — MCP clients; `Skill` — skills (GitHub/registry sources, bundles); `Category` — linked to Server/Client/Skill/marketplace entries; `DailySnapshot` — daily ranking snapshots.

**Accounts & workspaces**

- `User` (locale, timeZone, status, roles), `ApiToken` (prefix + tokenHash, can be Toolkit-scoped), `PasswordResetToken`.
- `Workspace` (unique slug, owner, lifecycle state active/deleting/delete_failed, model preferences), `Membership`, `WorkspaceInvitation` (one-time invitations, hash only), `WorkspaceAttachment`.

**MCP runtime**

- `Deployment` — a Server or custom source deployed in a workspace (`source`/`installCfg`, `status`, `mcpToolExposure`/`mcpAllowedTools` tool-exposure control, `publicInvocable` public-invocation gate).
- `DeploymentConfigFile` — deployment config files (materialized as a managed volume mounted into the container).
- `InstalledSkill`, `SkillInvocation` (plugin telemetry), `Sandbox`, `SandboxSnapshot`.

**Toolkits**

- `Toolkit` (`visibility`, `enabled`), `ToolkitServer` (↔ Deployment), `ToolkitSkill` (↔ InstalledSkill), `ToolkitInstallLink` (install share links).

**Unified marketplace**

- `MarketListing` — unified marketplace entries (MCP/Skill/Agent/Assistant, namespace + slug, categories, review state); `MarketRelease` — immutable releases; `MarketInstall` — install records (incl. requested release).

**Agent domain**

- `Agent` + composition links: `AgentServer` (MCP), `AgentSkill`, `AgentToolkit`, `AgentSubAgent`, `AgentKnowledgeBase`, `AgentComposerPrompt`, `AgentAttachment`, `AgentModelProvider`.
- `AgentRuntime` (kind: native/hermes, explicitly chosen), `AgentSandbox` (exclusive binding), `AgentRun`.
- Marketplace/publishing: `AgentListing`, `AgentRelease`, `AgentInstall`.
- Messaging platforms: `AgentChannelConnection` (channel credentials/binding/sandbox scope), `Conversation`, `Message`.
- Public API: `AgentEndpoint`, `AgentEndpointRevision`, `AgentEndpointRuntime`, `AgentApiClient`, `AgentApiKey`, `AgentApiUsageBucket`, `AgentApiMaintenanceLease`, `AgentPublicConversation`.

**Chat assistants**

- `ChatAssistant` (configuration + marketplace origin), `ChatAssistantMcpGrant` (MCP grants), `ChatThread`, `ChatTurn`, `ChatMessage` (branch support).

**Work task flows**

- `WorkSession` (coordinator-driven background execution), `WorkApproval` (human approval gates).

**Knowledge bases**

- `KnowledgeBase`, `KnowledgeDocument`, `KnowledgeChunk`.

**Model providers**

- `ModelProvider`, `ProviderModel` (model catalog available to Hermes/Agents).

**Observability & system**

- `LogEvent` (searchable event metadata + trace/span), `LogDetail` (scoped diagnostic payload, 7-day retention), `AuditEvent` (append-only audit) — see OBSERVABILITY.md.
- `SystemSetting` (admin settings), `SyncEvent` (Toolkit sync events).

---

## 6. Auth & Sessions

- **Sessions**: `lib/auth/session.ts` signs JWTs with `AUTH_SECRET` via `jose`, stored in an HTTP-only cookie.
- **Passwords**: hashed/verified in `lib/auth/password.ts`; password recovery uses one-time `PasswordResetToken` (the `account:reset-password` script resets manually).
- **API tokens**: user-level; `lib/auth/tokens.ts` creates (one-time plaintext)/verifies/revokes; can be bound to a Toolkit as a scoped token. Personal tokens are managed at `/app?view=account` (legacy workspace tokens pages redirect there).
- **Agent API keys**: public Agent Endpoints use separate `AgentApiClient`/`AgentApiKey`; usage is limited by `AgentApiUsageBucket`.
- **Dual-channel auth**: `resolveRequestUser(req)` tries `Authorization: Bearer <token>` first, then falls back to the session cookie.
- **Admins**: identified by the `ADMIN_EMAILS` env var; access `/admin/*` and `api/v1/admin/*`.

---

## 7. Public Product Site `(site)`

The public site is strictly decoupled from the marketplace: pages read only the standalone bilingual static content in `lib/marketing/content.ts` and never import `lib/db`, `lib/queries`, workspace, or current-user modules.

- **Home** `/` + capability pages `/server`, `/client`, `/agents`.
- **Directory-style pages** `/categories`, `/search`, `/leaderboards`, `/daily` — marketing presentations/fixed redirects, no real DB queries.
- **Static/landing** `/news`, `/sell`, `/submit` (enters the signed-in console), `/privacy`, `/terms`, `/what-is-an-mcp-server`.

`tests/unit/public-site-boundary.test.ts` recursively checks public pages' dependency graphs to keep real marketplace queries out of the front site.

---

## 8. Console / Hub `app/[workspace]`

`layout.tsx` resolves the workspace and session, then renders `DashboardChrome` (grouped sidebar + header + mobile drawer). Sidebar organization is persisted (see #122).

### 8.1 MCP servers
- `/mcp` — deployed list; `/market/mcp`, `/market/mcp/[serverSlug]` — signed-in marketplace (admin-verified entries with resolvable recipes only).
- `/mcp/[deploymentId]` — inspector: Overview / Variables / **Tools** (`ToolPlayground` live `tools/list` + invocation) / Logs / **Terminal** (PTY stream) / **Runtime files** (`DeploymentConfigFile` editor); supports Connect/Restart/Stop/Rebuild and MCP JSON config editing.

### 8.2 Skills / Toolkits
- `/skills`, `/market/skills`, `/skills/[installId]` (SKILL.md preview/copy/download).
- `/toolkits`, `/toolkits/[slug]` — freely assemble deployed MCPs and installed Skills; export manifests, generate install links; sync mechanics in TOOLKIT_SYNC.md.

### 8.3 Agents / Chat / Knowledge / Work / Sandboxes / Providers
- `/agents`, `/agents/[agentId]` — agent management and runs (runtime kind chosen explicitly: native or hermes sandbox); `/market/agents` installs marketplace templates as independent copies; publishing goes `/agents/[agentId]/publish` → admin review at `/admin/agents`.
- `/chat` — assistant conversations (`ChatAssistant` + threads/branches/turns, MCP grants via `ChatAssistantMcpGrant`).
- `/knowledge` — knowledge bases (documents → chunks).
- `/work` — Work task-flow sessions and approvals.
- `/sandboxes` — sandbox management (Docker/Connector, snapshots, screen sessions).
- `/providers` — model provider and model catalog configuration.
- `/market/assistants` — assistant marketplace.

### 8.4 Observability
- `/observability` — Usage / Audit log; stat cards, p95, hourly distribution. Data comes from the unified `LogEvent` (`gateway.request` semantics), aggregated live in Postgres. See OBSERVABILITY.md for the model and semantics.

### 8.5 Members / Settings / Seller
- `/members` — member table, invitations (7-day one-time links), removal/leave (see WORKSPACES.md).
- `/settings` — name/slug, default model, ownership transfer, Danger-zone deletion (`deleting` state machine + process/container/volume cleanup).
- `/settings/channels` — messaging platform channels (Telegram/Feishu/QQ/WeChat/Discord/Slack, see AGENT_MESSAGING_PLATFORMS.md).
- `/settings/providers` — workspace-level model provider credentials.
- `/settings/tokens` — legacy entry; personal API tokens actually live at `/app?view=account`.
- `/settings/account` — account settings (with `@modal` intercepted modal).
- `/seller` → `/seller/overview` — publish skills + my listings.

---

## 9. Admin Console `/admin`

- `/admin` — overview; `/admin/reviews`, `/admin/reviews/market/[id]` — marketplace entry/release review.
- `/admin/market`, `/admin/servers`, `/admin/skills` (incl. `/skills/import`), `/admin/agents`, `/admin/assistants`, `/admin/categories` — catalog and unified marketplace management (create/edit/feature/verify).
- `/admin/users`, `/admin/workspaces` — account and workspace governance.
- `/admin/logs`, `/admin/logs/[id]` — structured event search and diagnostic details (viewing/exporting is itself audited).
- `/admin/settings` — system settings (`SystemSetting`: MCP startup timeouts, remote-MCP private-network restrictions, diagnostic capture windows, self-update, etc.).

---

## 10. JSON API

The main API lives under `api/v1` (88 routes), plus OpenAI-compatible endpoints `api/openai/v1/models` and `api/openai/v1/chat/completions`; machine-readable definition at `GET /api/v1/openapi.json`. Grouped by domain:

| Domain | Representative paths | Notes |
|---|---|---|
| MCP gateway | `POST /v1/mcp/[deploymentId]/rpc`, `GET .../health`, `.../runtime`, `.../files/upload`, `.../terminal/*` | Proxies JSON-RPC to the deployment runtime; PTY terminal sessions; records observability |
| Skills | `GET /v1/skills/[installId]/download`, `.../skill.md` | Artifact download |
| Workspace/Toolkit | `GET /v1/workspaces/[slug]/manifest`, `.../toolkits/[toolkitSlug]/{manifest,install,mcp}`, `.../attachments`, `.../market/installs*` | Manifest export, install links, Toolkit MCP aggregation |
| Agent control | `POST /v1/workspaces/[slug]/agents/mcp` | Agent Control MCP (personal Bearer only, see AGENT_CONTROL_MCP.md) |
| Agent runs | `/v1/agents/[agentId]/{chat,messages,conversations*,composer,prompts,terminal,attachments,hermes/*}` | Console agent sessions/operations/commands |
| Agent public API | `/v1/agent-endpoints/[endpointId]/{responses*,conversations/*,client-tokens}` | External execution of published Endpoints (topology constraints in AGENT_PUBLIC_API.md) |
| Agent runtime callbacks | `/v1/agent-runtime/{mcp,model}/...`, `/v1/agent-runtimes/[runtimeId]/{mcp,dashboard/*}` | In-sandbox runtime callback entry points (signed-grant auth) |
| Channels | `/v1/agent-channels/[connectionId]/events`, `/v1/workspaces/[slug]/agent-channels` | Messaging platform event intake |
| Chat assistants | `/v1/chat/assistants*`, `/v1/chat/threads/[threadId]/{turns,branches,composer,prompts}` | Assistants/threads/turns/branches |
| Work | `/v1/work-sessions*` (events/input/cancel/resume/approvals/sandbox) | Task-flow driving and approvals |
| Knowledge | `/v1/knowledge*` (documents/search/agents) | Knowledge base CRUD and search |
| Marketplace | `/v1/market/listings*` (download) | Unified marketplace reads |
| Sandboxes | `/v1/workspaces/[slug]/sandboxes/{hermes-import,[sandboxId]/connector-status,screen/*}` | Sandbox status, noVNC screen frames |
| Connector | `/v1/connectors/{bootstrap,package.tgz}` | Sandbox host Connector onboarding |
| Plugin/sync | `/v1/plugin/{baseline,sync-applied,sync-failure,skill-invocation}`, `/v1/skill-registries/tp-skills/webhook` | Toolkit sync telemetry and registry webhook |
| Admin | `/v1/admin/{logs/export,system/update,agent-releases/[releaseId]/manifest}` | Log export, self-update, release manifests |
| Misc | `/v1/health`, `/v1/attachments/[attachmentId]` | Health check, attachments |

**Gateway flow** (`/mcp/[id]/rpc`): auth → verify deployment ownership → locate runtime (builtin child-process port / Docker container / remote URL) → forward (with timeout) → persist `LogEvent` (`gateway.request`; HTTP 200 with an RPC error still counts as failure).

---

## 11. MCP Runtime (`lib/process`)

- `spawn-spec.ts` — three deployment sources: `builtin` (built-in demo server), `remote` (remote MCP over streamable-http/sse; private-network restrictions in admin settings), `bridge` (arbitrary commands inside a Docker container, JSON-RPC exposed via a bridge; git sources are cloned first).
- `supervisor.ts` — child-process table on `globalThis.__mcpSupervisor` (survives dev HMR); startup parsing, readiness timeouts, log files, redaction values, watchdog.
- `deployment-runtime-container.ts` / `deployment-gateway.ts` — Docker container naming/removal and the in-container gateway; `deployment-config-volume.ts` materializes `DeploymentConfigFile` into a managed volume.
- `mcp-client.ts` / `sandbox-mcp-client.ts` / `mcp-gateway.ts` — server-side RPC wrappers and tool aggregation; `mcp-tool-catalog(-store).ts` caches tool catalogs; `mcp-prompts.ts`, `mcp-resources.ts`, `mcp-result-redaction.ts`.
- `reconcile.ts` — reconciles DB state against actual processes/containers.
- `sandbox.ts` — network/image/cache flags; `git-source.ts` — git source detection.

## 12. Agent Runtime

- **Native runtime** — lightweight in-process agents (direct model calls + MCP/Skill tool loop).
- **Hermes runtime** — each agent gets its own Docker container, persistent volume, and API key; containers cannot reach Postgres and hold no user-level token (see HERMES_AGENT_RUNTIME.md).
- **Sandboxes** — Docker, or remote hosts via Connector (`packages/connector`, WS onboarding), providing PTY terminals, files, and a noVNC screen; MCP tools are exposed to agents (see SANDBOXES.md).
- Runtime callbacks (model/MCP) go through `/api/v1/agent-runtime/*` with signed grants carrying trace ancestry.

---

## 13. Testing

- **Unit/integration** (Vitest 4, ~1800+ cases): `tests/unit/*` (259 files), `tests/integration/*` (56 files covering db, admin, agent, market, runtime, workspace, ...; `*.live.test.ts` needs real Docker/network).
- `server-only` is stubbed via `tests/stubs`; the public-site boundary is guarded by `public-site-boundary.test.ts`.

---

## 14. Local Development & Ops Notes

```bash
pnpm dev            # next dev (:3000)
pnpm db:migrate     # prisma migrate dev
pnpm db:generate    # prisma generate
pnpm db:seed        # test account/workspace seed
pnpm test           # vitest run
pnpm connector:dev  # local Connector (remote sandbox host)
```

- **Restart the dev server after adding Prisma models**: `prisma generate` only updates the on-disk client; a running Next process keeps the old one.
- Prisma 7: use `migrate diff --to-schema` (not `--to-schema-datamodel`); `prisma.config.ts` auto-loads dotenv.
- Releases use release-please (see RELEASES.md); the version of record is `package.json` and the CHANGELOG (currently 0.29.0).

---

## 15. Known Gaps / Limitations

- Some commercialization flows (Seller payout, Billing, Stripe, OAuth sign-in) are not wired up.
- Agent public API execution currently supports exactly one runtime-owning process/replica (process-local supervisor/queue, see AGENT_PUBLIC_API.md).
- Workspace deletion cleanup dedupes within a single admin-service process; multi-worker deployments need a renewable DB cleanup lease first (see WORKSPACES.md).
- Log storage is best-effort diagnostics (events can be lost on crash/overload), not a durable external queue (see OBSERVABILITY.md).
