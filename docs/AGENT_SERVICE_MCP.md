# Agent Service MCP: invocation without administration

> **中文**: [AGENT_SERVICE_MCP.zh-CN.md](./AGENT_SERVICE_MCP.zh-CN.md)

This is the first service-exposure increment. It adds an invocation-only MCP adapter to an already published public Agent Endpoint. It is not [Agent Control MCP](./AGENT_CONTROL_MCP.md), A2A, or a durable asynchronous task implementation.

```text
POST /api/v1/agent-endpoints/<public Endpoint ID>/mcp
Authorization: Bearer <Agent API key or subject-bound Agent Client Token without an Origin binding>
Accept: application/json, text/event-stream
Content-Type: application/json
```

## Setup and authority

Publish a supported Endpoint and issue an API Client/key as described in the [public API guide](./AGENT_PUBLIC_API.md). Use its `agep_...` public ID, not the private source Agent ID. The adapter reuses existing published revisions, isolated public runtimes, conversation ownership, quotas, timeouts, and retention. It adds no database migration or runtime support.

Existing valid Endpoint credentials can use this transport. Do not distribute an account-level personal token. Give mutually untrusted integrations separate API Clients. A permanent key represents its Client, not an authenticated individual chosen by the model through `end_user`. For user-level isolation, a trusted backend must mint a subject-bound short-lived Client Token.

This increment is server-to-server only. All requests with an `Origin` header, including `Origin: null`, are rejected. Browser access, CORS and OAuth discovery are not implemented. Clients must support remote Streamable HTTP with a preconfigured Authorization header. Cookies, personal tokens, Toolkit tokens and internal runtime tokens are not accepted credentials.

| Tool | Required scope | Operation |
|---|---|---|
| `invoke_agent` | `responses:create` | Invoke this published Agent; continue an owned conversation with `conversation_id` |
| `get_agent_response` | `responses:read` | Read a response scoped to the authenticated Client/subject |
| `cancel_agent_response` | `responses:create` and `responses:read` | Request cancellation and return the public response |

Discovery filters tools by current scopes; execution checks again. Cancellation also requires read scope because it returns response content. No management, workspace enumeration or private-configuration tools are exposed. Strict arguments reject Agent/Endpoint overrides, system prompts, model selection and caller-supplied tools.

## Invocation

Configure the remote MCP URL and Authorization header in the client. After standard initialization, invoke:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "invoke_agent",
    "arguments": {
      "input": "Review the supplied patch and explain the issues.",
      "end_user": "review-worker",
      "idempotency_key": "review-request-001"
    }
  }
}
```

Keep credentials in client configuration, never in model prompts or tool arguments. The adapter rejects literal forwarding of the request's Bearer credential in invocation arguments; this is not general anonymization of business content.

MCP text content contains the public Responses API JSON, including `id`, `conversation_id`, `status`, `output_text` and `usage`. It contains no private runtime identifier or container configuration. Usage remains character counts, not precise tokens or cost.

## Retry, lifecycle and cancellation

A new business action requires a new `idempotency_key`. Retry the same action only with the identical key and arguments. JSON-RPC request IDs are not business idempotency keys. A stored replay reads the existing public response without executing the model again. Deduplication is bounded by record retention and does not guarantee exactly-once external side effects.

A replay may still be `running` or `provisioning`; inspect status or query the response instead of claiming completion from HTTP 200. Invocation failures use `isError: true` and stable public errors. A successful result lookup may describe a failed business execution.

Execution remains synchronous and preserves the existing Responses API disconnect-cancellation behavior. Configure client timeouts appropriately. The adapter does not launch detached jobs or promise durable continuation after disconnect. Cancellation does not undo side effects or confirm that the native process has stopped.

## Protocol and security

This adapter implements MCP `2025-06-18` with `2025-03-26` compatibility, not a claim about the latest MCP version. Unknown initialization versions negotiate a supported server version; unsupported `MCP-Protocol-Version` headers return 400. GET, DELETE and OPTIONS return 405: no standalone SSE stream, MCP Session, browser preflight or paginated tool catalog is provided.

References: [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) and [tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools). Only one JSON-RPC message is accepted per request; notifications cannot invoke tools. Initialization and discovery also undergo authentication and rate accounting. Avoid rapid polling.

Public content remains under `suppressPayload`. The adapter does not expose private conversations, Agent configuration, the workspace control interface, internal delegation grants or runtime credentials.

## Verification and remaining increments

```bash
pnpm vitest run tests/unit/agent-service-mcp.test.ts tests/integration/agent-service-mcp-auth.test.ts
pnpm exec tsc --noEmit
pnpm lint
```

Integration tests require isolated PostgreSQL and never start real models or sandboxes. Unit tests include an in-memory handshake, discovery and invocation with the repository's official MCP client SDK. Real CLI/model and deployed-runtime acceptance remain separate checks.

Durable task events, parent continuation, a unified Tasks API, A2A/Agent Cards, remote Agent registration and additional public runtime isolation are separate increments. This change does not modify the existing collaboration state machine or managed Hermes volumes.
