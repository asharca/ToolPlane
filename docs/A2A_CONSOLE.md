# Connect A2A in the console

> [中文](A2A_CONSOLE.zh-CN.md)

Use the existing Agent Work/chat interface for daily work with Pi. A2A remains an integration API for other Agents; settings no longer contain a persistent execution-records/approvals section or task playground. Existing task progress, history and root-tool approvals remain reachable via `/app/{workspace}/agents/{agentId}?settings=a2a&task={taskId}`. Opening a task link does not submit work or grant access. Authorized internal child tasks use parent-delegated tool permission, not an additional human approval.

For workspace users. Open **Agent settings → A2A integration**, or navigate to
`/app/{workspace}/agents/{agentId}?settings=a2a`. The page uses the native A2A 1.0 core; never paste an account token into the browser.

The **Let external services call this Agent** section contains an embedded setup guide, the account-token settings link (or Hermes service-key instructions), copyable Card/SendMessage/GetTask/SubscribeToTask/CancelTask examples, response handling, and troubleshooting. The guide remains readable when connection URLs are unavailable. Viewing or copying documentation never submits a task.

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

## Connection information

Separate local and public RPC / Agent Card URLs are shown with curl examples for Card
retrieval, SendMessage, GetTask, SubscribeToTask and CancelTask. URLs come from configured
`NEXT_PUBLIC_APP_URL`, never untrusted Host / X-Forwarded-Host. Use HTTPS in production;
HTTP is allowed on loopback.

Examples reference environment variables only: `TOOLPLANE_ACCOUNT_TOKEN` for server-side
local integration and `TOOLPLANE_A2A_TOKEN` for published services. They are not interchangeable;
the Card requires authentication too. Replace messageId for every new task. Retry the same
request only with the exact original ID and content. Replace Task ID in query examples.

The in-platform guide shows copyable token `export` setup and `uuidgen`, followed by
always-visible Card and SendMessage curl examples. Run them individually in macOS
Terminal, a Linux terminal or Windows WSL Bash, on a computer that can reach the
displayed URL—not in ToolPlane chat, browser developer tools or an Agent sandbox.
Replace the token placeholder locally and keep subsequent commands in the same
terminal. Shell history may retain the token; do not share history or screenshots.
Fetching the Card starts no task; SendMessage runs the Agent and can consume resources.
Production applications send these HTTP requests from their own backend. Internal
Agent delegation only needs selected sub-agents, not these terminal commands.

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

The public connection section also includes the [native MCP bridge](A2A_MCP_BRIDGE.md),
using the same explicitly granted A2A service credential. Its connection object is an
example, not a universal client configuration format.

Large file uploads, OAuth discovery, token streaming and arbitrary URL network probing are not provided. See [Public A2A](A2A_NATIVE.md) and
[Internal collaboration](A2A_LOCAL_COLLABORATION.md) for the protocol contract.

Native local tasks can now use [registered remote A2A Agents](A2A_REMOTE_AGENTS.md), with separate deployment origin approval, workspace registration and per-caller authorization. Private resources are not automatically exposed.
