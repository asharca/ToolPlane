# Remote MCP: HTTP compatibility and transport risks

> **中文**：[REMOTE_MCP_HTTP.zh-CN.md](./REMOTE_MCP_HTTP.zh-CN.md)

This guide is for users and administrators connecting ToolPlane to a remote MCP server. Remote MCP supports `https://` (recommended), `http://`, and explicit ports from 1 to 65535. In JSON configuration, `"type": "http"` selects Streamable HTTP; it does not require an unencrypted URL. HTTPS endpoints use the same type.

## HTTP example

```json
{
  "mcpServers": {
    "internal-mcp": {
      "type": "http",
      "url": "http://mcp.example.com:8000/mcp",
      "allowUnsafeHttp": true
    }
  }
}
```

For authenticated servers, JSON import still supports Bearer authentication through `headers.Authorization`. Storing credentials in ToolPlane's managed variables does not encrypt the upstream HTTP connection.

## Risks users must understand

**HTTP provides no TLS encryption, server identity verification, or transport integrity.** Bearer tokens, other authentication headers, tool arguments, and results exchanged between ToolPlane and the remote MCP server may be intercepted or modified. Stolen credentials may be reused; modified tool results can also influence subsequent Agent behavior.

Prefer HTTPS. Use HTTP only after assessing a trusted, isolated network or an encrypted tunnel covering the entire connection. An internal network is not automatically safe. Avoid sending production credentials or sensitive data over unencrypted HTTP.

**HTTPS on the ToolPlane website does not protect the ToolPlane → upstream MCP HTTP connection.** A browser's secure-connection indicator says nothing about that upstream link.

HTTP endpoints require the explicit `allowUnsafeHttp: true` plaintext-risk approval in their connection configuration; a warning alone is not consent. JSON `type: "sse"` selects legacy SSE, while `type: "http"` selects Streamable HTTP. Neither transport falls back to another transport or downgrades HTTPS. The bridge emits a secret-free startup warning for approved HTTP.

Creation actions require the installing operator's separate `allowUnsafeHttp=true` form choice. A downloaded recipe or imported JSON declaring `allowUnsafeHttp` is not consent. Unapproved catalog connections remain `setup_required` with `unsafeHttpConfirmationRequired`; existing connections can use the explicit approval action, including fresh shared-impact confirmation. Approval does not automatically invoke business tools.

## Security boundaries remain enforced

HTTP support does not allow arbitrary destinations. Private targets still require the administrator's private-host allowlist; localhost, loopback, link-local/cloud metadata, and other restricted addresses remain blocked. DNS validation and pinning, same-origin requests, and redirect rejection are unchanged.

Endpoint URLs cannot contain a username, password, query parameters, or a fragment. The existing query-parameter exception is limited to same-origin session POST URLs returned by SSE servers.

This is compatibility for explicitly configured HTTP endpoints, not an automatic HTTPS-to-HTTP fallback. OAuth TLS requirements are unchanged.

## Protocol validation and execution ownership

Connection readiness validates authentication, MCP initialization and the advertised tool catalog, without executing business tools. It is evidence of protocol availability at that moment, not proof that every business operation will succeed. Newly discovered tool names do not expand a pinned session's grants.

Once a tool is approved for a grant (an Agent's `AgentServer` row or an Assistant's `ChatAssistantMcpGrant`), its description, input/output schema and annotations are fingerprinted. If a later `tools/list` response changes that fingerprint, the tool is paused for that grant — excluded from what the model can call — until an operator reviews the before/after diff and explicitly re-approves it from the deployment's connection page. A tool rename is still treated as delete-plus-new, not an automatic remap.

Assistant connections must be actual remote endpoints: stdio recipes and ToolPlane Agent/A2A gateways are rejected. Agent stdio runs through `src/lib/process/session-mcp.ts` in a hardened Docker sidecar whose identity includes the workspace, Agent, immutable revision and Conversation or A2A context. Two sessions never share a writable process or cache; no Agent work volume is mounted. Only the recipe's explicit environment and read-only managed configuration projection are delivered. `stopSessionMcp` stops its sidecars without deleting session work files.

Session catalogs are read directly from the live, generation-consistent MCP process with bounded pagination and launch-secret redaction. Synthetic session process IDs are not Deployment rows: their catalogs are neither persisted as shared Deployment catalogs nor discarded because no such row exists. Pinned and live tool-name grants still filter every discovered catalog and call.

