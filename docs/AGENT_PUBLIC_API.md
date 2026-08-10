# Agent Public API

ToolPlane exposes published Agent Endpoints through its own HTTPS gateway. It never publishes the
Hermes container API, dashboard port, runtime token, model-provider key, workspace session, or MCP
runtime token.

## Required deployment topology

Public Hermes execution currently supports exactly one runtime-owning ToolPlane application process
or replica. The Hermes/Docker supervisor, runtime write leases, execution queue and MCP subprocess
table are process-local. Postgres coordinates admission, usage, idempotency and cancellation state,
but that does not make runtime execution active-active safe. Route all Agent API execution and
lifecycle work to the one owner; do not run this feature across multiple ToolPlane app replicas.
Active-active operation requires an external runtime owner/supervisor and distributed execution
queue, which are not part of this release.

## Before publishing

An Endpoint is a versioned public deployment of a Hermes Agent. Publishing creates clean managed
runtime allocations instead of reusing the Agent's console volume. Console sessions, memories,
attachments, environment variables, local plugins, cron jobs, and files are not copied.

The publisher explicitly selects Skills and MCP deployments for the Endpoint. Every selected MCP
Deployment must be explicitly marked `publicInvocable`, use ToolPlane's `allowlist` exposure mode,
and have a non-empty tool allowlist. The Endpoint revision snapshots that allowlist. On every
`tools/list` and `tools/call`, the runtime MCP gateway intersects the snapshot with the Deployment's
current `publicInvocable` flag and current exposure policy, so revoking public approval takes effect
without republishing.

Public MCP deployments are workspace services, not per-subject sandboxes, and ToolPlane does not
automatically inject `end_user` into tool arguments. Only publish tools that are stateless or that
independently authenticate and enforce a tenant scope on every operation. Do not expose a shared tool
whose credentials can read or mutate data across API clients or end-user subjects.

Public runtimes do not receive sub-Agents, arbitrary sandboxes, ToolPlane user tokens, or terminal and
dashboard capabilities. ToolPlane also disables Hermes' terminal, file, code execution, web/browser,
memory, delegation, cron, messaging and other built-in toolsets in the managed public profile. Only
the published `mcp-toolplane` surface is enabled.

Public revisions accept only Hermes release tags reviewed by the running ToolPlane version. At
publication, ToolPlane pulls the reviewed tag, resolves its registry digest and persists the immutable
`repository@sha256:...` value in the revision; public runtimes execute that pinned digest. Operators
can additionally allow exact digests with `TOOLPLANE_PUBLIC_HERMES_IMAGES`. `latest`, unresolved tags
and arbitrary custom tags are rejected.

Isolation modes:

- `subject` (recommended): every API-client + HMAC-namespaced `end_user` receives a separate hidden
  Hermes Agent, container and volume. Conversations retain their server-owned transcript, while
  different API clients and subjects cannot share files or runtime state.
- `shared`: one clean public runtime is shared by every caller. Use this only inside one trust domain
  when shared memory is intentional and user-private content is not submitted.

## Authentication

Long-lived keys start with `tp_agent_`, are scoped to one Endpoint client, and are shown only once.
ToolPlane stores only a SHA-256 hash. Keys may expire or be revoked without changing the Endpoint.
They are server credentials and must not be embedded in browser JavaScript or mobile applications.

A server key with `client_tokens:create` can mint a `tp_client_` token valid for at most 15 minutes.
The token is bound to the Endpoint, API client, HMAC of the end user, scopes, and (for browser use)
one exact allowed origin. ToolPlane rejects long-lived keys on requests carrying `Origin`; Endpoint
CORS configuration does not make a long-lived key safe for browsers.

```bash
curl https://toolplane.example.com/api/v1/agent-endpoints/agep_xxx/client-tokens \
  -H 'Authorization: Bearer tp_agent_xxx' \
  -H 'Content-Type: application/json' \
  -d '{"end_user":"customer-42","origin":"https://app.example.com","expires_in":900}'
```

A successful mint returns `201 Created`. The short-lived token is returned in plaintext and is not a
replacement for keeping the long-lived server key secret.

## Native Responses API

```bash
curl -N https://toolplane.example.com/api/v1/agent-endpoints/agep_xxx/responses \
  -H 'Authorization: Bearer tp_agent_xxx' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: request-123' \
  -d '{
    "input": "Summarize the deployment status.",
    "end_user": "customer-42",
    "stream": true
  }'
```

The first response returns a `cnv_...` conversation ID. Send it on later turns. Conversation IDs are
bound to Endpoint, API client and end-user subject; a valid key cannot read another client's or
subject's conversation.

Streaming uses versioned SSE events:

- `response.created`
- `response.output_text.delta`
- `response.completed`
- `response.failed`
- `data: [DONE]`

