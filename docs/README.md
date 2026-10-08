# ToolPlane Documentation

> **中文**：[README.zh-CN.md](./README.zh-CN.md)

Start with the [project overview and quick start](../README.md), then choose a topic below.

## Documentation website

Open `/docs/en` on your deployment domain for the English documentation site, or `/docs/zh` for Chinese. `/docs` opens the Chinese site. Each language has its own landing page, navigation, sidebars, and search:

- **Usage** (`/docs/en/guides`): setup, configuration, integrations, and daily operations.
- **Developers** (`/docs/en/developers`): architecture, runtime internals, contributor and release documentation.
- **API** (`/docs-api`): the standalone Scalar interactive reference backed by `/api/v1/openapi.json`, outside the documentation layout. English protocol and integration guides remain accessible from Developers at `/docs/en/api`.

The site uses [Fumadocs](https://fumadocs.dev) for navigation, responsive layouts and full-text search, with the existing safe Streamdown renderer for Markdown, code and Mermaid. Fumadocs generates the static search index at `/docs/search`; its built-in search dialog searches locally, filtered by the current language and category. Relative Markdown links preserve their target language; non-document repository links open GitHub. `src/lib/docs-links.ts` contains the shared link resolver.

The Markdown files remain the single source of truth: edit `docs/**/*.md`, the root `README.md` / `CHANGELOG.md`, or `infra/firecrawl/README.md`; do not maintain a second website copy. `source.config.ts` defines the Fumadocs MDX collection and assigns categories and language at build time: `.en.md` is English, `.zh-CN.md` is Chinese, and unsuffixed documents use Chinese when their first heading contains Chinese characters, otherwise English. Keep headings in the document's language. URLs use `/docs/{language}/{category}/{repository-relative-topic}`, without language filename suffixes; language pairs share a topic. Keep relative links and language pairs intact; update the category mapping when introducing a new topic. Agent instructions, plans, hidden files, environment files, and source code are not published as documentation. Everything in the published set is public: never put credentials or private operational data in it.

The official Fumadocs MDX Next.js plugin compiles the allowlisted `.md` files as Markdown, not MDX, and includes their processed Markdown and search data in the application bundle. There is no request-time filesystem loader or separate content-copy pipeline. Docker and release archives use the same standalone bundle; raw documentation files are not needed beside `server.js`. Rebuild and redeploy after documentation changes.

## Architecture and runtimes

| Document | Covers |
|---|---|
| [System architecture](./ARCHITECTURE.en.md) · [中文](./ARCHITECTURE.md) | Stack, modules, and data models |
| [Pi / Claude Code / DSH](./AGENT_RUNTIMES.md) · [中文](./AGENT_RUNTIMES.zh-CN.md) | Execution paths, native sessions, and security boundaries |
| [Hermes runtime](./HERMES_AGENT_RUNTIME.en.md) · [中文](./HERMES_AGENT_RUNTIME.md) | Configuration, lifecycle, and credential isolation |
| [Hermes RPC](./HERMES_RPC_RUNTIME.md) · [中文](./HERMES_RPC_RUNTIME.zh-CN.md) | Independent native Hermes in a selected Docker sandbox: configuration, sessions, isolation and tests |

## Usage and integrations

| Document | Covers |
|---|---|
| [Toolkit sync](./TOOLKIT_SYNC.en.md) · [中文](./TOOLKIT_SYNC.md) | Syncing MCP and Skills to AI clients |
| [Remote MCP HTTP](./REMOTE_MCP_HTTP.md) · [中文](./REMOTE_MCP_HTTP.zh-CN.md) | HTTP/HTTPS endpoints, plaintext risks, and preserved security boundaries |
| [Sandboxes and connectors](./SANDBOXES.md) · [中文](./SANDBOXES.zh-CN.md) | Docker, device connections, terminals, and screens |
| [Agent Control MCP](./AGENT_CONTROL_MCP.md) · [中文](./AGENT_CONTROL_MCP.zh-CN.md) | Creating and invoking Agents from MCP clients |
| [Public Agent API](./AGENT_PUBLIC_API.md) · [中文](./AGENT_PUBLIC_API.zh-CN.md) | Publishing Endpoints, authentication, and limits |
| [A2A console integration](./A2A_CONSOLE.md) · [中文](./A2A_CONSOLE.zh-CN.md) | Enable access, copy examples, manage credentials and inspect local tasks |
| [A2A MCP bridge](./A2A_MCP_BRIDGE.md) · [中文](./A2A_MCP_BRIDGE.zh-CN.md) | Native tasks from external MCP clients |
| [A2A resource limits](./A2A_RESOURCE_LIMITS.md) · [中文](./A2A_RESOURCE_LIMITS.zh-CN.md) | Payload storage, output reservation and migration |
| [Remote A2A Agents](./A2A_REMOTE_AGENTS.md) · [中文](./A2A_REMOTE_AGENTS.zh-CN.md) | Registration, egress policy, remote delegation and recovery |
| [Native A2A 1.0](./A2A_NATIVE.md) · [中文](./A2A_NATIVE.zh-CN.md) | Standard tasks, subscriptions, independent execution and publication authorization |
| [Local A2A collaboration](./A2A_LOCAL_COLLABORATION.md) · [中文](./A2A_LOCAL_COLLABORATION.zh-CN.md) | Local identities, native delegation, durable parent joins and continuation |
| [Messaging channels](./AGENT_MESSAGING_PLATFORMS.md) · [中文](./AGENT_MESSAGING_PLATFORMS.zh-CN.md) | Telegram, Feishu/Lark, QQ, WeChat, Discord, and Slack |
| [Workspace management](./WORKSPACES.en.md) · [中文](./WORKSPACES.md) | Members, invitations, ownership, and deletion |

## Deployment and maintenance

| Document | Covers |
|---|---|
| [Deployment configuration](./DEPLOYMENT.en.md) · [中文](./DEPLOYMENT.md) | Images, ports, HTTPS, email, and updates |
| [Upgrades and recovery](./RUNTIME_OPERATIONS.md) · [中文](./RUNTIME_OPERATIONS.zh-CN.md) | Migrations, single-owner recovery, and attachment quotas |
| [Logging and audit](./OBSERVABILITY.md) · [中文](./OBSERVABILITY.zh-CN.md) | Log models, diagnostic capture, and retention |
| [Releases](./RELEASES.md) · [中文](./RELEASES.zh-CN.md) | release-please and GitHub configuration |
| [Shared UI](./UI_LIBRARY.md) · [中文](./UI_LIBRARY.zh-CN.md) | Updating and releasing `@asharca/ui` |

## Maintenance conventions

- Maintain one Chinese/English pair per topic, cross-link it at the top, and register both versions in both indexes. Link rather than duplicate content elsewhere.
- Code defines behavior. Update both languages in the same PR as implementation changes. Prefer Mermaid for architecture and flow diagrams.
- Place new topics at the root of `docs/`, pairing `TOPIC_NAME.md` with `.en.md` or `.zh-CN.md`, and open with the purpose and intended audience.

- [Unified ingress and pre-execution approvals](./A2A_INGRESS_APPROVALS.md)
