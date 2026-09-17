# Hermes Agent Runtime

> **中文**：[HERMES_AGENT_RUNTIME.md](./HERMES_AGENT_RUNTIME.md)

This document explains configuration ownership, persistence, networking, and operations for ToolPlane-managed Hermes agents. It is for platform developers and deployers. Configuration behavior is defined by [`hermes/config.ts`](../src/lib/agents/hermes/config.ts) and [`hermes/runtime.ts`](../src/lib/agents/hermes/runtime.ts).

## 1. Control Plane and Runtime

ToolPlane owns workspaces, permissions, provider configuration, MCP/Skill selection, channel credentials, lifecycle, auditing, and UI. Hermes is one optional runtime responsible for sessions, long-term memory, the tool loop, its file workspace, Skills, Cron, and other Hermes-native capabilities.

The current platform runtime identifiers are `pi`, `claude-code`, `dsh`, `hermes`, and `hermes-rpc`, not the former Native/Hermes pair. Pi, Claude Code, and DSH use dedicated sandboxes; Hermes gets a dedicated container, persistent volume, and runtime credentials per agent. The internal `native.ts` filename does not make `runtime: "native"` selectable. See [ARCHITECTURE.en.md](./ARCHITECTURE.en.md) for the full inventory.

Hermes is not ToolPlane's database or authorization source. Containers receive neither Postgres access nor user-level ToolPlane API tokens. Selected model-provider keys are, however, written into the agent's private Hermes configuration volume. This is a different boundary from not exposing credentials through public APIs.

An independent [`hermes-rpc` sandbox mode](./HERMES_RPC_RUNTIME.md) does not reuse the dedicated resources or configuration paths described here.

## 2. Creation and Upgrades

The console's New Agent flow first selects a runtime. For Hermes, configure one or more model providers, MCP deployments, installed Skills, Toolkits, and a Hermes Docker image; Hermes manages concrete model assignments. Pi, Claude Code, and DSH instead use a single provider/model binding and must not be described using Hermes's multi-select flow.

Agent Control MCP's `create_agent` exposes only `pi` and `hermes`, not every console runtime. It also uses the instance administrator's image configuration rather than accepting a caller-selected Hermes image. See [AGENT_CONTROL_MCP.md](./AGENT_CONTROL_MCP.md).

The resource chain is:

```text
Agent
  -> AgentRuntime(kind=hermes)
  -> Sandbox(kind=hermes)
  -> Deployment(source=sandbox)
  -> Docker named volume mounted at /opt/data
```

Database setup and Docker provisioning are separate operations: a Docker volume is not a row atomically committed by the database transaction. With no provider selected, the runtime remains `setup_required`; selecting at least one provider and saving synchronizes the provider inventory and starts the gateway.

### Image Versions

The console supports image versions offered by ToolPlane or a full image reference. Do not treat a moving `latest` tag as immutable; use an image digest when strict reproducibility is required. `TOOLPLANE_HERMES_IMAGE` sets the instance default. In Compose deployments, recreate the application container after changing its `.env` configuration.

Existing agents upgrade through **Settings → Hermes → Upgrade & restart**. ToolPlane pulls first; a pull failure leaves the current runtime running. After a successful pull it rebuilds the container and reprojects configuration. Selecting the same `:latest` still repulls and rebuilds. The `/opt/data` volume survives, preserving sessions, memories, workspace, local Skills, and attachments; in-flight requests may be interrupted.

The chosen image is written back to `AgentRuntime`, the managed `Sandbox`, and `Deployment` so later syncs do not revert it. Messaging channels use separate Node adapters rather than Python channel adapters installed in the Hermes image.

### Importing an Existing `.hermes` Home

Upload a ZIP through **Sandboxes → New sandbox → Import .hermes archive**. It may contain a single `.hermes/` root or the home directory's contents directly. Import creates the same Agent/runtime/Sandbox chain, not a generic sandbox detached from an agent.

[`archive-limits.ts`](../src/lib/agents/hermes/archive-limits.ts) defines a default compressed limit of 48 MiB, configurable from 1 to 10,240 MiB. The unpacked-total cap defaults to 256 MiB and grows with a raised upload limit, up to 10 GiB. These are binary MiB/GiB units, unlike the decimal MB/GB used for ordinary attachments.

The browser streams a raw request body into staging storage, without Server Actions, multipart parsing, or a whole-archive `arrayBuffer()`. Compose mounts `toolplane_imports` at `/var/lib/toolplane/imports` by default. Set `TOOLPLANE_HERMES_ARCHIVE_VOLUME=/srv/toolplane/imports` for a larger host directory and ensure the container's `node` user can write there.

