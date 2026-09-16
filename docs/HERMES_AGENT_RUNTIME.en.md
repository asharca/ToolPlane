# Hermes Agent Runtime

> **中文**：[HERMES_AGENT_RUNTIME.md](./HERMES_AGENT_RUNTIME.md)

## 1. Conclusion

ToolPlane adopts `Hermes-first, ToolPlane-owned control plane`:

- ToolPlane owns workspaces, permissions, model configuration, MCP/Skill selection, channel credentials, lifecycle, auditing, and UI.
- Hermes, as an optional agent runtime, owns sessions, long-term memory, the tool loop, the file workspace, Skills, Cron, and other Hermes-native capabilities.
- The Native runtime remains for lightweight agents; the Hermes runtime creates a dedicated container, persistent volume, and API key per agent.

Hermes is not ToolPlane's database or authorization source. Containers cannot reach Postgres and never receive user-level ToolPlane API tokens.

## 2. Creation Flow

New Agent offers a one-time choice:

1. Runtime: `Native` or `Hermes`.
2. One or more model providers (no concrete model is chosen in ToolPlane).
3. MCP deployments.
4. Installed Skills.
5. Toolkits.
6. Hermes Docker image (when Hermes is chosen).

After choosing Hermes, ToolPlane creates in one transaction:

```text
Agent
  -> AgentRuntime(kind=hermes)
  -> Sandbox(kind=hermes)
  -> Deployment(source=sandbox)
  -> Docker named volume
```

With no provider selected, the runtime stays `setup_required`, but the Agent, Sandbox, and config volume already exist. Once at least one provider is selected and saved, ToolPlane syncs the provider inventory and starts the gateway.

### Choosing and upgrading the Hermes version

When creating a Hermes agent you can pick from the official Hermes image versions offered by ToolPlane, or enter a full
Docker image reference. In production, prefer a pinned `v...` tag for reproducible deploys; `latest` is a moving tag for
runtimes that should track upstream.

An existing Hermes agent can pick another version under **Settings → Hermes** and click **Upgrade & restart**.
ToolPlane pulls the target image first; if the pull fails, the current runtime is not stopped. After a successful pull it
stops and rebuilds the container, re-projects ToolPlane-managed config, and starts with the new image. Even re-selecting
the same `:latest` tag re-pulls and rebuilds the container. The agent's `/opt/data` named volume is not deleted, so
sessions, memory, the workspace, local Skills, and attachments survive; in-flight requests are briefly interrupted
during the upgrade.

The image choice is written back to `AgentRuntime`, its managed `Sandbox`, and the associated `Deployment`, so later
syncs or restarts cannot silently revert to an old image. `TOOLPLANE_HERMES_IMAGE` sets the instance default image when
no version was chosen explicitly; with Docker Compose, put it in the adjacent `.env` and recreate the `app` container.

Messaging channels use Cherry Studio's native Node adapters, independent of the agent's runtime image.
ToolPlane no longer bundles the Hermes Python messaging channel adapters.

### Importing an existing `.hermes` home directory

Under **Sandboxes → New sandbox → Import .hermes archive** you can upload a ZIP backup of an existing Hermes
home directory. The ZIP may be rooted at a single `.hermes/` directory or directly at that directory's
contents. The archive size limit is configured in **Admin → System settings**, defaulting to 48 MiB,
adjustable between 1–10,240 MiB (10 GiB). The browser streams the ZIP as a raw request body straight into
dedicated staging storage — no Server Action, multipart parsing, or `arrayBuffer()` — so the archive is never
held whole in Node.js memory.

Docker Compose mounts `toolplane_imports` at `/var/lib/toolplane/imports` as the staging volume by default. A 10 GiB
import may transiently need about 40 GiB of free space across the ZIP, the unpacked tree, the Docker init-container
copy, and the final volume; deployers should plan capacity for that volume separately. Set Compose's
`TOOLPLANE_HERMES_ARCHIVE_VOLUME=/srv/toolplane/imports` to switch it to a bind mount on a large host disk (the
directory must be writable by the in-container `node` user). To keep concurrency from exhausting the volume, the
instance runs only one Hermes archive import at a time; staging space is pre-checked against the worst case of ZIP plus
unpack, crash-leftover directories are cleaned at startup and periodically, and expired import lease reclamation
immediately removes the corresponding ZIP/unpack tree. That lease exists for crash recovery of a single ToolPlane app
process — do not mount the same staging volume into multiple running ToolPlane instances as a distributed lock. The
archive, per-file, and unpacked-total sizes are limited together: the default unpack cap is 256 MiB, which grows with
the admin-raised archive cap up to 10 GiB. Archives may contain at most 200,000 ZIP entries and 1,024 links; available
bytes and inodes are also pre-checked before unpacking. Compression-ratio, path/permission checks, and the maximum
inspection time are still enforced for large files (highly compressible cache files up to 4 MiB excepted). The
runtime-parsed `config.yaml` and `.env` remain capped at 4 MiB.

