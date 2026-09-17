# ToolPlane Documentation Index

> **中文**：[README.zh-CN.md](./README.zh-CN.md)
>
> This directory is ToolPlane's single authoritative documentation source. Suggested reading order: **root [README](../README.md) → [ARCHITECTURE.en.md](./ARCHITECTURE.en.md) → topic docs per the tables below**.
> Inspired by [Diátaxis](https://diataxis.fr/), docs are grouped by reader task: **Concepts & Architecture** (understand the system), **Usage & Integration** (accomplish a task), and **Operations & Releases** (run the system).

---

## Concepts & Architecture (Explanation)

| Doc | Contents |
|---|---|
| [ARCHITECTURE.en.md](./ARCHITECTURE.en.md) ([中文](./ARCHITECTURE.md)) | **Main entry**: tech stack, top-level architecture, directory layout, Prisma domain models, console/admin/JSON API overview |
| [HERMES_AGENT_RUNTIME.en.md](./HERMES_AGENT_RUNTIME.en.md) ([中文](./HERMES_AGENT_RUNTIME.md)) | Hermes runtime: configuration projection, lifecycle, network and credential boundaries; see Architecture for the full runtime inventory |
| [SANDBOXES.md](./SANDBOXES.md) ([中文](./SANDBOXES.zh-CN.md)) | Agent sandbox shape: Docker / Connector runtimes, MCP tools exposure, PTY terminal |
| [OBSERVABILITY.md](./OBSERVABILITY.md) ([中文](./OBSERVABILITY.zh-CN.md)) | Logging/audit model: `LogEvent` / `LogDetail` / `AuditEvent` semantics, capture and retention |
| [WORKSPACES.en.md](./WORKSPACES.en.md) ([中文](./WORKSPACES.md)) | Workspace lifecycle: members, invitations, ownership transfer, deletion state machine |

## Usage & Integration (How-to)

| Doc | Contents |
|---|---|
| [TOOLKIT_SYNC.en.md](./TOOLKIT_SYNC.en.md) ([中文](./TOOLKIT_SYNC.md)) | Toolkit sync to Claude Code / Codex / opencode / Hermes: tokens, local file layout |
| [AGENT_CONTROL_MCP.md](./AGENT_CONTROL_MCP.md) ([中文](./AGENT_CONTROL_MCP.zh-CN.md)) | Workspace-level Agent Control MCP: create and invoke agents from MCP clients |
| [AGENT_PUBLIC_API.md](./AGENT_PUBLIC_API.md) ([中文](./AGENT_PUBLIC_API.zh-CN.md)) | Public API for published Agent Endpoints: auth, limits, deployment topology constraints |
| [AGENT_MESSAGING_PLATFORMS.md](./AGENT_MESSAGING_PLATFORMS.md) ([中文](./AGENT_MESSAGING_PLATFORMS.zh-CN.md)) | Messaging channels: Telegram / Feishu(Lark) / QQ / WeChat / Discord / Slack |

## Operations & Releases

| Doc | Contents |
|---|---|
| [RELEASES.md](./RELEASES.md) ([中文](./RELEASES.zh-CN.md)) | release-please workflow and GitHub setup |
| [UI_LIBRARY.md](./UI_LIBRARY.md) ([中文](./UI_LIBRARY.zh-CN.md)) | Shared UI package `@asharca/ui`: update and release workflow |
| [OBSERVABILITY.md](./OBSERVABILITY.md) ([中文](./OBSERVABILITY.zh-CN.md)) | (also) diagnostic capture windows, log export, retention management |
| [WORKSPACES.en.md](./WORKSPACES.en.md) ([中文](./WORKSPACES.md)) | (also) deployment notes for the workspace-deletion migration |

---

## Documentation Conventions

- **Single source of truth**: each topic has one maintained document per language; everywhere else links to it instead of copying paragraphs.
- **Code wins**: when a description conflicts with the code, trust the code and fix the doc; behavior changes update the matching doc in the same PR.
- **New docs**: topic docs live at this directory's root with an all-caps underscore name (`TOPIC_NAME.md`), open with one paragraph stating "what this is and who it's for", and get registered in this index.
- **Languages**: every topic doc is bilingual — Chinese original `NAME.md` + English translation `NAME.en.md`, or English original + Chinese translation `NAME.zh-CN.md`. Both are cross-linked at the top; the index links both. New docs must ship both languages, and changes should update both copies in the same PR.

## Runtime deployment

[Runtime Operations](./RUNTIME_OPERATIONS.md) ([中文](./RUNTIME_OPERATIONS.zh-CN.md)) covers the architecture migration, single-owner recovery, installation credentials and attachment quotas.