The ZIP, unpacked tree, initialization copy, and final volume can coexist; plan roughly 40 GiB of transient capacity for a 10 GiB import. The instance serializes archive imports, prechecks capacity, and cleans crash leftovers and expired-lease staging files. This lease is single-application-process crash recovery, not a distributed lock for sharing staging across active replicas.

Archive checks cover paths, duplicate/Unicode conflicts, links/special files, encryption, permissions, entry counts, sizes, compression ratios, and inspection time. Relative links that stay under the home root may survive; links to absolute paths on the old host are dropped; other unsafe links are rejected. Additional limits include 200,000 entries, 1,024 links, and 4 MiB each for runtime-parsed `config.yaml` / `.env`, with a bounded exception for highly compressible cache files. The compressed-upload limit is not the only check.

Reverse proxies must relax body and upload/read limits for `POST /api/v1/workspaces/:slug/sandboxes/hermes-import` and disable request buffering there. The production launcher's `TOOLPLANE_HTTP_REQUEST_TIMEOUT_MS` defaults to four hours, configurable no lower than one minute, for raw-body reception. The complete Route Handler budget is 50,400 seconds (fourteen hours), including inspection, copies, and synchronization. Keep suitable connection and rate limits on other routes. `pnpm dev` does not replace production-launcher validation for large imports.

Uploads are single-request streams without resume. The page reuses an import ID: retrying after a lost response can return a completed result, while an unfinished previous import requires inspection or cleanup. ToolPlane's managed env-key manifest, `skills/toolplane-agent/`, and `skill-bundles/toolplane-agent.yaml` are removed and regenerated; existing sessions, memories, local Skills, and other native settings enter the private volume.

Imported runtimes stay stopped and select no provider automatically. Imported plugins, hooks, and MCP configuration can run only after model configuration is confirmed and the runtime is explicitly started. Import only trusted archives: they can contain credentials, sessions, and executable configuration.

## 3. Configuration Projection

```text
/opt/data/
├─ config.yaml
├─ .env                         # merged Hermes and ToolPlane variables
├─ .toolplane-env-keys.json      # ToolPlane-managed key manifest
├─ sessions/                    # Hermes-managed
├─ memories/                    # Hermes-managed
├─ workspace/
│  └─ attachments/
├─ skills/
│  └─ toolplane-agent/<skill>/
│     ├─ SKILL.md
│     └─ ...bundle files
└─ skill-bundles/
   └─ toolplane-agent.yaml
```

For an ordinary console Hermes agent, synchronization manages:

- `skills/toolplane-agent` and `skill-bundles/toolplane-agent.yaml`.
- ToolPlane-managed environment variables and the runtime API key in `.env`.
- `toolplane-` provider entries in `config.yaml`, `agent.max_turns`, `approvals`, `tool_loop_guardrails`, `platforms.api_server.enabled`, and `mcp_servers.toolplane`; primary-model initialization and invalid-model fallback are described below.

These are YAML fields and naming conventions, not a single top-level `toolplane` object holding all configuration. Structured merging preserves unmanaged memory, cron, plugins, other MCP servers, native settings, sessions, local Skills, and the user workspace.

Environment settings use `KEY=value`. Synchronization uses `.toolplane-env-keys.json` to replace or remove only previously managed keys, preserving other variables and comments. The `.env` and manifest writes are atomic with `0600` permissions; subsequent sync/restart makes saved variables effective.

### System Prompt Ownership

For ordinary console Hermes agents, `agent.system_prompt` belongs to the Hermes Dashboard/terminal. ToolPlane does not project the ordinary `Agent.systemPrompt` field into it.

**Public Endpoint runtimes are an exception**: `renderManagedHermesConfig` passes the published revision's `systemPrompt` and enables `publicRuntime`; the generator additionally restricts builtin toolsets, API-server tool access, and delegation. Do not extend the console's preserve-native-capabilities/no-prompt-overwrite contract to isolated public execution runtimes. See [AGENT_PUBLIC_API.md](./AGENT_PUBLIC_API.md).

### Model Providers

Hermes uses multi-select `AgentModelProvider`, projected under stable `toolplane-...` provider keys. The current field is `transport`, not the old documentation's `api_mode`:

| ToolPlane provider format | Hermes field |
|---|---|
| `openai` | `transport: chat_completions` |
| `openai-responses` | `transport: codex_responses` |
| `anthropic` | `transport: anthropic_messages` |

Entries also contain `name`, `api`, `api_key`, and `models`; cached inventories get a `default_model`, while providers without cached models enable `discover_models`. Model lists, base URLs, and actual provider keys enter the private volume, not Deployment JSON, Sandbox JSON, or Docker inspect environment.