In production behind a reverse proxy such as Nginx, Caddy, Traefik, or Coolify, you must also raise the request-body
size and upload/read timeouts for `POST /api/v1/workspaces/:slug/sandboxes/hermes-import`, and disable request
buffering for that path. The ToolPlane image sets the Node request timeout to four hours by default, adjustable via
`TOOLPLANE_HTTP_REQUEST_TIMEOUT_MS` (no lower than one minute). Four hours only covers raw request-body reception; the
Route Handler reserves up to fourteen hours for ZIP inspection, the two-phase Docker copy, and the first sync, so the
proxy's response/read/send timeouts for this path should be relaxed accordingly. This is a Node process-level
request-body timeout; production proxies should still keep short body/connection timeouts and enforce connection and
rate limits on other paths. Compose and `pnpm start` use this production launcher; `pnpm dev` is unsuitable for
verifying a full 10 GiB upload. The upload is a single-request stream with no resume; the page reuses the same import
ID, so a retry after a lost response returns the completed result, while an unfinished previous import explicitly asks
you to inspect or clean up first.

An import does not create a generic Sandbox detached from an agent; it creates the same
`Agent → AgentRuntime → Sandbox(kind=hermes) → Deployment → named volume`
chain and writes the unpacked content into that agent's private `/opt/data` volume. Existing
sessions, memories, workspace, local skills, and Hermes-native settings therefore remain managed by the
Hermes runtime lifecycle.

Before writing to the Docker volume, the archive is checked for ZIP paths, duplicate/Unicode conflicts, links/special
files, encrypted entries, permissions, file counts, sizes, compression ratio, and unpack time; relative links that
cannot escape the `.hermes` root are preserved, links pointing at absolute paths on the original host are dropped, and
other unsafe links are rejected. Archive contents never enter the database or error responses. ToolPlane drops its own
managed `.toolplane-env-keys.json`, `skills/toolplane-agent/`, and `skill-bundles/toolplane-agent.yaml`, which the
first sync then regenerates.

An imported runtime stays stopped by default with no provider auto-selected. Only after confirming the model
configuration in the new agent's settings and explicitly starting it can imported plugins, hooks, MCP, or other Hermes
configuration run. Only upload archives you trust; they may contain credentials, sessions, and executable
configuration.

## 3. Config Projection

ToolPlane generates the Hermes `/opt/data` contents from the agent's current grants:

```text
/opt/data/
├─ config.yaml
├─ .env                         # merged result of Hermes and ToolPlane variables
├─ .toolplane-env-keys.json     # manifest of ToolPlane-managed keys
├─ sessions/                     # Hermes-managed, never overwritten by ToolPlane
├─ memories/                     # Hermes-managed, never overwritten by ToolPlane
├─ workspace/
│  └─ attachments/               # uploaded by ToolPlane, read by Hermes
├─ skills/
│  └─ toolplane-agent/
│     └─ <skill>/
│        ├─ SKILL.md
│        └─ ...bundle files
└─ skill-bundles/
   └─ toolplane-agent.yaml
```

Each sync replaces only these ToolPlane-managed paths or fields:

- `skills/toolplane-agent`
- `skill-bundles/toolplane-agent.yaml`
- ToolPlane-managed env vars in `.env` saved from the agent settings
- Under the ToolPlane namespace in `config.yaml`: `providers`, `agent.max_turns`, `approvals`,
  `tool_loop_guardrails`, and `mcp_servers.toolplane`

`config.yaml` uses a structured YAML merge, so memory providers, cron, plugins, channels, other MCP servers, and other
native config written by the Hermes Dashboard are preserved. Hermes sessions, memories, cron, logs, plugins, local
Skills, and the user workspace are never deleted by syncs.

Hermes environment variables in the agent settings are edited as `KEY=value` and projected to the
`/opt/data/.env` returned by `hermes config env-path`. Using `.toolplane-env-keys.json`, a sync only replaces or
removes keys ToolPlane previously managed; other variables and comments from the Hermes Dashboard, the terminal, or the
image itself are preserved verbatim. Both `.env` and the managed-key manifest are written atomically with `0600`
permissions; after saving, a sync runs immediately and the Hermes runtime restarts so new variables take effect.

