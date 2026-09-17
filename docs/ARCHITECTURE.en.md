# ToolPlane — Architecture

> **中文**：[ARCHITECTURE.md](./ARCHITECTURE.md)
>
> ToolPlane is a self-hosted agent tool control plane with a standalone public product site, a signed-in console with a real marketplace and MCP/Agent/Sandbox runtimes, an admin console, and JSON APIs. This document is for developers locating implementation entry points and understanding system boundaries.

---

## 1. Overview

The platform has four functional areas:

1. **Public product site** `(site)`: presents product capabilities without reading or mirroring real MCP, Skill, or Agent marketplace data.
2. **Console / Hub** `app/[workspace]`: browses the real marketplace, deploys MCPs, installs skills and agents, assembles Toolkits, runs Pi, Claude Code, DeepSeek Harness (DSH), or Hermes agents, and provides chat assistants, knowledge bases, Work flows, and observability.
3. **Admin console** `admin/`: reviews marketplace entries and manages catalogs, users, workspaces, settings, and auditing.
4. **JSON APIs** `api/v1/*` + `api/openai/v1/*`: MCP gateways, skill downloads, manifest export, the public Agent API, Agent Control MCP, channel events, and administration.

An MCP deployment can be a builtin child process, remote MCP (Streamable HTTP / SSE), or Docker bridge container. The gateway forwards real requests rather than returning marketplace demo data.

Topic entry points:

| Topic | Document |
|---|---|
| Toolkit sync | [TOOLKIT_SYNC.en.md](./TOOLKIT_SYNC.en.md) |
| Docker / Connector sandboxes | [SANDBOXES.md](./SANDBOXES.md) |
| Hermes runtime | [HERMES_AGENT_RUNTIME.en.md](./HERMES_AGENT_RUNTIME.en.md) |
| Messaging channels | [AGENT_MESSAGING_PLATFORMS.md](./AGENT_MESSAGING_PLATFORMS.md) |
| Public Agent API | [AGENT_PUBLIC_API.md](./AGENT_PUBLIC_API.md) |
| Agent Control MCP | [AGENT_CONTROL_MCP.md](./AGENT_CONTROL_MCP.md) |
| Logging and audit | [OBSERVABILITY.md](./OBSERVABILITY.md) |
| Workspace lifecycle | [WORKSPACES.en.md](./WORKSPACES.en.md) |
| UI and releases | [UI_LIBRARY.md](./UI_LIBRARY.md), [RELEASES.md](./RELEASES.md) |

## 2. Tech Stack

Dependency versions and Node requirements are defined by [`package.json`](../package.json) and the lockfile, rather than a second version inventory maintained in prose.

| Layer | Choice |
|---|---|
| Application | Next.js App Router, React, TypeScript |
| Styling | Tailwind CSS and the published `@asharca/ui` package |
| Theme / i18n | next-themes, next-intl (`messages/en.json`, `messages/zh.json`) |
| Data | PostgreSQL, Prisma, `@prisma/adapter-pg`, `pg` |
| Authentication | jose-signed JWT sessions, hashed API tokens, separate Agent API keys |
| Agent / chat | `@earendil-works/pi-ai` and sandbox runtimes; AI SDK UI message streams, assistant-ui, streamdown |
| MCP | `@modelcontextprotocol/sdk`, platform gateways and HTTP/stdio bridges |
| Channels | Node adapters including grammy and `@larksuiteoapi/node-sdk` |
| Terminal / desktop | node-pty, xterm, noVNC, ws |
| Icons | lucide-react, @primer/octicons-react |
| Testing | Vitest; test entry points and environments are defined in `vitest.config.ts`, `tests/`, and CI |

See [`.env.example`](../.env.example) for configuration including `DATABASE_URL`, `AUTH_SECRET`, `NEXT_PUBLIC_APP_URL`, `ADMIN_EMAILS`, `CONNECTOR_WS_*`, `HERMES_DASHBOARD_*`, startup, and self-update settings. An environment example does not establish a common authentication policy for every route.

## 3. Top-Level Architecture