When there is no valid primary model initially, the first provider with a cached model supplies the bootstrap default. Hermes controls concrete model assignments, and synchronization preserves a still-valid primary model. If a ToolPlane-managed provider disappears, or a nonempty cached inventory no longer includes the selected model, configuration falls back to a remaining provider's bootstrap model. Fallback is not limited to removing a provider. Unmanaged provider entries survive.

Pi, Claude Code, and DSH retain a single `Agent.providerId + Agent.model` binding rather than Hermes's multi-select projection.

### MCP and Skills

ToolPlane projects one aggregate MCP entry; it does not prohibit other Hermes-managed MCP configuration:

```text
POST /api/v1/agent-runtimes/:runtimeId/mcp
Authorization: Bearer <runtime-scoped-token>
```

This entry aggregates the agent's authorized deployments, including Toolkit-derived bindings, routes calls through the existing MCP supervisor, and writes `LogEvent`. Structured merging preserves other unmanaged `mcp_servers` entries.

`resolveAgentTools()` deduplicates directly bound and Toolkit-derived Skills. Only agent-invocable entries are projected. Skill text and bundle attachments are preserved under `skills/toolplane-agent`, without deleting Hermes-created local Skills.

## 4. Network, Credentials, and Persistence

Hermes uses the `mcp-sandbox` egress network, not the internal ToolPlane/Postgres network. Its API server listens at container loopback `127.0.0.1:8642`, and its Dashboard at `127.0.0.1:9119`; neither container port is published. The supervisor accesses them through controlled `docker exec curl` proxying.

The container drops default capabilities, restoring those needed for startup/file ownership, and applies CPU, memory, and PID limits. `no-new-privileges` is enabled by default; `Allow sudo` is an explicit exception described below.

The runtime API key and aggregate MCP token are derived from the instance secret by `deriveHermesRuntimeToken(runtimeId, purpose)`. `hermes-api` and `toolplane-mcp` have distinct purposes and are not interchangeable. Plaintext runtime tokens are not stored in the database; this does not mean provider keys are absent from the private volume.

The managed runtime Sandbox is bound one-to-one to its Agent, stays out of the generic Sandbox list, and cannot be attached to another Agent. Its managed panel controls name, environment, and snapshots; start/stop/delete still follow the Agent runtime lifecycle.

### Snapshots

Snapshots copy the `/opt/data` named volume, including workspace, sessions, memories, attachments, local Skills, and native configuration. They exclude the container writable layer and do not roll back ToolPlane `Conversation` / `AgentAttachment` rows. This is not a complete logical Agent checkpoint; restoring an old volume can leave database metadata referring to missing files or sessions.

Snapshot creation or restore first enters the maintenance gate, drains admitted chat/attachment writes, rejects new writes, then stops and copies the runtime volume. Restore reprojects current providers, MCP, Skills, and environment; only a previously running runtime is restarted. Hermes cannot be copied through generic Sandbox clone; use Agent clone. See [SANDBOXES.md](./SANDBOXES.md) for generic Docker snapshot recovery and cleanup-failure states.

### Dashboard

The Agent settings embed the native Dashboard. Access goes through runtime-scoped signed capabilities, a platform route, a separate-origin Dashboard broker, and a controlled sandbox proxy, never a direct browser connection to a container port.

```text
ToolPlane Agent page
  -> runtime-scoped capability (8 hours)
  -> /api/v1/agent-runtimes/:runtimeId/dashboard/:capability/*
  -> 307 to a separate origin http://<host>:9332
  -> capability bound to the parent-page origin
  -> Dashboard broker -> sandbox proxy
  -> docker exec curl 127.0.0.1:9119
```

The separate origin supports iframe `allow-same-origin` / `localStorage` while isolating it from ToolPlane. The broker does not forward platform cookies, Authorization, or user tokens, and restricts `connect-src` and `frame-ancestors`. It may forward Hermes's own `X-Hermes-Session-Token`. After capability and Origin validation, WebSockets use a frame bridge in `docker exec --user hermes`, without publishing container ports.

The local broker defaults to `0.0.0.0:9332`. For HTTPS, set `HERMES_DASHBOARD_PUBLIC_URL` to an origin different from `NEXT_PUBLIC_APP_URL`, such as `https://hermes.example.com`, and proxy it to `HERMES_DASHBOARD_PORT`. ToolPlane-owned configuration remains authoritative; an ordinary console runtime's other Skills, model assignments, and system prompt remain Hermes-managed.

### Terminal and Allow sudo

```text
/api/v1/agents/:agentId/terminal
  -> verify membership and the URL Agent's runtime
  -> start Hermes when needed
  -> supervised /terminal/session
  -> docker exec -w /opt/data/workspace
```

The interactive terminal uses the image's default user, root in the current managed image; the whole shell is not automatically started as `hermes`. The `hermes` CLI wrapper switches to the `hermes` service user via `setpriv`, preserving service-user ownership of Hermes state. One Agent's terminal session ID cannot reach another runtime.

