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

MCP marketplace releases support both remote connectors and container-isolated stdio servers. Workspace recipes may publish through the existing review flow without a pre-existing catalog entry; approval captures a real handshake/tools-list snapshot. Local recipes require exact npm/PyPI versions, full Git commit IDs, or Docker sha256 digests. JSON recipes preserve `command` (`npx`, `uvx`, `uv tool run`, or `docker`) and argv; no host shell is used. Releases export required environment names, never configured values, and reject credential-bearing argv. Install/update uses the reviewed recipe and existing Deployment/supervisor lifecycle: `setup_required` means missing configuration; install `ready` means configuration complete, not runtime readiness. Deployments start stopped until explicitly started; handshake and tools readiness come from the supervisor. MCP install/update APIs retain their existing request shapes.

“Recipe-pinned” is not an immutable runtime artifact: npm/PyPI transitive dependencies and the platform's wrapper images are not locked to bytes by this release format. Do not label these installs reproducible or content-addressed. Portable Git fetches are restricted to pinned HTTPS GitHub repositories and retain the existing sandbox network policy; reserved package-runner flags after the executable are rejected, even after a separator.

For an existing MCP market install, explicit `targetReleaseId` may select any still-approved release of the same published listing, including an earlier version. Omission selects the latest release. Restoration uses that release's recipe and reviewed tools snapshot while retaining target-workspace environment values; it does not change the listing's latest release or bypass local-change/concurrent-update guards.

Resource discovery projects `sourceKind` and structured `runtimeCompatibility` from selected approved releases, without returning executable snapshot contents. `listMarketListings` and `GET /api/v1/market/listings` accept `sourceKind` and `runtime=pi-sdk|mcp`; filters apply before pagination and counts and preserve public/workspace-private authorization. Pi `toolplane` provenance means composition; MCP remote transport distinguishes Streamable HTTP/SSE from container stdio. Unknown compatibility remains null rather than being guessed.

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
| Styling | Tailwind CSS and original beUI Registry source from `asharca/ui` |
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

Original beUI source is installed from the Registry at `https://asharca.github.io/ui/llms.txt`; ToolPlane keeps only domain adapters locally and does not consume the old `@asharca/ui` npm package. Obtain model, migration, route, and test counts from current source or actual test reports rather than static numbers copied here.

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

### 10.1 Assistant revisions, templates, and durable turns

Assistants use the bounded server-side conversation runner, never create or invoke Agents, and never load Skills, package extensions, shell commands, or local projects. `ChatAssistantRevision` stores independently owned immutable configuration. New threads pin `assistantRevisionId`; neither the Assistant nor a historical revision can be rebound. Unresolved historical threads retain readable messages and attachments but execution returns 409 and requires an explicitly new thread.