`agent.system_prompt` is fully Hermes-managed. ToolPlane does not display that field, does not project
`Agent.systemPrompt` into Hermes, and never adds, modifies, or deletes it during config syncs. The system prompt can
only be changed through the Hermes Dashboard or the Hermes terminal.

### Model providers

Hermes agents use a dedicated multi-select `AgentModelProvider` relation. Selected `ModelProvider`s are injected into
Hermes as keyed `providers` with stable names, each entry carrying its full cached model list:

- OpenAI compatible -> `api_mode: chat_completions`
- OpenAI Responses -> `api_mode: codex_responses`
- Anthropic -> `api_mode: anthropic_messages`
- models, base URL, and provider API key are written to the agent's own persistent volume

On first configuration with no primary model yet, ToolPlane picks the first provider/model pair with a cached model
list as the startup default; afterwards, Hermes-side changes to `model` are preserved. Which model serves the main conversation,
auxiliary tasks, vision, compaction, delegation, and fallback is managed by Hermes's own configuration. When a selected
provider is removed, only the corresponding ToolPlane provider entry is cleaned up; if the current primary model
references that entry, ToolPlane falls back to the startup default from the remaining providers.

Native agents keep the single-provider / single-model binding via `Agent.providerId + Agent.model`.

Provider keys never enter the Deployment JSON, Sandbox JSON, or Docker inspect environment.

### MCP

Hermes sees exactly one aggregated MCP server:

```text
POST /api/v1/agent-runtimes/:runtimeId/mcp
```

This endpoint uses an agent-runtime-scoped Bearer token and only aggregates deployments bound directly to the agent and
derived from Toolkits. `tools/call` is routed onward to the existing MCP supervisor and continues to write LogEvent.

### Skills

Directly bound and Toolkit-derived skills are deduplicated by `resolveAgentTools()`; only entries with
`agentInvocable != false` are synced. `SKILL.md` and bundle attachments keep their original content.

## 4. Runtime Network & Secrets

Hermes containers:

- Use the `mcp-sandbox` egress network and never join the ToolPlane/Postgres internal network.
- Do not publish `8642` or the dashboard port.
- Run the Dashboard inside the container, bound to `127.0.0.1:9119` only.
- Drop all root capabilities, restoring only the minimal set needed for container startup and file ownership.
- Default to `no-new-privileges` plus CPU, memory, and PID limits (enabling the `Allow sudo` option lifts
  `no-new-privileges`; see Hermes Terminal).
- Use a per-agent Docker named volume for `/opt/data`.
- Bind the API Server to `127.0.0.1:8642` inside the container only.
- The managed runtime Sandbox does not appear in the generic Sandbox list and cannot be bound to other agents. Its
  dedicated managed-runtime panel manages the name, environment variables, and `/opt/data` volume snapshots; start,
  stop, delete, and agent configuration still go through the agent runtime lifecycle.

### Runtime data snapshots

A Hermes managed runtime supports creating, restoring, and deleting snapshots of its `/opt/data` named volume. That
volume holds the workspace, sessions, memories, attachments, local Skills, and Hermes-native config; the image writable
layer is not part of a snapshot. Snapshots are volume-level restore points and do not roll back `Conversation` or
`AgentAttachment` rows in the ToolPlane database, so after restoring an older snapshot, database metadata may still
reference old files or sessions that no longer exist in the current volume.

When creating or restoring a snapshot, ToolPlane first enters the Hermes runtime maintenance gate, waits for admitted
chat and attachment writes to finish while rejecting new writes, then stops the runtime before copying the volume.
After a restore, ToolPlane re-projects the agent's currently managed providers, MCP, Skills, and environment variables;
a previously running runtime is restarted. A Hermes runtime is bound one-to-one with its agent and cannot be cloned
directly via generic Sandbox clone; use the agent clone flow for copies.

The ToolPlane supervisor proxies Hermes HTTP via `docker exec curl`. Both the API key and the MCP token are derived as:

```text
HMAC-SHA256(AUTH_SECRET, runtimeId + purpose)
```

so the database stores no plaintext runtime token. `hermes-api` and `toolplane-mcp` use different purposes and are not
interchangeable.

### Hermes Dashboard

The `Hermes` tab in the agent settings embeds the official Dashboard, including the native Skills, Files, Sessions,
Memory, Cron, Plugins, MCP, Channels, Config, Keys, and System pages.

