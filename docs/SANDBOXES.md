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

### User Connector

Connector mode lets a user expose one directory on their own machine without
opening SSH, configuring keys, or letting the platform dial arbitrary user
hosts. The user runs one command:

```bash
npx -y --package http://localhost:3002/api/v1/connectors/package.tgz connector connect \
  --server http://localhost:3002 \
  --token mcpcon_... \
  --root ~/toolplane-sandbox
```

The sandbox page generates the `mcpcon_...` token when creating a connector
sandbox or when the user clicks **Generate command**. The command starts a
local connector agent. That agent calls the platform bootstrap endpoint,
discovers the WebSocket broker, and then keeps one authenticated WebSocket
session open.

```txt
User machine
`-- connector package tarball from /api/v1/connectors/package.tgz
    |-- local shell
    |-- local filesystem root
    `-- local PTY
        |
        | WebSocket
        v
Platform connector broker
`-- sandbox-mcp-server
    |-- shell_exec
    |-- list_dir
    |-- read_file
    |-- write_file
    `-- terminal stream
```

Important properties:

- The platform never opens a connection to the user machine.
- The connector token authenticates the WebSocket session.
- File operations are constrained under the `--root` directory by the client.
- Interactive terminals are real PTYs created on the user machine by
  `node-pty`, so shell completion and normal terminal behavior are preserved.

The Next.js server starts a connector broker during `instrumentation.ts`:

```txt
NEXT server process
|-- connector WebSocket broker
|   |-- public WS /connect?token=...
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
to `10030`. For local Docker debugging, `docker-compose.dev.yml` also publishes
the broker port:

```yaml
app:
  ports:
    - '${APP_HOST_BIND:-0.0.0.0}:${APP_HOST_PORT:-10030}:3000'
    - '127.0.0.1:${CONNECTOR_WS_HOST_PORT:-9321}:9321'
```

For production behind Coolify or another reverse proxy, route the broker's
container port and set `CONNECTOR_WS_PUBLIC_URL` to the public WebSocket
endpoint, for example:

```txt
wss://example.com/connect
```

## Sandbox-native MCP deployments

Custom MCP deployments can be attached to a Docker sandbox at creation time.
ToolPlane still exposes them as ordinary MCP deployments, but their file
workspace is the sandbox workspace:

- npm, GitHub, and PyPI sources are started with `docker exec` inside the
  sandbox container at `/workspace`.
- Docker-image MCP sources run as a sidecar with the sandbox volume mounted at
  `/workspace`, so file paths match the sandbox even though the process is in
  its own image.
- Skill scripts attached to the same agent also use that linked sandbox by
  default, so `skill_run_script` and MCP tools see the same files.

This is the preferred pattern for tools that accept paths, such as OCR or code
analysis MCPs. The agent should pass `/workspace/...` or relative sandbox paths
instead of copying large files through chat context.

and route that endpoint to the broker.

All generated connector sandboxes store:

```txt
connector.provider         = websocket
connector.protocolVersion  = 2026-07-connector-ws
connector.serverUrl        = platform URL shown in the command
connector.remoteRoot       = root path used by the connector command
connector.tokenHash        = sha256(token)
connector.tokenPrefix      = short display prefix only
connector.packageName      = /api/v1/connectors/package.tgz
```

The plaintext token is shown only immediately after creation through the
redirect URL. The database stores only the token hash.

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