Agent connection review uses `inspectAgentMcpConnection` from `src/lib/process/agent-mcp-inspection.ts`. It authorizes an active owner/admin and the current applied Pi revision/default sandbox before artifact preparation or secret access; the shared connection need not be running or granted to that Agent. Each inspection uses a disposable, source-tracked process with the prepared immutable recipe and scoped connection credentials, no Agent work volume, and only the controlled handshake plus bounded `tools/list`. The helper stops and cleans the process before atomically recording redacted tools and recipe/file checksums against the still-current target. Invalid catalogs, target drift, revoked authority or cleanup failures cannot create a successful receipt; explicit reviewed CAS Apply remains the only grant mutation.

Agent revision preparation requires exact npm/PyPI versions or Git commits, then captures their complete installed dependency tree in an immutable local Docker image. Capture uses a hardened non-root container with no user credentials, Agent files, configuration mounts or platform secrets; it installs dependencies but never invokes the MCP server or its business tools. Docker recipes are snapshotted without starting them. Publication only inspects the reviewed artifact ID and provenance labels; a failed capture or stale definition cannot replace the active revision. Session startup executes the captured binary directly, never `npx`/`uvx` or a network reinstall. Captured images are retained for revision rollback; missing artifacts require explicit preparation, not a silent rebuild. Runtime config-file ciphertext identity and explicit per-Agent live tool grants are rechecked along with revision ownership on every call. Changing a recipe requires a new approved revision; credentials may rotate without storing their values in the revision.

Shared configuration and credential edits return impacted Agent and Assistant IDs and require explicit confirmation of the freshly recomputed set. Installing a package must not mutate an existing shared connection.

Remote editing preserves plaintext-risk approval only for the exact previously approved endpoint; a changed HTTP URL needs a new explicit operator choice. Remote discovery returns a recipe checksum, and Agent sandbox discovery additionally records the exact managed-file checksum. Discovery evidence cannot authorize a changed recipe or turn newly advertised tools into grants. Pinned remote calls serialize with shared connection edits and check the actual running remote client's private identity, including its resolved credential values, rather than trusting a displayed source label.

Session stdio and remote calls compare freshly resolved credentials with the actual process using a process-private HMAC after each idempotent start and again after tool discovery. Rotation or removal—including optional keys—cannot leave an old process authorized under the new configuration: missing or mismatched launch identity returns `MCP_CONNECTION_RESTART_REQUIRED` before any business RPC. The comparison key and MAC stay in process memory, never in the registry, logs or external responses; no automatic restart or credential fallback occurs.

The remote identity key has the same process lifetime as supervisor launch records, including across route-bundle instances and development module reloads. It is never regenerated per request or module instance. A launch created before this key-lifetime cutover must be explicitly stopped and started; identities are not silently re-signed and cannot fall back to an unkeyed digest.

Explicit connection credential/configuration edits, file-secret changes, stops, restarts and deletion drain every associated session sidecar before committing the change. Source associations are recorded before launch queuing, so pending starts are stopped too; container and private configuration-projection cleanup failures abort the mutation. Other sources and session work volumes remain untouched. Session RPC and connection mutations share the source lifecycle lock, preventing an old-credential launch between teardown and commit. A later authorized request can start a fresh session sidecar with the new credentials.

Runtime-file updates reject already-known aggregate count/byte overflows before stopping healthy processes. The serializable persistence transaction repeats the same limit checks after teardown, so a concurrent file change still cannot bypass the limits. Stop/kill sends the current process its signal without waiting for source-sidecar cleanup or queued database writes; the caller nevertheless waits for all associated cleanup, and secret persistence is forbidden if any cleanup fails.

Startup reconciliation never resumes deployments bound to retired Agent runtimes or runs legacy readiness callbacks. Their containers remain eligible only for controlled stop/drain and historical-file handling; ordinary non-Agent MCP recovery remains unchanged.

The spawn factory rejects retained Hermes recipes with `AGENT_RUNTIME_RETIRED` instead of treating them as ordinary Docker sandboxes. The supervisor no longer generates legacy runtime tokens, model configuration or Hermes-specific startup/readiness settings; bound historical stop/delete cleanup remains separate.
