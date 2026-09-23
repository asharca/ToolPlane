# Connect A2A in the console

> [中文](A2A_CONSOLE.zh-CN.md)

For workspace users. Open **Agent settings → A2A integration**, or navigate to
`/app/{workspace}/agents/{agentId}?settings=a2a`. The page uses the native A2A 1.0
core; never paste an account token into the browser.

## Internal collaboration

Configure Pi, Claude Code, DSH or Hermes RPC with a model and an exclusive,
networked Docker sandbox. A workspace owner or administrator can explicitly enable
internal A2A after confirming the resource boundary. Members can inspect connection
information and invoke enabled local Agents, but cannot manage access. Configure
allowed delegates and enable each target separately; no workspace-wide opt-in occurs.
Managed Hermes is not an internal execution target.

A separate Context is not a separate filesystem: tasks can use the target sandbox's
files, memory and configured tools. Disabling internal A2A invalidates accepted work
when the native core rechecks authority. Completed external side effects do not roll back.

The local playground runs as the signed-in member, using the same native Handler:
submit a task, list your latest 20 tasks, get a task by ID, supply input to an
INPUT_REQUIRED task, or request cancellation. The bounded list is not an all-user
workspace list and omits artifacts; select a task and use **Get task** to retrieve
its current status and text result. Knowing another user's, workspace's or delegated
task's ID does not confer access.

Submitting can consume model credits and use tools. Opening the page never starts a
task. Accepted is not completed; the playground currently uses manual queries, not
automatic chat streaming. Leaving the page does not cancel accepted work. A cancellation
request may return WORKING until execution actually stops. Terminal tasks cannot reopen.

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

## Browser versus protocol boundary

The console uses a separate same-origin BFF:

```text
GET /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console
POST /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console
POST /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console/rpc
```

These are ToolPlane browser endpoints, not a new A2A transport. Writes require a valid
session and an Origin exactly matching the deployment configuration. Explicit Authorization,
cross-site requests and forged user/workspace/scopes are rejected. Mutations recheck current
administrator authority inside the transaction.

The public and server-side local A2A wire endpoints remain Bearer-only; they do not gain
cookie or cross-origin browser support. The BFF does not fabricate an account token or call
legacy Responses/collaboration workers. Playground tasks are not Work approval sessions;
existing Work, chat and messaging entry points are not automatically migrated.

No remote-Agent import, file transfer, OAuth discovery, token streaming or arbitrary URL
network probing is provided. See [Public A2A](A2A_NATIVE.md) and
[Internal collaboration](A2A_LOCAL_COLLABORATION.md) for the protocol contract.
