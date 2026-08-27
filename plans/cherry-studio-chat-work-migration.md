# Cherry Studio Agent Chat, Work, And Knowledge Migration Plan

## Context

ToolPlane needs two distinct Cherry Studio-inspired Agent workspaces, not a chat page with an embedded terminal:

- `/app/[workspace]/chat` is conversation-first: users ask, discuss, and retrieve knowledge. It has no sandbox work directory or terminal.
- `/app/[workspace]/work` is execution-first: a user assigns an Agent a task and one of its authorized Sandboxes; the Agent works against that sandbox with tools, files, terminal, task history, and knowledge retrieval.

The implementation retains ToolPlane's multi-workspace authorization, real MCP subprocesses, installed skills, toolkits, sandboxes, model providers, native runtime, and Hermes runtime. This is an adaptation, not a source copy: Cherry is Electron/SQLite; ToolPlane is Next.js/Postgres. Electron-only local paths, desktop windows, local SQLite state, and unrequested URL/note/directory import remain excluded.

## Confirmed Product Decisions

- Migrate Cherry Studio's Agent chat/work experience and knowledge-base capabilities.
- `/chat` is the primary conversation entry; `/work` is a separate Agent task/execution product surface. Agent configuration configures both.
- Workspace knowledge bases are shared but an Agent only receives bases explicitly attached to it.
- Browser-uploaded knowledge files are written to a selected workspace sandbox and indexed from there.
- An Agent may have multiple non-Hermes sandbox bindings with one default. New Work sessions preselect that default. A Work session's sandbox never changes; users start a new Work session to use another sandbox.
- RAG uses a configurable embedding provider/model, vector search, citations, and recall testing.

## Current Findings

- The working tree already has uncommitted chat/sidebar work: `AgentChat.tsx` and its test were deleted while `/chat`, `WorkspaceChat.tsx`, `AgentSettings.tsx`, `AgentModelDialog.tsx`, and tests were added. Extend this foundation; do not restore a parallel chat implementation.
- `WorkspaceChat` streams with `AgentConversation`, but ignores its `conversations` input. Existing console conversation mutations already create/rename/delete private console conversations and reject channel/public-API conversations.
- `AgentSandbox` already authorizes Agent-to-sandbox access, but `resolveAgentTools()` exposes every attached sandbox and has no default or work-session scope.
- `SandboxConsole` already implements terminal, file browser, preview, download, and delete. Its current MCP routes only check workspace membership, so Work needs an Agent/Work-session-scoped proxy.
- Docker sandboxes persist `/workspace` and expose file/process/PTY operations through MCP. This is the upload/import target, without host directory mounts.
- ToolPlane has no knowledge-base, ingestion, embeddings, chunking, vector search, or retrieval tools. `ModelProvider` stores workspace provider credentials safely but currently only builds chat transports.
- Portable Cherry parity includes Agent/session navigation, tool progress, a dedicated work environment, knowledge source/index status, chunk/RAG configuration, reindexing, recall testing, and citations. The current Compose database is plain `postgres:16`; `pgvector` is required for production vector search.

## Recommended Architecture

### Persistence And Infrastructure

Extend the existing Agent domain; do not overload a Chat `Conversation` with task execution state.

- Add `isDefault Boolean @default(false)` to `AgentSandbox` and a partial unique database index enforcing at most one default sandbox per Agent. Existing bindings remain valid with no default.
- Add `WorkSession`: workspace ID, Agent ID, selected Sandbox ID, private linked `Conversation` ID, task/title, lifecycle state/timestamps, and nullable error/result metadata. It owns the execution context; the conversation remains the durable transcript. Sandbox deletion uses `SetNull` and makes the Work session unavailable instead of moving it elsewhere.
- Add `KnowledgeBase` (workspace, name, embedding provider/model/dimensions, chunk size/overlap, retrieval count/threshold); `KnowledgeDocument` (base, source sandbox/path, filename/MIME/size, indexing status/error); `KnowledgeChunk` (document, ordinal, text, vector); and `AgentKnowledgeBase`.
- Delete knowledge records/chunks/links by cascade. Never delete the corresponding sandbox source file because it can belong to active work.
- Change the compose database baseline to a Postgres-16 image with `pgvector`; migration enables `vector`, creates a vector index, and uses Prisma `Unsupported("vector")` plus parameterized raw SQL cosine-distance queries. Document the matching production requirement.

