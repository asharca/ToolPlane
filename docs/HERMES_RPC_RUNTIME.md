# Retired Hermes RPC Runtime

> **中文**：[HERMES_RPC_RUNTIME.zh-CN.md](./HERMES_RPC_RUNTIME.zh-CN.md)

`hermes-rpc` is historical data, not an executable Agent runtime. New and resumed Agent execution uses only `pi-sdk` with a complete, published revision pinned to the persisted session. There is no Hermes RPC installer, driver, bootstrap, or dispatch fallback.

## Historical sessions

- Keep existing messages, file volumes, and native state as historical records. They are not imported into a Pi session or replayed to simulate continuity.
- Historical Conversation and Work DTOs are read-only. Files are served from their actual bound storage, including stopped volumes; the current Agent template is never a fallback.
- Terminal, upload, write, delete, resume, model selection, and compaction are unavailable for historical sessions. Compaction of an executable Pi session uses its real native `/compact` command.
- Normal stop preserves volumes. Explicit authorized deletion is a separate destructive action; retirement does not authorize deletion.

## New execution

Create a Pi Agent, copy only convertible configuration, explicitly authorize its capabilities, and publish a complete revision. Each Conversation or delegated A2A context pins its revision and lazily creates an independent persistent sandbox from that immutable environment. A new session does not restore old Hermes state.

Model/tool operations intersect pinned capability scopes with current authorization. Revoked package releases, credentials, and MCP grants fail before tool effects. MCP sidecars are session-scoped and stop with that session without deleting its workspace volume.

The retired Agent-runtime MCP and dashboard endpoints return HTTP 410. Legacy public executable APIs are retired as well; their retained history is not a new Pi execution endpoint. External clients must be registered for the new scopes rather than reuse legacy tokens.

See [Agent runtimes](./AGENT_RUNTIMES.md) and [runtime operations](./RUNTIME_OPERATIONS.md). This cutover is not authorization to restart production, migrate production data, or remove retained volumes.
