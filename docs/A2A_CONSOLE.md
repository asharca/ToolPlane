# Connect A2A in the console

> [中文](A2A_CONSOLE.zh-CN.md)

Use the existing Agent Work/chat interface for daily work with Pi. A2A remains an integration API for other Agents; settings no longer contain a persistent execution-records/approvals section or task playground. Existing task progress, history and interactive-entry root-tool approvals remain reachable via `/app/{workspace}/agents/{agentId}?settings=a2a&task={taskId}`. Opening a task link does not submit work or grant access. Authenticated inbound A2A roots and authorized internal children use their configured tools without human approval; ordinary chat/Work/Control/channel root policies are unchanged.

For workspace users. Open **Agent settings → A2A integration**, or navigate to
`/app/{workspace}/agents/{agentId}?settings=a2a`. The page uses the native A2A 1.0 core; never paste an account token into the browser.

Settings retain access controls, authorization, connection URLs and credential management, not an embedded tutorial or request examples. Open `/docs-api` on the deployment domain for Scalar's standalone reference, sourced from `/api/v1/openapi.json`: account A2A, published-service A2A, the MCP bridge and existing Agent APIs. Documentation is public and contains no account data or real credentials.

## Internal collaboration

Configure Pi, Claude Code, DSH or Hermes RPC with a model and an exclusive,
networked Docker sandbox. Select allowed sub-agents in the caller's delegate
settings. Internal delegation from authenticated chat, Work and control needs no
additional A2A switch on the caller or selected targets. Selection authorizes only
those directed edges, not the whole workspace. Managed Hermes is not an internal
execution target.

A separate Context is not a separate filesystem: tasks can use the target sandbox's
files, memory and configured tools. Removing an allowed edge invalidates affected
grants when authority is rechecked; completed side effects do not roll back.
The separate **External A2A & channel access** switch still requires an owner or
administrator's confirmation. It governs external calls, account-token A2A root
invocation and channel execution authorization, not selected internal delegates.

Open an owned root task link to inspect the bounded parent/child monitor and, for a root tool requiring a human decision, its approval controls. Settings no longer offer task submission, task-list or continuation controls; use the existing chat/Work surfaces or the documented A2A API. Current actor, target configuration and every delegation edge are rechecked. Knowing another user's task ID does not confer access; inaccessible subtrees are withheld.

Submitting can consume model credits and use tools. Opening the page never starts a
task. Accepted is not completed. Read-only monitoring normally refreshes every 2.5 seconds,
pauses while the document is hidden, stops after all visible tasks terminate, and offers
explicit pause/resume/refresh controls. A request times out after 15 seconds; network
failures back off and stop after three consecutive failures. Reads never resubmit work.
This is state polling, not a token stream. Leaving the page does not cancel accepted work.
Cancellation may return WORKING until execution stops. Terminal tasks cannot reopen.

Text and JSON artifacts are rendered as escaped text. Small inline files require an
explicit download and are forced to attachment data, never active HTML previews. File
names are sanitized and object URLs revoked; no remote artifact URL is fetched. See
[local artifacts](A2A_LOCAL_COLLABORATION.md#artifacts) for supported formats and limits.

## Published services and credentials

Publish an active isolated Hermes Endpoint in **API publication**, then enable external
A2A separately. Public clients do not inherit private workspace Agent permissions.

Create a dedicated client and key under **External client credentials**. The client,
key hash and audit are committed in one transaction. Scopes are fixed to `a2a:send`,
`a2a:read`, `a2a:cancel`; existing Responses clients are not upgraded. The page only
lists dedicated A2A clients, and members cannot see credential management records.

Plaintext is returned once and stays only in component memory. It is cleared after
three minutes, on leaving the tab, or on dismissal; it is never persisted in browser
storage or inserted into examples/public logs. Adding a replacement key does not revoke
an existing key: migrate the caller first, then explicitly revoke the old key.
Administrators may revoke keys even when the Endpoint is disabled.

Client/key creation is not idempotent. After a lost response, refresh the list before
retrying; the page never automatically retries writes. A failed list refresh does not
hide a key successfully returned by the preceding transaction. This entry caps an
Endpoint at 100 clients and a client at 50 key records, including revoked history.

## Connection information and API documentation

Settings show copyable account and published-service RPC / Agent Card URLs. URLs come from configured `NEXT_PUBLIC_APP_URL`, never untrusted Host / X-Forwarded-Host. Production requires HTTPS; loopback permits HTTP, with RFC1918 private IPv4 also permitted in development.

Read parameters, authentication, JSON-RPC methods, SSE responses and generated request examples at `/docs-api`. Scalar is bundled with the application, with no runtime CDN, persisted credentials or hosted AI. A2A is server-to-server: run generated requests from your own backend; existing Origin, Bearer and workspace authorization checks remain unchanged.


## Browser versus protocol boundary

The console uses a separate same-origin BFF:

```text
GET /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console
POST /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console
POST /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console/rpc
GET /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console/tasks?rootTaskId=...
```

These are ToolPlane browser endpoints, not a new A2A transport. Writes require a valid
session and an Origin exactly matching the deployment configuration. Explicit Authorization,
cross-site requests and forged user/workspace/scopes are rejected. Mutations recheck current
administrator authority inside the transaction.

The public and server-side local A2A wire endpoints remain Bearer-only; they do not gain
cookie or cross-origin browser support. The BFF does not fabricate an account token or call
legacy Responses/collaboration workers. Native-task approvals remain separate from Work approval sessions;
supported classic entry adapters now use [unified ingress](A2A_INGRESS_APPROVALS.md); channels require explicit operators and old records are not replayed.

The MCP transport, connection URL and tools are also documented at `/docs-api`, using the same dedicated A2A service credential. See [native MCP bridge](A2A_MCP_BRIDGE.md) for internal protocol boundaries.

Large file uploads, OAuth discovery, token streaming and arbitrary URL network probing are not provided. See [Public A2A](A2A_NATIVE.md) and
[Internal collaboration](A2A_LOCAL_COLLABORATION.md) for the protocol contract.

Native local tasks can now use [registered remote A2A Agents](A2A_REMOTE_AGENTS.md), with separate deployment origin approval, workspace registration and per-caller authorization. Private resources are not automatically exposed.