### Runtime And Security

- Extend Agent queries, create/update/clone/configuration mutations, and Agent settings to load/validate default sandbox and knowledge-base links. Exclude Hermes-managed internal sandboxes from selectable work resources.
- Add Work-session create/list/detail/rename/archive mutations and APIs. Creation validates user workspace access, Agent ownership, selected non-Hermes sandbox attachment, and a live/usable sandbox; it then creates a linked private console conversation.
- Extend chat request validation with optional `workSessionId`. Normal Chat has no sandbox tools. Work loads a session by `(workSessionId, workspaceId, agentId, conversationId)` and derives the immutable sandbox server-side. Client-provided deployment/sandbox IDs are never trusted.
- Update `resolveAgentTools()`/`buildAgentToolSet()` to accept an optional Work sandbox. Only Work adds that one sandbox deployment; both Chat and Work retain existing MCP, toolkit, skill, sub-agent, and knowledge-base behavior.
- Add a `knowledge_search` Agent tool only for explicitly linked bases. It embeds the query, runs bounded vector retrieval restricted to those base IDs, and returns source title, sandbox path, excerpt, score, and stable citation IDs. The system prompt instructs the Agent to use it when workspace sources are relevant.
- Add an embedding adapter that reuses workspace `ModelProvider` base URL/secret and initially supports OpenAI-compatible `/embeddings`. Configuration rejects incompatible provider formats rather than guessing vendor APIs.
- Add a Work-session sandbox proxy for terminal and allowed file operations. It resolves the user, Agent, Work session, linked conversation, selected sandbox, and live deployment before forwarding requests. `SandboxConsole` accepts injected RPC/terminal bases so it uses this proxy on Work and retains general routes on sandbox-management pages.
- Add bounded knowledge upload/import APIs: validate workspace/base/sandbox, sanitize path/name, enforce a documented size and MIME/extension allow-list, write the file through sandbox MCP, create a pending document, extract text, chunk, batch-embed, and update status/error. Support text, Markdown, JSON, CSV, PDF, and DOCX with server-side parsers; unsupported/corrupt files remain visible with a recoverable failure state.

### Chat, Work, And Knowledge UX

- Complete `WorkspaceChat` as a conversation-first view: Agent rail, selected-Agent searchable console conversation history grouped by activity, new/rename/delete actions, streaming messages, model controls, attachments, MCP/skill/tool progress, and knowledge citations. It does not show a terminal or sandbox files.
- Add `WorkspaceWork` at `/work`: Agent and Work-session history rail; task creation requiring an Agent and attached sandbox with default preselected; task transcript/progress center; and reusable `SandboxConsole` right surface for the selected sandbox's terminal/files. Work URLs select saved work sessions; task metadata and transcript survive reloads.
- Add an intentional Chat-to-Work handoff that creates a new Work session from the selected Agent and optional task text. It never converts or changes the source Chat conversation.
- On narrow screens, Work terminal/files use an accessible drawer/dialog; Chat and Work never overlap fixed panes.
- Add a workspace `/knowledge` page and sidebar item: base navigator, browser upload/import-sandbox selector, document list/status/errors, reindex/delete, embedding/chunk/retrieval configuration, Agent bindings, and scored manual recall test.
- Render `knowledge_search` source rows in the existing expandable tool-result UI and persist the AI-SDK tool parts so citations are available on reopened conversations and Work sessions.
- Add complete English/Chinese translations using existing `next-intl` conventions.

## Files To Modify