```text
Browser / CLI / Agent
  -> Next.js App Router
       |-- (site): static product site
       |-- app/[workspace]: console and real marketplace
       |-- admin: administration
       `-- api/v1 + api/openai/v1: JSON / MCP APIs
             |-- MCP Deployment
             |    |-- builtin child process
             |    |-- Docker bridge
             |    `-- remote HTTP / SSE
             `-- Agent Runtime
                  |-- Pi / Claude Code / DSH: dedicated sandboxes
                  `-- Hermes: dedicated container and /opt/data volume

Generic Sandboxes (Docker / User Connector) separately expose files, PTYs, and MCP tools.
```

Route groups do not appear in URLs. `src/app/app/(auth)` serves `/app/login` and `/app/signup`; `src/app/app/[workspace]` is the workspace UI with `DashboardChrome`; `src/app/admin` has its own admin gate. API authorization must not rely on the UI's permission checks.

## 4. Directory Layout

These are implementation entry points, not an exhaustive file inventory:

```text
src/
  app/
    (site)/                    static public product site
    app/(auth)/                login and signup
    app/page.tsx               account entry, workspace restoration/selection
    app/[workspace]/           workspace console
    admin/                     admin console
    api/v1/                    platform APIs
    api/openai/v1/             OpenAI-compatible adapter
  components/
    dashboard/                 console components
    admin/                     admin components
    ui/                        application-local primitives
  lib/
    auth/                      sessions, tokens, account and admin policies
    process/                   MCP supervisor, bridges, catalogs, config volumes
    agents/                    runtime selection, execution, control and public APIs
      hermes/                  Hermes projection, proxying, lifecycle
    sandboxes/                 Docker / Connector, files and runtimes
    chat/                      assistants, threads, branches
    work/                      coordinator, sessions, approvals, run control
    knowledge/                 knowledge bases
    market/                    listings, releases, installs, reviews
    observability/             LogEvent, LogDetail, AuditEvent
    workspace/                 members, invitations, deletion
    toolkits/ skills/ plugin/   toolkits, skills, client synchronization
    marketing/                 static public-site content
    db.ts                      Prisma + pg adapter
scripts/                       runtime drivers, packaging, startup, imports, seeds
packages/connector/            user-host Connector
runtime/migrator/              deployment migrator
prisma/schema.prisma           authoritative data model
prisma/migrations/             database migration history
tests/                         unit/integration tests and stubs
```

Shared UI source is in the separate `asharca/ui` repository. ToolPlane consumes released `@asharca/ui`; do not treat `packages/ui` as a maintained local source entry point. Obtain model, migration, route, and test counts from current source or actual test reports rather than static numbers copied here.

## 5. Data Model (Prisma)

[`prisma/schema.prisma`](../prisma/schema.prisma) defines the complete fields and relationships. Main domains include:

| Domain | Main models |
|---|---|
| Catalog | `Server`, `Client`, `Skill`, `Category`, `DailySnapshot` |
| Accounts / workspaces | `User`, `ApiToken`, `PasswordResetToken`, `Workspace`, `Membership`, `WorkspaceInvitation`, `WorkspaceAttachment` |
| MCP / Sandbox | `Deployment`, `DeploymentConfigFile`, `InstalledSkill`, `SkillInvocation`, `Sandbox`, `SandboxSnapshot` |
| Toolkit | `Toolkit`, `ToolkitServer`, `ToolkitSkill`, `ToolkitInstallLink` |
| Unified marketplace | `MarketListing`, `MarketRelease`, `MarketInstall` |
| Agent composition | `Agent`, `AgentServer`, `AgentSkill`, `AgentToolkit`, `AgentSubAgent`, `AgentKnowledgeBase`, `AgentModelProvider`, `AgentComposerPrompt`, `AgentAttachment` |
| Agent execution | `AgentRuntime`, `AgentSandbox`, `AgentRun`, `Conversation`, `Message`, `AgentChannelConnection` |
| Agent marketplace | `AgentListing`, `AgentRelease`, `AgentInstall` |
| Public Endpoints | `AgentEndpoint`, `AgentEndpointRevision`, `AgentEndpointRuntime`, `AgentApiClient`, `AgentApiKey`, `AgentApiUsageBucket`, `AgentApiMaintenanceLease`, `AgentPublicConversation` |
| Chat / Work | `ChatAssistant`, `ChatAssistantMcpGrant`, `ChatThread`, `ChatTurn`, `ChatMessage`, `WorkSession`, `WorkApproval` |
| Knowledge / models | `KnowledgeBase`, `KnowledgeDocument`, `KnowledgeChunk`, `ModelProvider`, `ProviderModel` |
| Logs / system | `LogEvent`, `LogDetail`, `AuditEvent`, `SystemSetting`, `SyncEvent` |