- `POST /api/v1/chat/assistants` returns `201 {assistant}` and publishes revision 1 transactionally. `PATCH /api/v1/chat/assistants/[id]` requires integer `expectedRevision`, returns `{assistant}`, and rejects revision conflicts with 409. `POST .../[id]/copy` accepts `{name, expectedRevision, mcpGrants?}` and returns an independent `201 {assistant}`; copies have no tool grants by default.
- MCP input is `mcpGrants: [{deploymentId, allowedToolNames, expectedDefinitionChecksum?}]`; empty lists grant no tools and `deploymentIds` is rejected. New grants, changed tool names, and deliberate connection reauthorization require the discovery-stage `expectedDefinitionChecksum`. The server compares it under the deployment operation lock; mismatches return 409 and require rediscovery/approval. Truly unchanged retained grants may omit it but retain their old pinned checksum, never silently refreshing authority. Revisions store the server-computed `definitionChecksum`; credential-value rotation does not expand authority, while endpoint/transport/executable-definition changes cannot silently retarget old threads. Each invocation intersects pinned names, live grants, and workspace policy, then revalidates and invokes actual HTTP/SSE transport under the same deployment lock. Stdio gateways, sandboxes, and internal Agent/A2A endpoints are rejected.
- The editor uses `GET /api/v1/chat/assistants/resources?workspaceId=...` → `{deployments:[{id,name,status,tools:[{name,description}],available,definitionChecksum}]}`. Only actual remote connections are listed; live workspace policy filters tool catalogs, and neither connection configuration nor credentials are returned.
- Assistant discovery lazily prepares pinned remote connections, including stopped connections after credential rotation; preparation failures are explicit instead of silently dropping tools based on old process state. Discovery and pre-call validation read the complete catalog with limits of 10 pages, 1,000 tools, 4 MB cumulative responses, and 15 seconds. Invalid/repeated cursors, malformed catalogs, and exceeded limits reject rather than expose partial results. Platform execution gateways—including client registrations at `/api/v1/pi-packages/installations/[id]/mcp`, sandbox gateways, and Agent/Toolkit gateways—cannot be repackaged as Assistant remote sources.
- Template root: `/api/v1/chat/assistants/[id]/templates`. `GET` returns `{revisionId, revision, templates}`. `POST` imports and `PATCH /[name]` explicitly replaces using `{expectedRevision, source}`; `POST /[name]/clone` accepts `{expectedRevision, name}`. Mutations publish an immutable revision without updating other Assistants. A source is `{kind:"markdown", path, markdown}` or `{kind:"release", releaseId, path}`; only the actual chosen authorized Prompt file is read, without installing its package.
- `POST /templates/preview` and `POST /templates/[name]/diff` accept a source directly and return `{revision, before, after, changed, conflict}`. `GET /templates/[name]/export` downloads exact Markdown with `X-Toolplane-Prompt-Checksum`. Imports verify release/file integrity, access, required semantics, and command collisions; Agent-dependent templates are incompatible with Assistants.
- Conversation template selection uses `GET /api/v1/chat/threads/[id]/templates` → pinned `{revisionId,revision,templates}`, not the Assistant's current templates. `POST .../templates/[name]/preview` accepts `{args:string|string[]}` and returns `{text,metadata:{promptTemplate:{assistantId,revisionId,name,sourceReleaseId,path,checksum,args}},revisionId,revision}`. This is static server-side preview only, with no model/tool execution; submission still sends the template selection rather than trusting client-expanded content.
- `POST /api/v1/chat/threads/[id]/turns` requires `idempotencyKey` alongside existing `messages`, `trigger`, `messageId`, `webSearchEnabled`, `reasoningEffort`, and optional `template:{name,args:string|string[]}`. The same actor, key, and request return the same Run; changed content under one key or a concurrent new request on the thread returns 409. Only first admission expands a template server-side from the pinned revision, persisting actual user text and server-generated `data-prompt-template` provenance. Client-forged provenance is rejected. Regeneration creates a new Run without overwriting the old reply.
- New execution submissions refused by an unavailable runtime owner return `503 {error:"runtime_not_ready"}`, `Retry-After: 5`, and `Cache-Control: no-store`, without admitting a Run or executing models/tools. Preserve the request and idempotency key, explain runtime recovery, and allow an explicit retry when ready; never bypass ownership or approve tools automatically.
- Submit and subscribe return AI SDK UI message streams with `X-Chat-Turn-Id`, `X-Chat-Run-Id` (the same Run identity), `X-Chat-Cursor`, and `X-Chat-Run-Status`. `GET .../turns/stream?runId=...&afterSequence=N` replays only persisted events after N, never starts execution, and also accepts integer `Last-Event-ID`. Each persisted chunk is followed by transient `data-chat-cursor` containing `{runId,sequence}` for Run/sequence deduplication. Missing Runs return 204; invalid cursors return 400.
- `GET .../turns/stream?state=1&runId=...` returns `{runId,turnId,status,phase,cursor,generation,stopRequested,error,messages,confirmations}`. Status is `pending/completed/failed/cancelled`; phase distinguishes `queued/generating/tool_calling/awaiting_user/stopping/interrupted/execution_unknown` and terminal states. Restore the snapshot, confirmations, and cursor before subscribing. Neither Run IDs nor cursors authorize access.
- `POST .../turns/confirmations` accepts `{confirmationId,approved:boolean}`; only the original actor with current access and a valid execution lease may decide. Confirmations and tool start/results are durable; being offline never approves a call. `DELETE .../turns` accepts `{turnId}` and returns `{stopRequested,turnId}`, with 202 when accepted. This does not claim remote effects were rolled back; read actual cancellation state from the snapshot.
- Approval does not guarantee dispatch: the connection, catalog, and live authority are checked again before remote `tools/call`. An explicit fresh AI-exposure refusal in the shared tool builder, or a transport-certified pre-dispatch refusal, settles as known `failed` with a completion timestamp, without requiring external-effect reconciliation. An arbitrary result object containing `error` is not evidence that dispatch did not occur. Once dispatch may have occurred, transport failures or cancellation remain `execution_unknown`; neither automatic retries nor deletion of the unresolved ledger are allowed.
- Physical thread/Assistant deletion acquires the same transactional thread row locks as Run admission. Assistant deletion also locks the Assistant row against concurrent thread creation. Any pending Run or `executing`/`execution_unknown` tool confirmation returns 409 without cascading messages, Runs, events, or confirmation records. A stop request is not a settled external outcome; unknown effects remain available for external reconciliation.