`Idempotency-Key` is optional but strongly recommended whenever an Agent can call a side-effecting
tool. Reusing a key with the same request replays only a completed response (JSON or SSE, matching the
new request's `stream` choice). If the original response is still provisioning/running, the replay
returns `409 idempotency_conflict`; if it ended failed or cancelled, it returns the corresponding
terminal error instead of running the tool again. Reusing the key with different input also returns
`409 idempotency_conflict`. Use a new key only when an intentional retry may repeat side effects.

Additional native operations:

- `GET /api/v1/agent-endpoints/{endpoint_id}` — capabilities and effective limits.
- `GET /api/v1/agent-endpoints/{endpoint_id}/responses/{response_id}` — reconcile after a dropped stream.
- `POST /api/v1/agent-endpoints/{endpoint_id}/responses/{response_id}/cancel` — durably request cancellation.
- `GET /api/v1/agent-endpoints/{endpoint_id}/conversations/{conversation_id}` — retained text transcript. `limit` defaults to 20 and accepts 1–100; pass the last `next_cursor` as `after`. The response includes `has_more` and `next_cursor` (and a character cap may make a page shorter than `limit`).
- `DELETE /api/v1/agent-endpoints/{endpoint_id}/conversations/{conversation_id}` — atomically tombstone the conversation, block new turns and immediately remove its database-visible messages. Hermes session cleanup is a separate best-effort phase and is retried by maintenance; empty runtime/volume garbage collection follows later. `204` does not depend on the runtime being reachable.

## OpenAI SDK compatibility

Use `https://toolplane.example.com/api/openai/v1` as the SDK base URL and the `agep_...` Endpoint ID as
the model. The adapter accepts user and assistant text messages. It rejects system/developer/tool
messages, caller-defined tools and provider/model overrides; the published Endpoint revision owns
those capabilities. This compatibility route is server-to-server: because the Endpoint id is in the
JSON `model` field rather than the URL, an unauthenticated browser preflight cannot be checked against
an Endpoint origin allowlist. Browser clients should use the native endpoint-scoped Responses API.

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.TOOLPLANE_AGENT_API_KEY,
  baseURL: 'https://toolplane.example.com/api/openai/v1',
});

const result = await client.chat.completions.create({
  model: 'agep_xxx',
  user: 'customer-42',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

## Limits and errors

Endpoints and clients have DB-backed minute and daily request limits. Admission also enforces
Endpoint/client daily output-character budgets, retained-transcript character budgets, Endpoint
persistent-runtime limits, configured concurrency and one active turn per conversation/runtime. A
workspace has hard ceilings of 500,000,000 output characters per UTC day and 1,000,000,000 retained
transcript characters. Active runs reserve their maximum possible 200,000-character output and
220,000-character transcript growth before execution, so admission fails closed rather than
oversubscribing a budget.

Public JSON requests are limited to 256 KiB and must be read within 30 seconds. A response accepts at
most 20,000 input characters and emits at most 200,000 output characters. Endpoint execution timeouts
are 10–840 seconds, with 840 seconds as the hard maximum. Public attachments and remote-URL ingress
are disabled.

Authentication failures are additionally bounded per HMAC-obscured client address. Run admission,
idempotency, budgets and conversation serialization use Postgres row locks/unique constraints and
retry serialization conflicts. These durable controls prevent concurrent requests from bypassing
limits, but they do not change the single runtime-owner topology described above. Disconnects,
timeouts, Endpoint disable and explicit cancellation abort the Hermes fetch and release runtime
leases; the runtime owner also polls the durable cancellation marker.

Per-address authentication limits use proxy address headers only when
`AGENT_API_TRUST_PROXY_HEADERS=true`. Enable it only behind a trusted reverse proxy that overwrites
those headers; a global pre-authentication limit remains active either way.

Errors use a stable JSON envelope with a code such as `invalid_api_key`, `conversation_busy`,
`idempotency_conflict`, `rate_limit_exceeded`, `runtime_maintenance`, or `upstream_error`. Internal
Hermes/provider response text, ports, paths and secrets are never returned. Rate responses include
`Retry-After` and `RateLimit-*` headers.

The OpenAPI 3.1 document is available at `/api/v1/openapi.json`.

## Retention and lifecycle

ToolPlane runs a bounded startup/hourly cleanup pass. It deletes expired Hermes sessions and database
transcripts, removes terminal response records after the Endpoint retention window, prunes usage
counters, and destroys empty hidden containers/volumes. A separate pass runs every minute and stops
public runtime containers idle for 15 minutes while preserving their volumes for lazy resume.
Deleting a source Agent first disables its Endpoint, cancels active public runs, destroys every hidden
public runtime, and only then removes the source. If cleanup cannot complete, deletion stops
fail-closed rather than orphaning a callable runtime.