`Deployment.mcpToolExposure` / `mcpAllowedTools` control tool exposure; `publicInvocable` is an additional public-invocation gate. An `ApiToken` may be restricted to a Toolkit and must not be treated as an account-level token.

[`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts) defines the runtime identifiers `pi`, `claude-code`, `dsh`, `hermes`, and `hermes-rpc`. The internal filename `native.ts` does not establish a selectable `native` runtime.

## 6. Auth & Sessions

- **Sessions and passwords**: `lib/auth/session.ts` uses `jose` and `AUTH_SECRET` for HTTP-only session cookies; `lib/auth/password.ts` hashes passwords. Recovery uses one-time `PasswordResetToken`s, with an `account:reset-password` maintenance script.
- **Personal API tokens**: plaintext is returned once at creation; hashes are persisted. Manage them at `/app?view=account`. Toolkit installation tokens have additional resource-scope restrictions.
- **Different route policies**: in [`request-user.ts`](../src/lib/auth/request-user.ts), `resolveRequestUser` tries Bearer auth and then a session; `resolveAccountRequestUser` rejects Toolkit tokens; `resolveAgentControlRequestUser` requires an explicit valid account-level Bearer token and never accepts a cookie-only request.
- **Public Agent API**: a separate `AgentApiClient` / `AgentApiKey` system enforces scopes and budgets rather than reusing console sessions.
- **Administrators**: [`admin-policy.ts`](../src/lib/auth/admin-policy.ts) gates access on `user.role === 'admin'`, not an email allowlist checked in place of the role on each request. `ADMIN_EMAILS` is bootstrap configuration; suspended-account status must also be checked.

## 7. Public Product Site `(site)`

The public site is separate from the real marketplace. It reads bilingual static content in `lib/marketing/content.ts`, without importing database, workspace, or current-user queries.

The home page `/` and `/server`, `/client`, `/agents` present capabilities. `/categories`, `/search`, `/leaderboards`, `/daily` are marketing presentations or fixed redirects. `/news`, `/sell`, `/submit`, `/privacy`, `/terms`, and `/what-is-an-mcp-server` are static or landing entries. Real installation enters the signed-in console.

`tests/unit/public-site-boundary.test.ts` checks the dependency graph to keep marketplace queries out of the public site.

## 8. Console / Hub `app/[workspace]`

The workspace layout resolves authentication and access, then renders `DashboardChrome`. The following paths are under `/app/[workspace]`:

| Entry | Purpose |
|---|---|
| `/mcp`, `/market/mcp` | Deployed MCPs and the real marketplace |
| `/mcp/[deploymentId]` | Tool inspection/calls, logs, variables, PTY, runtime config files, lifecycle actions |
| `/skills`, `/market/skills`, `/skills/[installId]` | Skill installation, preview, copy, download |
| `/toolkits`, `/toolkits/[slug]` | Resource composition, manifests, install links, sync configuration |
| `/agents`, `/agents/[agentId]` | Explicit runtime selection, resource configuration, execution |
| `/market/agents`, `/agents/[agentId]/publish` | Independent template installs and publication for review |
| `/chat`, `/market/assistants` | Assistant conversations, threads, branches, marketplace |
| `/knowledge`, `/work` | Knowledge bases, task flows, approvals |
| `/sandboxes`, `/providers` | Sandboxes, snapshots, screens; model providers and catalogs |
| `/observability` | `LogEvent` / `gateway.request` metrics, percentiles, hourly aggregates |
| `/members`, `/settings` | Members and invitations; name, default model, ownership, deletion |
| `/settings/channels`, `/settings/providers` | Channel and model credentials |
| `/settings/tokens`, `/settings/account` | Legacy workspace entries for account settings; personal tokens live at `/app?view=account` |
| `/seller` | Publishing and existing listings |

Renaming a workspace does not change its URL slug. `/app` provides restoration, selection, and the no-workspace entry state, not unconditional workspace creation or entry into a default workspace. See [WORKSPACES.en.md](./WORKSPACES.en.md).

## 9. Admin Console `/admin`

`/admin` is the overview; `/admin/reviews` and `/admin/reviews/market/[id]` handle reviews. `/admin/market`, `/admin/servers`, `/admin/skills`, `/admin/agents`, `/admin/assistants`, and `/admin/categories` maintain catalogs and the marketplace. `/admin/skills/import` imports skills.

`/admin/users` and `/admin/workspaces` govern accounts and workspaces. `/admin/logs` and `/admin/logs/[id]` search events and diagnostic details; viewing and exporting also require auditing. `/admin/settings` manages startup timeouts, remote-MCP private-network restrictions, diagnostic capture, self-update, and other system settings.

## 10. JSON API

The paths below omit the shared `/api` prefix. This is domain navigation, not an exhaustive OpenAPI inventory; each `route.ts` defines actual methods and authorization. The public Agent API's machine-readable definition is available at `GET /api/v1/openapi.json`.

| Domain | Representative paths |
|---|---|
| MCP | `/v1/mcp/[deploymentId]/rpc`, `.../health`, `.../runtime`, `.../files/upload`, `.../terminal/*` |
| Skills | `/v1/skills/[installId]/download`, `.../skill.md` |
| Workspace / Toolkit | `/v1/workspaces/[slug]/manifest`, `.../toolkits/[toolkitSlug]/{manifest,install,mcp}`, `.../attachments`, `.../market/installs*` |
| Agent Control | `/v1/workspaces/[slug]/agents/mcp` (account-level Bearer only; creation accepts `pi` / `hermes` only) |
| Agent sessions | `/v1/agents/[agentId]/{chat,messages,conversations*,composer,prompts,terminal,attachments,hermes/*}` |
| Public Endpoints | `/v1/agent-endpoints/[endpointId]/{responses*,conversations/*,client-tokens}` |
| Runtime callbacks | `/v1/agent-runtime/{mcp,model}/...`, `/v1/agent-runtimes/[runtimeId]/{mcp,dashboard/*}` |
| Channels | `/v1/agent-channels/[connectionId]/events`, `/v1/workspaces/[slug]/agent-channels` |
| Chat | `/v1/chat/assistants*`, `/v1/chat/threads/[threadId]/{turns,branches,composer,prompts}` |
| Work / knowledge | `/v1/work-sessions*`, `/v1/knowledge*` |
| Marketplace | `/v1/market/listings*` |
| Sandbox / Connector | `/v1/workspaces/[slug]/sandboxes/...`, `/v1/connectors/{bootstrap,package.tgz}` |
| Plugin | `/v1/plugin/{baseline,sync-applied,sync-failure,skill-invocation}`, `/v1/skill-registries/tp-skills/webhook` |
| Admin / other | `/v1/admin/{logs/export,system/update,agent-releases/[releaseId]/manifest}`, `/v1/health`, `/v1/attachments/[attachmentId]` |

MCP gateway flow: authenticate → verify resource ownership → locate the actual process, container, or remote address → forward with a timeout → record `gateway.request`. HTTP 200 containing JSON-RPC `error` or MCP `isError` still counts as a business failure.

## 11. MCP Runtime (`lib/process`)

`spawn-spec.ts` resolves builtin, remote, bridge, and other startup sources. Bridges execute inside containers, with git sources prepared first. `supervisor.ts` tracks actual child processes, readiness, timeouts, redaction values, and logs; `reconcile.ts` compares persisted and live state.

`deployment-runtime-container.ts` and `deployment-gateway.ts` manage containers and gateways; `deployment-config-volume.ts` materializes configuration volumes. `mcp-client.ts`, `sandbox-mcp-client.ts`, and `mcp-gateway.ts` call and aggregate tools; tool catalogs, prompts, resources, and result redaction have dedicated modules.

A persisted running state does not prove a process is alive. Queries and actions must consider the supervisor's effective state.

## 12. Agent Runtime

| Runtime identifier | Current execution shape | Model configuration |
|---|---|---|
| `pi` | Dedicated sandbox, Pi runtime | `providerId` + `model` |
| `claude-code` | Dedicated sandbox, Claude Code harness | `providerId` + `model` |
| `dsh` | Dedicated sandbox, DeepSeek Harness | `providerId` + `model` |
| `hermes` | Dedicated Hermes container and `/opt/data` volume | Multi-select `AgentModelProvider`; Hermes manages model assignments |

Selection and capability checks live in [`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts); execution dispatch lives in [`run.ts`](../src/lib/agents/run.ts) and [`sandbox-turn.ts`](../src/lib/agents/sandbox-turn.ts). Pi, Claude Code, and DSH accept the provider formats `openai`, `openai-responses`, and `anthropic`; do not assume Hermes has the same configuration interface.

The internal `native.ts` helper uses `@earendil-works/pi-ai`. It is neither a public `native` runtime nor the old AI SDK `streamText` execution engine. The UI message-stream protocol and the model execution engine are separate layers.

Dedicated-runtime model/MCP callbacks use platform-signed grants, while Hermes's aggregate MCP uses a runtime-bound Bearer token. Hermes receives neither user-level ToolPlane tokens nor Postgres access, but selected provider keys are written into its private config volume. “Not exposed publicly” does not mean “absent from the container.” See [AGENT_PUBLIC_API.md](./AGENT_PUBLIC_API.md) for additional public Endpoint isolation and tool restrictions.

## 13. Testing

Unit and integration tests live in `tests/unit/` and `tests/integration/`; `*.live.test.ts` may require real Docker or network access. Tests stub `server-only`; integration runs sharing a database must not run concurrently against that database.

For documentation changes, check links, paths, commands, and contracts first; do not start services solely for prose. For behavior changes, run unit, integration, type, lint, and build checks according to impact. See [UI_LIBRARY.md](./UI_LIBRARY.md) for full CI and the release-metadata exception.

## 14. Local Development & Operations

```bash
pnpm dev            # Next.js development server
pnpm db:migrate     # prisma migrate dev; confirm the target database first
pnpm db:generate    # Generate Prisma client
pnpm db:seed        # Only against a confirmed local test database
pnpm test           # vitest run
pnpm connector:dev  # User-host Connector
```

After adding Prisma models and generating the client, restart development servers holding the old client. Prisma configuration lives in `prisma.config.ts`; migration diffs use `--to-schema`, not the old `--to-schema-datamodel` option.

Versions are defined in `package.json` and CHANGELOG. See [RELEASES.md](./RELEASES.md) for publishing. A successful ordinary PR CI run is not a published image; a release-metadata check is not a rerun of the full test suite.

## 15. Known Boundaries

The public Agent API supports one runtime-owning application process. A process-local supervisor, execution queue, and maintenance gate do not become multi-replica-safe merely because Postgres is used. Workspace deletion also has single-process cleanup/deduplication boundaries; distributed leases and coordination are needed before expanding that topology.

Logging is bounded best-effort diagnostics, not a lossless external queue. Diagnostic capture may retain sanitized user text; redaction is not anonymization. Public Agent API and Agent Control MCP payload policies differ; consult their respective topic documents.

The independent [Hermes RPC sandbox runtime](./HERMES_RPC_RUNTIME.md) uses platform single-model/resource bindings; managed Hermes is unchanged.
