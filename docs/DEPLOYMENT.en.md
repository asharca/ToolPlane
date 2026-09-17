# Deployment Configuration

> **中文**：[DEPLOYMENT.md](./DEPLOYMENT.md)

This guide is for operators deploying and maintaining ToolPlane. It covers images, networking, email, startup timeouts, and updates. See the [quick start](../README.md#快速开始) for startup commands and [Upgrades and Recovery](./RUNTIME_OPERATIONS.md) for migrations and failure recovery.

## Runtime environment

Use a VM, VPS, or container host with **one long-running application process**. MCP and Sandbox deployments use an in-process supervisor. Serverless is unsuitable, and database locks do not establish support for concurrent execution across application replicas.

[Docker Compose](../docker-compose.yml) runs Postgres, a Docker Socket Proxy, and a prebuilt application image from GHCR. The application accesses Docker through the restricted proxy. Keep that proxy private to the Compose network; never expose the Docker API publicly.

| Setting | Purpose |
|---|---|
| `AUTH_SECRET` | Replace with a random secret, generated with `openssl rand -base64 32` |
| `NEXT_PUBLIC_APP_URL` | Canonical public address for generated install commands, callbacks, and connection settings |
| `TOOLPLANE_IMAGE` | Application image; pin a release or commit tag for production |
| `TOOLPLANE_PLATFORM` | Published server image platform; defaults to `linux/amd64` |

See [`.env.example`](../.env.example) for the full configuration reference. Do not commit instance secrets, production environment files, or backups.

## Ports and reverse proxy

Compose publishes these default ports. Each corresponding `*_HOST_BIND` setting controls the bind address:

| Service | Default host port | Port setting | Bind address setting |
|---|---|---|---|
| Application HTTP | `10030` | `APP_HOST_PORT` | `APP_HOST_BIND` |
| Connector WebSocket Broker | `9321` | `CONNECTOR_WS_HOST_PORT` | `CONNECTOR_WS_HOST_BIND` |
| Hermes Dashboard Broker | `9332` | `HERMES_DASHBOARD_HOST_PORT` | `HERMES_DASHBOARD_HOST_BIND` |

Unset bind settings default to `0.0.0.0` in Compose; the example environment file binds some brokers to loopback, so check the effective configuration. Prefer `127.0.0.1` when the reverse proxy runs on the same host. For a separate proxy host, bind a private address and allow access only from that proxy. Configure external broker addresses with `CONNECTOR_WS_PUBLIC_URL` and `HERMES_DASHBOARD_PUBLIC_URL`; see [Sandboxes and Connectors](./SANDBOXES.md) and [Hermes Runtime](./HERMES_AGENT_RUNTIME.en.md) for routing details.

Use HTTPS for public service, terminate TLS at the reverse proxy, and forward the correct host and protocol. Set `NEXT_PUBLIC_APP_URL` to the actual entry point. When both the root domain and `www` exist, provide valid certificates for both and redirect to one canonical address; remove unused DNS records.

The proxy must replace, rather than append to, client-supplied `X-Forwarded-For` / `X-Real-IP` headers. Apply edge rate limits to login, signup, and password-recovery Server Actions.

## Email and account recovery

Configure password-recovery email with `SMTP_URL` and `SMTP_FROM`. Without outbound email, an administrator can run this in an application environment connected to the correct database:

```bash
pnpm account:reset-password -- user@example.com
```

The command issues a random temporary password and invalidates existing browser sessions. Deliver the temporary password securely; do not include it in public logs.

`TOOLPLANE_PASSWORD_RESET_GLOBAL_LIMIT` controls the instance-wide password-recovery request ceiling over ten minutes, defaulting to `200`. This in-process protection does not replace reverse-proxy rate limits.

## MCP startup timeouts

Initial dependency downloads from npm, PyPI, or GitHub can be slow. Compose provides two startup-watchdog settings, both in milliseconds:

| Setting | Default | Meaning |
|---|---|---|
| `TOOLPLANE_MCP_STARTUP_IDLE_TIMEOUT_MS` | `300000` | Maximum time without progress (5 minutes) |
| `TOOLPLANE_MCP_STARTUP_MAX_TIMEOUT_MS` | `900000` | Total startup limit (15 minutes); must not be below the idle limit |

Recreate or redeploy the application after editing `.env`. Alternatively, save overrides under **Admin → Settings** for subsequent MCP starts or restarts. Administrator settings take precedence; resetting them restores the environment configuration.

## Updates and releases

Back up Postgres and managed runtime volumes and review the [upgrade sequence](./RUNTIME_OPERATIONS.md#upgrade-sequence) before upgrading. Never overlap old and new application instances against the same runtime domain.

Administrators can check GitHub Releases from the update entry in the workspace sidebar. The updater downloads `TOOLPLANE_UPDATE_ARTIFACT` (default `toolplane-runtime-linux-amd64.tar.gz`), verifies its `.sha256` asset, replaces runtime files under `/app`, and exits. Docker or Coolify restarts the same container through `restart: unless-stopped`.

Update requests return `202 Accepted` before downloading. The browser then checks the task status and new process identity. HTTP success or a running container alone does not establish a completed upgrade; confirm that `/api/v1/readiness` returns HTTP 200 before admitting runtime traffic.

Publishing a `v*` tag produces both a GHCR image and the self-update runtime assets. See [Releases](./RELEASES.md) for image publishing, release-please, and repository settings.

## Development and CI

Overlay `docker-compose.dev.yml` for local development to expose Postgres at `127.0.0.1:5433`. The host development application uses `http://localhost:3000`; do not retain the Compose public address on port `10030`.

Use `pnpm db:seed` only for local demos. It creates the demo account, stopped debug MCP deployments, Skills, and a Toolkit without fetching external Skills or starting MCP processes. Messaging channels use native Node transports; local development requires neither a Hermes checkout nor a Python channel runner. See [Messaging Channels](./AGENT_MESSAGING_PLATFORMS.md) for integration details.

Full CI runs on pull requests or manual dispatch, not again after merging to `main`. Recommended protection requires up-to-date PRs and the `validate`, `connector (ubuntu-latest)`, `connector (macos-latest)`, and `connector (windows-latest)` checks, including for administrators. Shared UI comes from the published `@asharca/ui` npm package maintained in `asharca/ui`; see [Shared UI](./UI_LIBRARY.md).