The chat runtime's native shell runs as the `hermes` service user. Enabling `Sandbox.config.allowSudo` installs sudo, grants `hermes ALL=(ALL) NOPASSWD:ALL`, and removes `no-new-privileges` to permit setuid sudo. Although the console terminal and MCP shell already have root access, **this still expands the chat runtime's escalation capability**; do not claim the security boundary is unchanged. The setting takes effect on container rebuild while preserving the volume; disabling it restores the default restriction.

## 5. Sessions, Channels, and Attachments

### Console Chat

ToolPlane converts Hermes OpenAI SSE to the AI SDK UI stream. This frontend protocol does not imply that execution still uses the former Native runtime.

- `Conversation.id` supplies `X-Hermes-Session-Id`.
- `agent:<agentId>:console:<conversationId>` supplies `X-Hermes-Session-Key`.
- ToolPlane stores user/assistant message parts; Hermes maintains full sessions and memory in its own volume.

### Channels

Platform Node adapters call `runAgentChannelMessage`, dispatch by the target Agent's runtime, and send results through ToolPlane's response contract. A stable DM, group, or thread session key reaches `X-Hermes-Session-Key`.

Channel credentials are not copied into Agent containers, avoiding duplicate consumption. A channel can migrate within the workspace to another sandbox while keeping credentials and using the target runtime. Pi, Claude Code, and DSH need no Hermes platform adapter. See [AGENT_MESSAGING_PLATFORMS.md](./AGENT_MESSAGING_PLATFORMS.md).

### Attachments

ToolPlane's Hermes file-upload entry point is:

```text
POST /api/v1/agents/:agentId/attachments?filename=<name>&conversationId=<optional-id>
Content-Type: <file-mime-type>
<body: raw file bytes>
```

The route requires user/session authorization and workspace verification, and the target must have a Hermes runtime. It rejects multipart and streams a raw request body. `conversationId` is optional; when provided it must belong to the URL Agent. Files enter `/opt/data/workspace/attachments/<conversation-id>/...`, or `attachments/inbox/` without a conversation.

The default per-file limit is **1,000,000,000 bytes (decimal 1 GB)**, with a universal hard maximum of **2,000,000,000 bytes** (or a lower deployment override). Database, environment and default settings all pass through the same clamp. Workspace/Agent quota and concurrency reservations are enforced before upload, and actual streamed bytes cannot exceed the reservation. Failures remain charged until cleanup is confirmed. See [Runtime Operations](./RUNTIME_OPERATIONS.md) for defaults, upgrade and recovery procedures.

`AgentAttachment` stores workspace, Agent, optional conversation, runtime, MIME, size, and storage path. Upload does not inline the file as Base64/JSON model messages; conversations reference metadata and the runtime path. Hermes may subsequently read file contents through tools, which is different from claiming contents can never enter model context.

Runtime write leases coordinate uploads with snapshots. Match proxy body limits to configuration and disable request buffering. See [`attachments/route.ts`](../src/app/api/v1/agents/[agentId]/attachments/route.ts) for the actual route contract.

## 6. Lifecycle

```text
setup_required -> provisioning -> running
       |               |             |
       +---------------+-------------+-> error
                                       -> stopped
```

`setup_required` means no injectable provider; `provisioning` covers image, volume, or gateway preparation; `running` depends on supervisor and health state; `stopped` means user stop or process exit; `error` records sync, Docker, or health failures.

Configuration is deduplicated by SHA-256 hash. An unchanged save should not rebuild; configuration, MCP, Skill, or model changes trigger projection and rebuilding as needed while retaining the persistent volume. Agent/workspace deletion must clean supervisors, containers, snapshots, and volumes before completing database deletion. Failures should retain retryable state: database rollback cannot undo external teardown.

## 7. Verification and Limits

Review ordinary console and isolated public Endpoint contracts separately: configuration ownership, provider-key boundaries, cross-workspace/runtime rejection, session scope, native-config preservation, snapshot/write exclusion, terminal users, and cleanup-failure recovery.

Important regressions include preserving unmanaged Skills/settings; fallback after provider/model removal; projecting public revision prompts and tool restrictions; starting terminals as the image default user while the CLI drops privileges; reprojecting current grants after restoring an old volume; and rejecting other Agents' capabilities, tokens, conversations, or terminal sessions.

Historical planning lists are not evidence that a feature is still unimplemented. Check source, tests, and the target image for new capabilities and upstream compatibility. Single-process runtime/maintenance-gate constraints still apply; horizontal scaling needs additional coordination.

Upstream references (the target image version's contract may differ):

- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/docker.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/web-dashboard.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md>