The browser never connects to the container port directly. The access chain is:

```text
ToolPlane Agent page
  -> 8-hour, runtime-scoped signed capability
  -> /api/v1/agent-runtimes/:runtimeId/dashboard/:capability/*
  -> 307 to the separate origin http://<host>:9332
  -> a second signed capability bound to the ToolPlane parent-page origin
  -> Hermes Dashboard broker
  -> supervised sandbox proxy
  -> docker exec curl 127.0.0.1:9119
```

The Dashboard iframe grants `allow-same-origin` on the separate port origin so the official Dashboard can use
`localStorage`. It remains isolated from the ToolPlane page by the browser same-origin policy; the broker does not
forward ToolPlane cookies, Authorization headers, or user API tokens, and returns CSP such as `connect-src 'self'` and
a `frame-ancestors` bound to the parent-page origin. Even if an agent chooses a custom Hermes image, Dashboard
JavaScript shipped by that image cannot read the ToolPlane page or call other ToolPlane APIs. The proxy only forwards
the `X-Hermes-Session-Token` that Hermes itself injects.

Local development listens on `0.0.0.0:9332` by default. HTTPS deployments must set
`HERMES_DASHBOARD_PUBLIC_URL=https://hermes.example.com` and reverse-proxy that separate TLS origin to the app's
`HERMES_DASHBOARD_PORT`; the URL must not share an origin with `NEXT_PUBLIC_APP_URL`.

ToolPlane-projected `skills/toolplane-agent` is platform-managed content in the Dashboard; other Skills created by
Hermes itself can be edited and persisted directly. `providers` and `mcp_servers.toolplane` under the ToolPlane
namespace always defer to ToolPlane; Hermes's model assignments, system prompt, and other native config remain
Hermes-managed.
The Dashboard's own Chat, event stream, and live console are also forwarded through the separate broker; ToolPlane's
Agent Chat and Terminal remain the platform-native entries. After capability and browser-Origin checks, the WebSocket
reaches the container loopback `127.0.0.1:9119` through a controlled frame bridge inside `docker exec --user hermes`;
no container port is published.

### Hermes Terminal

The `Terminal` tab in the agent settings provides a full interactive shell. The browser uses xterm over an agent-scoped
HTTP + SSE API connected to the supervisor:

```text
/api/v1/agents/:agentId/terminal
  -> verify user membership and URL Agent runtime
  -> auto-start Hermes runtime when needed
  -> supervised /terminal/session
  -> docker exec -w /opt/data/workspace
```

A terminal session only resolves inside the container of the agent in the URL; one agent's session ID cannot reach
another runtime. The shell runs as the image's default user (root), consistent with the MCP shell/file tools, so
`apt-get`, `chown`, etc. work directly; the `hermes` CLI in the wrapper drops back to the `hermes` service user via
`setpriv`, so `/opt/data` stays manageable by the service user. ToolPlane sync directories and uploaded attachments
still get their permissions corrected for that user.

In Chat, the agent's native shell tool runs as the `hermes` service user and cannot escalate by default. After enabling
`Allow sudo` in the sandbox settings (stored in `Sandbox.config.allowSudo` and projected to the deployment
`installCfg`), container startup (`ensureHermesSudo`) installs `sudo` and writes `/etc/sudoers.d/99-toolplane`
(`hermes ALL=(ALL) NOPASSWD:ALL`), letting the agent run `sudo`-escalated commands directly (Hermes's sudo handling
also supports automatic `SUDO_PASSWORD` injection). With it enabled the container no longer sets
`no-new-privileges` — setuid sudo requires that; the terminal and MCP shell/file tools already run as root, so the
practical protection level is unchanged. The toggle takes effect on the next container rebuild (forced runtime resync,
volume preserved); disabling restores `no-new-privileges`. The option can also be checked directly when creating a
Hermes sandbox (archive import).

## 5. Chat, Memory & Attachments

### Console chat

ToolPlane converts Hermes OpenAI SSE into the existing AI SDK UI stream; the frontend protocol is unchanged.

- `Conversation.id` -> `X-Hermes-Session-Id`
- `agent:<agentId>:console:<conversationId>` -> `X-Hermes-Session-Key`
- ToolPlane keeps storing user/assistant message parts
- Hermes keeps the full session and memory in its own volume

### Channels

Channels use Cherry Studio's native Node adapters, configured per sandbox and migratable:

