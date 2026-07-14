# Agent Sandboxes

Agent sandboxes give an agent a workspace that behaves like a small operating
environment. In this project a sandbox is exposed to agents as MCP tools and,
for the browser console, as a PTY-backed terminal stream. The app does not
mount arbitrary server host directories as sandboxes.

## Runtime Shape

```txt
Agent
|-- MCP deployments
|-- Skills
|-- Toolkits
`-- Sandboxes
    `-- Sandbox deployment
        `-- scripts/sandbox-mcp-server.mjs
            |-- sandbox_info
            |-- shell_exec
            |-- list_dir
            |-- read_file
            |-- write_file
            `-- terminal session stream
```

## Modes

### Docker Linux

Docker mode starts a persistent container and volume:

```txt
Sandbox row
`-- Deployment source=sandbox
    `-- sandbox-mcp-server
        `-- docker container
            `-- /workspace volume
```

The default image is:

```txt
mcr.microsoft.com/devcontainers/javascript-node:24-bookworm
```

The container is not privileged, drops Linux capabilities, has pids/cpu/memory
limits, and can use either the dedicated `mcp-sandbox` network or `none`.

#### Workspace Data Lifecycle

These data-management operations apply only to Docker Linux sandboxes. Each
Docker sandbox owns a named volume mounted at `/workspace`:

- Creating a sandbox creates its dedicated workspace volume.
- Cloning creates a new sandbox and copies the source's current workspace volume
  into the clone's new volume. The clone gets the source image, network, and
  sandbox configuration, but it does not inherit the source's snapshot records.
- Creating a snapshot copies the current workspace volume into a separate named
  volume and records it on the source sandbox.
- Restoring a ready snapshot replaces the current workspace volume contents. A
  temporary copy of the pre-restore data is used for automatic rollback if the
  restore copy fails, then removed. If both restore and automatic rollback fail,
  ToolPlane leaves the sandbox stopped and retains that copy as a ready recovery
  snapshot instead of starting from partially restored data.
- Deleting a snapshot removes its named volume before deleting its database
  record. A Docker cleanup failure is reported and leaves the record available
  for a retry.

Clone, snapshot creation, and restore first quiesce the affected sandbox: the
supervised MCP process is terminated and its Docker container is stopped before
any volume is copied. A sandbox that was running is started again after the
operation (including the rollback path); a sandbox that was already stopped
stays stopped. A provisioning sandbox must finish provisioning before one of
these operations can begin. After a successful clone copy, the new clone starts
as its own sandbox. Snapshot deletion only removes an independent snapshot
volume and does not pause the sandbox.

Volume copies run in named, labeled helper containers. A clone remains in the
non-runnable `copying` state until its helper has exited and cleanup is
confirmed; server startup removes stale helpers and changes interrupted clones
to `copy_failed`, where only deletion is available. Restore recovery records
are created before the backup copy begins and marked ready before the active
volume is replaced. The deployment is then kept in `restoring` until the active
volume is known-good. If helper cleanup cannot yet be confirmed, the sandbox
stays in `restore_cleanup_required`; after cleanup, an interrupted restore
becomes `restore_failed` and can only restore a ready recovery snapshot or be
deleted. Temporary recovery rows enter `deleting` before their volumes are
removed so a crash cannot leave a restoreable row pointing at a missing volume.

Lifecycle operations are serialized per sandbox. Workspace deletion first
closes an in-process workspace gate and drains operations already in progress,
then takes the inventory used for strict external cleanup. As described in the
deployment requirements in the README, ToolPlane must run as one always-on Node
process; multiple control-plane replicas cannot safely share the same local
Docker runtime.

Deleting a Docker sandbox stops its process, strictly removes every snapshot
volume, then removes its container and main workspace volume before deleting the
database records. Workspace deletion follows the same strict snapshot-before-
runtime cleanup order. Before external cleanup begins, the deployment enters a
non-runnable `deleting` state. If Docker or database cleanup fails, that state is
retained for an idempotent deletion retry instead of exposing an empty recreated
workspace volume.

Only the named volume mounted at `/workspace` is copied or snapshotted. The
container writable layer, data in any other mount, and external services are not
included. For example, files written outside `/workspace` or packages installed
only into the running container's writable layer are not copied to a clone and
are neither captured nor rolled back by snapshot restore.

User Connector and Hermes runtime sandboxes do not support these clone or
snapshot operations. Connector data stays on the user's machine and ToolPlane
does not copy or delete it. Hermes storage is owned by the Agent runtime
lifecycle and is not managed with the Docker Linux sandbox data controls.

### User Connector

Connector mode lets a user expose one directory on their own machine without
opening SSH, configuring keys, or letting the platform dial arbitrary user
hosts. Linux, macOS, Windows PowerShell, and Windows Command Prompt all use the
same one-line command:

```text
npx -y --package "http://localhost:3002/api/v1/connectors/package.tgz?v=0.1.9" connector connect --server "http://localhost:3002" --token "mcpcon_..." --root "~/toolplane-sandbox"
```

The connector requires Node.js 20+, outbound access to ToolPlane's HTTP and
WebSocket endpoints, and npm registry access. The hosted tarball contains the
CLI package metadata; `npx` downloads its `ws` and `node-pty` dependencies from
the configured npm registry. Windows support targets Windows 10 1809 or newer
and Windows 11 on x64/arm64, where `node-pty` uses ConPTY. If PowerShell policy
blocks `npx.ps1`, the unchanged command can be run in Command Prompt. The
configured local root is returned by bootstrap; `--root <path>` remains an
optional manual override for development and is reported back as the actual
root shown in the console.

