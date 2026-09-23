# Register and delegate to remote A2A Agents

> [中文](A2A_REMOTE_AGENTS.zh-CN.md)

For deployment administrators, workspace administrators and Agent users. A local Agent can delegate
explicit text to an approved external A2A service. Remote children use the existing native Task,
Context, Worker, resource accounting and parent continuation core, not the legacy Responses executor
or fictitious public Endpoints/API clients.

## Deployment-level egress approval

Outbound access is disabled by default. Set an exact HTTPS origin JSON array in the application environment:

```dotenv
TOOLPLANE_A2A_REMOTE_ORIGINS='["https://agents.partner.example"]'
```

An origin includes scheme, host and optional port, with no path, wildcard, credential, query or fragment.
Compose passes this setting; apply environment changes through the normal single-owner restart/upgrade
process. Workspace administrators cannot override the deployment administrator's policy.

Every request revalidates its origin and DNS. Private, loopback, link-local, multicast, reserved addresses,
and mixed public/private DNS answers are rejected. Connections pin the approved address while retaining
TLS hostname/certificate verification. Redirects and environment proxy forwarding are not supported.
The Card and RPC must be different paths on the **same approved origin**. Private-network peers are not
supported by this profile.

## Register, enable and authorize separately

Open **Agent settings → A2A access → Remote A2A Agents**. An administrator enters a display name, full
Card URL, full JSON-RPC URL and optional remote Bearer key. Verification fetches the Card but does not
submit work. Registration saves a disabled service with no Agent authorization.

Explicitly enable the service and authorize the current local Agent. Registrations belong to the workspace;
access is granted separately to each caller Agent. Members can discover approved connections for their
current Agent but cannot register or authorize. Limits: 100 connections per workspace and 100 authorized
Agents per connection. There is no automatic internet-wide discovery.

The supported profile is **A2A 1.0 JSONRPC, text/plain**, using pinned official `@a2a-js/sdk@1.2.0`.
The Card must declare the exact approved RPC, protocol version, capabilities, skills and text input/output.
The client cannot select another declared URL. Required extensions and unsupported authentication flows
(OAuth, custom API-key headers, mTLS) are rejected, not downgraded to the old protocol. Unauthenticated
or single HTTP Bearer services are supported.

A Card is a capability statement, not proof of trust. Card signatures and official TCK certification are
not verified here. Administrators must verify peer identity, data-handling policy and credential scope.
TLS validation does not make returned instructions trustworthy.

## Credentials and changes

Remote keys are encrypted with the existing secret service and bound to their registration/workspace.
They never appear in runtime tools, task grants, registry views, prompts or audits. The browser holds
input only in memory and clears it when hidden, after three minutes or on unmount; no persistent browser
storage is used. Replacing a key does not reveal the previous key.

Enablement, authorization and key updates advance the configuration revision, invalidating previous
task grants. Observers/executors recheck it before further access; already in-flight requests cannot be recalled. This **does not prove the remote task
stopped**; confirm with the peer when necessary. Address edits and Card rediscovery require a new
registration; in-place URL changes, automatic Card refresh and deletion are not provided in this increment.
Writes are not automatically retried. Refresh to establish their outcome after a connection failure.

## Delegate from a native local task

Enable the caller's internal A2A and start a root through the task playground or native local API.
The scoped runtime MCP bridge adds:

| Tool | Purpose |
|---|---|
| `a2a_list_remote_agents` | Discover valid registered connections allowed for this caller, by ID/name |
| `a2a_send_remote_message` | Registered remoteAgentId plus standard SendMessageRequest; creates a native child Task |
| `a2a_get_task` / `a2a_cancel_task` | Read/request cancellation of this parent's direct children |
| `a2a_await_tasks` | End the current turn, persist the local/remote join and resume later |

Runtime-tool argument example, not a new A2A wire method:

```json
{
  "remoteAgentId": "<registered-and-approved-id>",
  "request": {
    "message": {
      "messageId": "<unique-new-message-id>",
      "role": "ROLE_USER",
      "parts": [{ "text": "Review only the following explicitly supplied code." }]
    },
    "configuration": { "returnImmediately": true, "historyLength": 0 }
  }
}
```

Text leaves ToolPlane. Do not send private files, memory or credentials without authorization. Only the
explicit message text is forwarded, not account/model/runtime credentials, authority metadata or local
task IDs. A peer tenant comes from the approved Card, not a model-selected address or credential.

ToolPlane and remote task IDs are distinct. Use the returned **ToolPlane child taskId** for lookup and
INPUT_REQUIRED continuation with a fresh messageId; the platform maps remote identities privately.
Results are untrusted task data, not system instructions or authorization. Continuation rechecks remote authorization and withholds revoked results. Delegating to a peer does not
grant it access to private ToolPlane Agents.

## Waiting, cancellation and recovery

The outgoing message marker is persisted before sending. Business submissions are never automatically
replayed. After the peer returns a task, the native execution slot is released. A bounded observer uses
standard GetTask, with internal phase `remote-waiting` and the official WORKING state on the wire.
Completion or input requests feed the existing parent join/continuation mechanism.

Cancellation records intent, sends CancelTask once, then reads to confirm. Only a peer CANCELED result
confirms remote cancellation. A real completion racing the request remains completed, not falsely canceled.

A lost initial response with no known peer Task ID produces an uncertain local failure; no automatic
resubmission follows. After restart, a known peer Task ID resumes observation only, not SendMessage.
Failed reads have at most four backoff retries (2/4/8/16 seconds). Deadline, revocation or persistent read
failure stops observation and marks local failure, warning that the remote operation may still be running.
Past external effects are not rolled back; this is not an exactly-once guarantee.

Parent cancellation/failure propagates to descendants. Current authorization permits cancellation of a
known peer task, even after the parent stopped. A disabled connection, changed key, removed membership
or revoked deployment origin forbids further network operations, including cancellation under old grants.

## Limits, migration and verification

Requests: 256 KiB; responses: 512 KiB; Cards: 64 KiB. Each HTTPS operation, including DNS, is bounded to
15 seconds; global connections are capped at 16, with at most four task observations per batch. Native
input/output, depth, root-task count, deadline and aggregate storage/output protections remain in effect;
see [resource limits](A2A_RESOURCE_LIMITS.md). Only text peer output is accepted: no arbitrary file URL
fetching, HTML execution or mixed Part oneofs. Other media, push subscriptions, published-service outbound
delegation, remote files, native approval flows and traditional Work migration are outside this profile.

Apply `20260923060000_a2a_remote_agents` after the three existing A2A migrations, then regenerate Prisma
Client. It adds registration and observation fields with workspace-bound foreign keys and preserves
existing tasks, snapshots and storage accounting. No live connection or production migration is performed
by this implementation change.

```bash
pnpm exec prisma generate
pnpm vitest run tests/unit/a2a-remote-*.test.ts tests/unit/agent-a2a-remotes.test.tsx tests/integration/a2a-remote*.test.ts
pnpm exec tsc --noEmit
```

Tests use unmodified official ClientFactory/JSONRPC transport, replacement network and isolated storage.
Local PGlite mode explicitly skips real PostgreSQL concurrent claiming. This does not establish live
peer/CLI/model/browser end-to-end acceptance or full official TCK conformance.