```text
Platform
  -> Native Node channel adapter
  -> runAgentChannelMessage
  -> Hermes Agent runtime
  -> ToolPlane response contract
  -> Native adapter send
```

A channel's stable messaging session key is passed straight to `X-Hermes-Session-Key`, so the same DM, group, or
thread gets a stable long-term memory scope.

Channel credentials are not copied into the agent container, avoiding duplicate consumption. A channel can migrate to
another sandbox in the same workspace, keeping its credentials while using the target agent's runtime; DSH, Pi, and
Claude Code need no Hermes platform adapter.

### Attachments

The Hermes OpenAI API supports inline images but not PDF/plain file upload, so ToolPlane provides:

```text
POST /api/v1/agents/:agentId/attachments
```

Rules:

- Must be authorized with a user/session token and verify the agent's workspace.
- `conversationId` must belong to the agent in the URL.
- Files stream into the runtime — no Base64/JSON, and file contents never enter the model context.
- Default max 1 GB per file; admins can change it in `/admin/settings`, the database override wins over
  `TOOLPLANE_MAX_ATTACHMENT_BYTES`, and the server always keeps an upper bound to prevent disk exhaustion.
- Files are written to `/opt/data/workspace/attachments/<conversation>/...`.
- `AgentAttachment` stores workspace, agent, conversation, runtime, MIME, size, and storage path.
- Conversations only send filename, size, MIME, and runtime path; neither images nor plain files are sent to the model
  as inline parts.
- Behind a reverse proxy such as Nginx, the proxy's request-body limit must be at least this value and request
  buffering should be disabled to keep uploads end-to-end streaming.

## 6. Lifecycle

Runtime states:

```text
setup_required -> provisioning -> running
       |               |             |
       +---------------+-------------+-> error
                                       -> stopped
```

- `setup_required`: no provider injectable into Hermes has been selected.
- `provisioning`: image, volume, or gateway is starting.
- `running`: supervisor alive and `/health` succeeds.
- `stopped`: stopped by the user or the process is gone.
- `error`: sync, Docker, or gateway health failed; see `lastError`.

Config content is deduplicated by SHA-256 hash. A no-change autosave does not rebuild the container; when config,
MCP/Skill selection, or models change, the volume is preserved while the container is rebuilt and a new gateway starts.

Both agent deletion and workspace deletion stop the supervisor, remove the container and named volume, then delete the
database records.

## 7. Phased Scope

### This branch

- Agent runtime data model and migrations
- New Agent runtime/model/MCP/Skill/Toolkit selection
- Hermes-dedicated Sandbox and Docker lifecycle
- Model, MCP, Skill config projection
- Console chat streaming adapter
- Channel message runtime routing and Hermes memory scope
- Attachment upload, persistent workspace, and metadata
- Start, stop, sync, status, and error UI
- Controlled proxy for the native Hermes Dashboard and its in-agent embed
- Agent-scoped Hermes interactive terminal
- Native runtime compatibility

### Later

- Periodic Hermes `/v1/capabilities` collection and a version compatibility matrix
- Optional ToolPlane-native Cron, memory, sessions, plugins management pages
- Attachment download, deletion, quotas, and virus scanning
- Tool progress events mapped to AI SDK structured parts
- Runtime image allowlist, signature/SBOM verification, and upgrade policy
- Per-workspace/agent CPU, memory, disk, and concurrency limits
- Catalog onboarding for more Hermes channel adapters

## 8. Acceptance Criteria

1. Native agents' chat, tools, channels, and historical behavior are unchanged.
2. Creating a Hermes agent produces exactly one dedicated runtime Sandbox.
3. Hermes containers cannot reach the ToolPlane DB, and the host exposes no public Hermes API port.
4. A runtime MCP token cannot access another agent's tools.
5. After changing an agent's MCP/Skill/Toolkit, Hermes config re-syncs repeatably without duplicates.
6. The same conversation/channel session keeps using the original Hermes memory/session volume after a container restart.
7. Cross-workspace provider, tool, conversation, and attachment IDs are rejected.
8. Deleting an agent/workspace leaves no residual supervisor, container, or volume.
9. The Dashboard port is not published; expired or other runtimes' capabilities cannot reach that Dashboard.
10. Dashboard-created local Skills, memory, and non-ToolPlane config survive an agent tool re-sync.
11. Hermes Terminal auto-starts the runtime, lands in `/opt/data/workspace` as the `hermes` user, and isolates sessions
    between agents.

Upstream contract references:

- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/docker.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/web-dashboard.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md>
