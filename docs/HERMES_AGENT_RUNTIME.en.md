# Historical Hermes Agent Storage

> **中文**：[HERMES_AGENT_RUNTIME.md](./HERMES_AGENT_RUNTIME.md)

Managed `hermes` Agents are retired and read-only. Agent execution now uses only pinned `pi-sdk` revisions. Hermes runtime provisioning, configuration projection, profile/model mutation, image upgrades, dashboards, native chat/Work submission, and automatic startup recovery are removed.

## Retained resource chain

Existing `Agent → AgentRuntime → Sandbox → Deployment` rows and their Docker volumes remain historical storage. History uses the session's actual sandbox association, or its actual retained runtime association when no session sandbox exists. It never reads files from a newly selected template or substitutes a different session.

Historical files can be listed, read, and downloaded while the old container is stopped. These reads use a bounded helper with the retained volume mounted read-only; they do not boot Hermes. Terminal and filesystem mutations are unavailable. The old Agent-level attachment and terminal APIs, runtime dashboard, and runtime MCP API return HTTP 410.

## Stop and deletion

`stopHermesRuntime` drains only the workspace-bound old resource and preserves its volume. Existing named Work cancellation can target a persisted old run only on an already-live runtime; it never resumes or provisions a runtime. Unknown cancellation outcomes are not replayed.

`cleanupHermesRuntime` remains for explicit authorized deletion, with strict container/volume cleanup and workspace operation admission. A stop, restart of the application, or retirement is not deletion authorization. Startup does not boot retained Hermes deployments or run the old dashboard broker.

## Archive import and conversion

Historical archive import remains an offline storage operation: safely extract into stopped, network-isolated historical storage, retain files and import identity, and never project credentials or boot an Agent. The storage producer is [`archive-storage.ts`](../src/lib/agents/hermes/archive-storage.ts).

For new work, create a Pi Agent, copy convertible configuration, explicitly grant its capabilities, and publish a complete revision. Do not claim restoration of old native state. Old messages and volumes remain read-only records. Toolkit conversion freezes supported capabilities as private packages and does not automatically republish public versions.

Legacy client credentials are not valid for new execution. Use the new registration scopes and the pinned session MCP broker. Follow [runtime operations](./RUNTIME_OPERATIONS.md) for ownership and recovery; this document does not authorize a production deployment or data deletion.