The sandbox page generates the `mcpcon_...` token when creating a connector
sandbox or when the user clicks **Generate command**. The command starts a
local connector agent. That agent calls the platform bootstrap endpoint,
discovers the WebSocket broker, and then keeps one authenticated WebSocket
session open.

```txt
User machine
`-- connector package tarball from /api/v1/connectors/package.tgz
    |-- native shell (PowerShell on Windows, POSIX shell on macOS/Linux)
    |-- local filesystem root
    |-- structured process execution
    `-- local PTY (ConPTY on Windows)
        |
        | WebSocket
        v
Platform connector broker
`-- sandbox-mcp-server
    |-- shell_exec
    |-- process_exec
    |-- list_dir
    |-- read_file
    |-- write_file
    `-- terminal stream
```

Important properties:

- The platform never opens a connection to the user machine.
- The connector token is sent in the HTTP and WebSocket `Authorization: Bearer`
  header; it is never placed in a URL.
- File operations are constrained under the bootstrap-configured root directory
  by the client.
- Interactive terminals are real PTYs created on the user machine by
  `node-pty`, so shell completion and normal terminal behavior are preserved.
- The connector reports its platform, architecture, shell family, Node version,
  and capabilities during the v2 handshake. `sandbox_info` exposes these values
  so agents can use PowerShell syntax on Windows and POSIX syntax elsewhere.
- `shell_exec` and the PTY intentionally run with the permissions of the local
  user who starts the connector. They are not an OS security boundary and can
  access more than the configured file-tool root. Use a dedicated low-privilege
  account for untrusted workloads.

The Next.js server starts a connector broker during `instrumentation.ts`:

```txt
NEXT server process
|-- connector WebSocket broker
|   |-- public WS /connect (Authorization: Bearer mcpcon_...)
|   `-- internal HTTP /internal/connectors/...
`-- MCP supervisor
    `-- sandbox-mcp-server child processes
```

The broker listens on:

```txt
CONNECTOR_WS_BIND        default 0.0.0.0
CONNECTOR_WS_PORT        default 9321
CONNECTOR_WS_PUBLIC_URL  optional explicit public ws:// or wss:// URL
```

`docker-compose.yml` publishes the app HTTP port with `APP_HOST_PORT`, defaulting
to `10030`, and the broker with `CONNECTOR_WS_HOST_PORT`, defaulting to `9321`:

```yaml
app:
  ports:
    - '${APP_HOST_BIND:-0.0.0.0}:${APP_HOST_PORT:-10030}:3000'
    - '${CONNECTOR_WS_HOST_BIND:-0.0.0.0}:${CONNECTOR_WS_HOST_PORT:-9321}:9321'
```

For production behind Coolify or another reverse proxy, route `/connect` to the
broker's published host port and set `CONNECTOR_WS_PUBLIC_URL` to the public
WebSocket endpoint, for example:

```txt
wss://example.com/connect
```

If the proxy runs on another host, restrict the broker port to that proxy's IP
with the host firewall or set `CONNECTOR_WS_HOST_BIND` to a suitable private
interface.

All generated connector sandboxes store:

```txt
connector.provider         = websocket
connector.protocolVersion  = 2026-07-connector-ws-v2
connector.serverUrl        = platform URL shown in the command
connector.remoteRoot       = root path returned by bootstrap
connector.tokenHash        = sha256(token)
connector.tokenPrefix      = short display prefix only
connector.packageName      = /api/v1/connectors/package.tgz
```

The plaintext token is delivered to the setup page in a short-lived, HttpOnly,
strict-same-site cookie scoped to that sandbox page. It is not written to a URL.
The database stores only the token hash. Rotating a token disconnects the old
session immediately.

Protocol v2 is a breaking upgrade from connector `0.1.8` and earlier. After
upgrading ToolPlane, stop any old connector process, generate a fresh command on
the sandbox page, and run it again. An old process is intentionally rejected
rather than silently using incompatible file or process semantics.

### Disabled Legacy Modes

Older records may still have `kind=host`, `kind=ssh`, or legacy connector JSON
in the database for compatibility, but new host-root, direct-SSH, or
reverse-tunnel sandboxes are no longer created. Recreate them as Docker Linux or
User Connector sandboxes.

```txt
Legacy sandbox row
|-- kind=host       disabled
|-- kind=ssh        disabled
`-- legacy connector disabled
```

## Skill Script Execution

When an agent has both skills and a sandbox, `skill_run_script` writes the
skill bundle into the first attached sandbox before executing:

```txt
.toolplane/skills/<skill-slug>/
|-- SKILL.md
|-- reference files
`-- scripts/*
```

Binary bundle files use `write_file` with base64 encoding and are decoded by the
sandbox runtime without shell commands. Scripts use structured `process_exec`
arguments: Node.js maps to the connector's current Node executable, Python maps
to the native Python launcher/interpreter, and Bash requires Bash to be installed.
On Windows, set `TOOLPLANE_CONNECTOR_BASH` to an absolute executable such as
`C:\\Program Files\\Git\\bin\\bash.exe`; set `TOOLPLANE_CONNECTOR_PYTHON` when
Python is outside `PATH`. `TOOLPLANE_CONNECTOR_SHELL` may select an absolute
`pwsh.exe` path, but `cmd.exe` is not supported for interactive sessions. This
avoids POSIX quoting and `base64 -d` assumptions on Windows.

Without an attached sandbox, `skill_run_script` falls back to the local
temporary execution path with a minimal environment.

## Database

```txt
Workspace 1-* Sandbox
Sandbox 1-1 Deployment
Agent *-* Sandbox via AgentSandbox
```

The sandbox deployment is what the MCP supervisor starts, stops, reconciles, and
exposes to the agent tool builder.