- `prisma/schema.prisma`, `prisma/migrations/<timestamp>_agent_work_knowledge/migration.sql`, `docker-compose.yml`, and deployment documentation for Work sessions, default sandbox, knowledge records, and `pgvector`.
- `src/lib/agents/queries.ts`, `mutations.ts`, `actions.ts`, `resolve.ts`, `run.ts`, `tools.ts`, `system-prompt.ts`, `chat-body.ts`; new focused `src/lib/work/**` and `src/lib/knowledge/**` modules.
- `src/app/api/v1/agents/[agentId]/chat/route.ts`, current conversation route, new Work-session CRUD/sandbox-proxy route(s), and new `src/app/api/v1/knowledge/**` routes.
- `src/app/app/[workspace]/chat/page.tsx`, new `src/app/app/[workspace]/work/page.tsx`, new `src/app/app/[workspace]/knowledge/page.tsx`, `DashboardSidebar.tsx`, and Agent settings page loaders.
- `WorkspaceChat.tsx`, new `WorkspaceWork.tsx`, `AgentConversation.tsx`, `AgentSettings.tsx`, `AgentSettingsForm.tsx`, `AgentResourceSelect.tsx`, plus small conversation list, Work-session list/task creation, and knowledge components.
- `src/components/dashboard/sandboxes/SandboxConsole.tsx` only to inject scoped endpoints, preserving its common UI.
- `messages/en.json`, `messages/zh.json`, and focused unit/integration tests.

## Reuse

- The existing `/chat`, `WorkspaceChat`, `AgentConversation`, private conversation mutations, and assistant-ui stream/tool rendering.
- `AgentSandbox`, `resolveAgentTools`, `buildAgentToolSet`, `buildToolSet`, `skill-tools`, and `assembleSystemPrompt` for authorization/execution.
- `SandboxConsole`, `scripts/sandbox-mcp-server.mjs`, `mcpRpc`, `liveStatus`, and existing terminal proxy patterns for Work terminal/files.
- `ModelProvider`, provider settings/model discovery, and server-only secret boundaries for embedding configuration.
- Cherry Studio references only: `src/renderer/pages/agents/**`, `components/chat/**`, and `pages/knowledge/**`.

## Steps

- [ ] Add `pgvector` support and the Prisma/database migration for default AgentSandbox, WorkSession linked to private conversation and immutable sandbox, knowledge records, indexes, and deletion semantics.
- [ ] Build knowledge services for configuration/CRUD, OpenAI-compatible embedding, parsing/extraction, deterministic chunking, batch indexing/reindexing, vector retrieval, limits, and citation data.
- [ ] Add browser-upload-to-sandbox import APIs and the Knowledge page; retain source files and expose indexing status/errors.
- [ ] Extend Agent settings and mutations with Knowledge Base bindings and default sandbox selection; enforce one default and exclude managed Hermes sandboxes.
- [ ] Implement Work-session creation/history/archive and scope Agent execution so only Work adds its stored sandbox tools; both modes receive knowledge retrieval.
- [ ] Add Work-session sandbox proxy and inject its endpoint bases into `SandboxConsole`.
- [ ] Complete `/chat` conversation history and controls, then build `/work` task assignment/history, transcript, lifecycle state, terminal/files, and responsive Work drawer.
- [ ] Add Chat-to-Work handoff, citation display, i18n, and focused tests without disturbing unrelated dirty files.

## Verification

- Run `pnpm db:generate`, apply the development migration, restart the server, then run focused tests, `pnpm lint`, and `pnpm build`.
- Test default sandbox and Work-session integrity: foreign/detached/Hermes/stopped/deleted sandbox IDs are rejected or safely unavailable; a Work session cannot switch sandbox; normal Chat cannot obtain sandbox tools or a terminal.
- Test every authorization boundary: no cross-workspace import/base retrieval; no Agent access to an unbound knowledge base; no Work proxy access to arbitrary deployment; no turn persisted to another Agent's conversation.
- Test RAG with an OpenAI-compatible embedding stub: upload to sandbox, index document, retrieve only authorized chunks, show `knowledge_search` citations, and retain them after reopening Chat and Work.
- Manually test desktop/mobile `/chat`, `/work`, and `/knowledge`: Chat history/actions; Work task assignment to an authorized sandbox, reload/history/archive, terminal/files, second Work session with another sandbox; Knowledge upload/config/reindex/bind/recall/error states.