Leases are generation-fenced. Events, partial message snapshots, and terminal state commit before publication. Closing a browser cancels only its subscription; multiple tabs observe one Run. Subscriptions, execution heartbeats, confirmations, and tools continuously recheck active account/workspace authority. Submit and subscribe recover expired leases: nonresumable provider streams retain partial text and become interrupted, requiring an explicit new Run to retry; unknown external outcomes become `execution_unknown` and are never automatically replayed.

The Assistant chat surface is separate from Agent execution UI. It displays the current default revision and the conversation's immutable pin separately; settings publish defaults for new conversations. Thread ordering remains local navigation, but cross-Assistant conversation moves are unavailable. The browser restores persisted message/tool-confirmation snapshots before cursor subscription, preserves the exact request body and idempotency key for submission retries, and distinguishes connection state from Run state. Stop requests remain pending until the server reports the actual outcome. Prompt selection and argument preview use the thread's pinned templates; independent import/update/export manages current defaults without changing existing threads. Unknown `data-prompt-template` metadata never replaces readable text or becomes a system instruction.

Snapshot reconciliation binds the optimistic user message to its admitted Run and canonical persisted user ID, and deduplicates assistant messages by their server-issued IDs. Live subscriptions do not inject snapshots into the SDK's actively mutating message array; rendering reconciles saved state without losing newer streamed text. Empty threads and terminal history do not display disconnected-execution warnings or reconnect actions. An owner-readiness refusal explains recovery and retains the original request for explicit same-key retry, without automatic submission.

A selected template is a complete message source: arguments and attachments may be submitted without dummy prose, unused free-text is disabled explicitly, and successful completion clears the selection for the next ordinary message. Stop targets the currently admitted Run rather than an older completed snapshot; a refused request is reported without claiming cancellation. Durable confirmation results are rendered even if execution exited before publishing the ordinary tool-output message. Unknown external outcomes retain their confirmation and deletion protections.

Prompt-only marketplace resources offer an explicit same-workspace Assistant target and declared source path. The chat deep link carries `assistant`, `importPromptRelease`, and `importPromptPath` to an Assistant-level import panel, including Assistants with no conversations. It opens an authorized read-only source preview; only explicit Save imports that source using the preview's revision CAS. Changing the target or source cancels stale previews. The flow neither installs the package nor grants tools, starts execution, or changes an existing conversation's pinned revision; after import, a new conversation can use the new default revision.

After an import commits, the server-confirmed default revision updates the shared Assistant projection immediately while the parent requests refreshed server data. Every visible current-default label uses that projection; an older refresh cannot regress a known committed revision. Conversation pins, history, Run identities, and cursor subscriptions are unchanged.


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

Selection and capability checks live in [`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts); immutable revision admission lives in [`revisions.ts`](../src/lib/agents/revisions.ts) and Pi execution runs through [`sandbox-turn.ts`](../src/lib/agents/sandbox-turn.ts). Non-Pi runtime history and files remain read-only; new execution requires a fresh Pi Agent and explicit reauthorization.

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
