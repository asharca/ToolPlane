# ToolPlane

ToolPlane is a self-hosted control plane for agent tools, skills, MCP servers,
toolkits, and sandboxes. It gives a workspace one place to discover, run,
compose, observe, and attach capabilities to agents.

The repository is public, while each deployment keeps its own credentials,
workspace data, and runtime containers private.

## What It Does

- Browse MCP servers, MCP clients, and agent skills from a public directory.
- Deploy catalog or custom MCP servers from npm, PyPI, GitHub, or Docker.
- Compose deployed servers and skills into reusable toolkits.
- Install toolkits into Claude Code, Codex, and OpenCode-style clients with
  synced MCP and skill bundles.
- Build agents that use model providers, MCP tools, skills, toolkits,
  sub-agents, and sandboxes.
- Run Docker Linux sandboxes or user-machine connectors through a one-command
  WebSocket CLI.
- Observe gateway calls, latency, errors, and plugin sync telemetry.

## Architecture

One Next.js app serves three surfaces:

1. **Directory site** (`src/app/(site)/**`) for public browsing and discovery.
2. **Workspace console** (`src/app/app/[workspace]/**`) for authenticated
   runtime management.
3. **JSON API** (`src/app/api/v1/**`) for MCP JSON-RPC, toolkit manifests,
   connector bootstrap, plugin sync, skill downloads, and agent chat.

The runtime is real, not mocked. Each MCP deployment is a live child process
managed by `src/lib/process/supervisor.ts`, and the gateway proxies JSON-RPC
requests to the live process while recording observability data.

### Agent Control MCP

External AI clients can create and run workspace agents through the Agent
Control MCP endpoint:

```text
POST /api/v1/workspaces/<workspace-slug>/agents/mcp
Authorization: Bearer <personal-api-token>
```

Open **Agents → Connect AI** for ready-to-copy client configuration. The MCP
server exposes safe resource discovery, atomic agent creation, MCP inspection,
and persistent agent messaging without returning provider keys or runtime
secrets. See [docs/AGENT_CONTROL_MCP.md](docs/AGENT_CONTROL_MCP.md).

## Quick Start

Requirements:

- Node.js 20+
- pnpm
- Docker

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
pnpm install
pnpm db:migrate
pnpm tsx scripts/smoke-seed.ts
pnpm dev
```

Default smoke account:

```txt
smoke@example.com / password123
```

The smoke seed also creates eight stopped MCP deployments covering npm, PyPI,
GitHub, Docker, JSON configuration, and a catalog-linked deployment, plus four
installed debugging skills and a private `Debug Starter Kit`. It is
deterministic and does not fetch external skill content or start MCP processes.

Local app URL:

```txt
http://localhost:3000
```

## Common Commands

```bash
pnpm dev
pnpm build
pnpm lint
pnpm test
pnpm db:migrate
pnpm db:generate
pnpm db:studio
pnpm connector:dev
```

Use `pnpm`; the lockfile is `pnpm-lock.yaml`.

## User Connector

User-machine sandboxes do not require SSH or Chisel. Linux, macOS, Windows
PowerShell, and Windows Command Prompt use the same one-line command:

```text
npx -y --no-audit --package "http://localhost:3000/api/v1/connectors/package.tgz?v=0.1.13" connector connect --server "http://localhost:3000" --token "mcpcon_..." --root "~/toolplane-sandbox" --screen-vnc "auto"
```

`--screen-vnc auto` exposes a VNC server already listening on
`127.0.0.1:5900`; use `127.0.0.1:<port>` for another loopback port. The
browser Screen tab uses noVNC and starts read-only. The connector never dials a
VNC address supplied by ToolPlane.

Android phones use an ADB bridge on the computer running the connector:

```text
npx -y --no-audit --package "http://localhost:3000/api/v1/connectors/package.tgz?v=0.1.13" connector connect --server "http://localhost:3000" --token "mcpcon_..." --root "/sdcard/ToolPlane" --android "auto"
```

Install `adb`, authorize exactly one USB or Wireless debugging device, then run
the command. Pass the ADB serial instead of `auto` when several devices are
connected. Android provides shell, files, structured execution when the device
has the requested runtime, and a read-only screen snapshot.

The sandbox page generates the `mcpcon_...` token and stores only its hash.
Bootstrap supplies the configured local root, so OS-specific paths never need
shell quoting in the generated command. HTTP bootstrap and WebSocket
authentication use a Bearer header, so the token is not placed in a URL. The
connector opens a WebSocket session to ToolPlane, then ToolPlane proxies
native-shell execution, structured script execution, file operations, and
terminal streams through that session.

The connector requires Node.js 20+, access to ToolPlane's HTTP/WebSocket
endpoints, and npm registry access for the tarball's `ws` and `node-pty`
dependencies. Windows support targets Windows 10 1809 or newer and Windows 11
on x64/arm64. If PowerShell policy blocks `npx.ps1`, run the same command in
Command Prompt. The connector runs with the permissions of the local user who
starts it; use a dedicated low-privilege account for untrusted agent workloads.
After a connector protocol upgrade, stop the old connector and run a newly
generated command; incompatible old clients are intentionally rejected.

## Deployment Notes

ToolPlane should run as a single, always-on Node process because MCP and sandbox
deployments are supervised in memory. Use a VM, VPS, or container host rather
than serverless functions.

Docker Compose runs Postgres, a restricted Docker socket proxy, and the
prebuilt app image from GHCR:

```bash
docker compose pull app
docker compose up -d
```

The Compose app is published on host port `10030` by default, and the connector
WebSocket broker is published on `9321`. Override `APP_HOST_PORT` or
`CONNECTOR_WS_HOST_PORT` if either port is already in use. Set `APP_HOST_BIND`
and `CONNECTOR_WS_HOST_BIND` to bind specific interfaces. When the reverse proxy
runs on another host, allow the broker port only from that proxy host.

Set `TOOLPLANE_IMAGE` when you want to pin a specific tag, for example
`ghcr.io/asharca/toolplane:sha-dc33d7f`. The published deployment image is
`linux/amd64`; `TOOLPLANE_PLATFORM` defaults to that for server deployments.

### Public URL, TLS, and email

Set `NEXT_PUBLIC_APP_URL` to the one canonical HTTPS origin before exposing an
instance. Terminate TLS at a reverse proxy and forward the original host and
protocol headers. If both apex and `www` DNS records exist, provision a valid
certificate and redirect one hostname to the other; otherwise remove the unused
record so it cannot serve a proxy's default certificate or error page.

Password recovery uses `SMTP_URL` and `SMTP_FROM`. If the instance intentionally
has no outbound email, an administrator can issue a random temporary password
and invalidate existing browser sessions with:

```bash
pnpm account:reset-password -- user@example.com
```

ToolPlane applies a small in-process burst limit to password-recovery requests.
`TOOLPLANE_PASSWORD_RESET_GLOBAL_LIMIT` controls the instance-wide ten-minute
ceiling (default `200`); this is a single-process safety net, not a replacement
for an edge limiter.
At the reverse proxy, also rate-limit login, signup, and password-recovery
Server Actions, and replace (rather than append to) client-supplied
`X-Forwarded-For` / `X-Real-IP` headers before forwarding them to the app.

The app image includes the Docker CLI for Docker-source MCP deployments. It talks to Docker only through the restricted
socket proxy, so keep that proxy private to the Compose network.

### MCP startup timeouts

Custom MCPs installed from npm, PyPI, or GitHub can be quiet while fetching and
installing their first dependencies. Compose exposes
`TOOLPLANE_MCP_STARTUP_IDLE_TIMEOUT_MS` (default `300000`, five minutes) and
`TOOLPLANE_MCP_STARTUP_MAX_TIMEOUT_MS` (default `900000`, fifteen minutes) for
that startup watchdog. Both values are milliseconds and the maximum must be at
least the idle value. Change them in `.env` and recreate/redeploy the app, or
use **Admin → Settings** to save an override that applies to the next MCP start
or restart. The administrator override takes precedence over the environment
value; reset it in the same page to return to the Compose setting.

Admins can update a deployed instance from the workspace sidebar, directly
under the ToolPlane logo. The update action checks the latest GitHub Release,
downloads `TOOLPLANE_UPDATE_ARTIFACT` (default
`toolplane-runtime-linux-amd64.tar.gz`), verifies the `.sha256` asset, replaces
the runtime files in `/app`, and exits the Node process. The HTTP action starts
this work as a background job and returns `202 Accepted` before the download, so
reverse-proxy request timeouts do not turn a successful restart into a reported
502. The browser polls the job and the new process identity until the target
version is serving traffic. Docker or Coolify then restarts the same container
through `restart: unless-stopped`, so the updater does not depend on container
names generated by a platform.

Release artifacts are produced on `v*` tags. Push a tag to publish both the
GHCR image and the self-update artifact.

The app image also bundles the Hermes Python adapters used by hosted agent
messaging channels. The GitHub image build downloads the pinned Hermes source
archive, installs the required messaging extras into
`/opt/toolplane-hermes-venv`, and points the app at `/opt/hermes-agent`.
Local `pnpm dev` can still use `TOOLPLANE_HERMES_ROOT` and `TOOLPLANE_PYTHON`
when you want to run those channel workers outside Docker.

For local debugging, layer `docker-compose.dev.yml` on top to expose Postgres on
`127.0.0.1:5433` and the connector broker port when running the app in Docker.

## GitHub Setup

Recommended repository settings:

- Default branch protection on `main`
- Required checks: `pnpm lint`, `pnpm test`, `pnpm build`
- Secrets: deployment credentials, registry credentials, production env vars

Suggested repository description:

```txt
ToolPlane: self-hosted control plane for agent tools, MCP servers, skills, toolkits, and sandboxes.
```

## References

- Deep architecture notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Sandbox and connector design: [docs/SANDBOXES.md](docs/SANDBOXES.md)
- Toolkit sync design: [docs/TOOLKIT_SYNC.md](docs/TOOLKIT_SYNC.md)
- Agent Control MCP: [docs/AGENT_CONTROL_MCP.md](docs/AGENT_CONTROL_MCP.md)
