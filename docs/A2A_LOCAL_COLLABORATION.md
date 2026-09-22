# Native A2A local collaboration

> [中文](A2A_LOCAL_COLLABORATION.zh-CN.md)

For Agent configuration and runtime maintainers. Local collaboration shares the
A2A 1.0 Handler, Context, Task, request deduplication, events and Worker with
[public A2A services](A2A_NATIVE.md). The pinned official SDK remains
`@a2a-js/sdk@1.2.0`; no custom A2A RPC methods or task states are introduced.

## Identity and execution boundaries

A local Context records targetKind=local, workspace, Agent, requesting user and a
configuration fingerprint. It does not require a fake Endpoint, API client or private
Conversation. Published contexts retain their revision and client isolation. Public
credentials cannot enter the local API, and the public Hermes executor does not gain
access to private Agents through this feature.

Pi, Claude Code, DSH and Hermes RPC use their configured exclusive Docker sandboxes,
models, MCPs, Skills and Toolkits. Context.id identifies a separate native session,
**not a fresh filesystem**. Tasks for the same Agent may see that Agent's existing
sandbox files and native memory. Enable this only for workspace users authorized to
use those resources. Managed `hermes` stays on its public execution port.

The new runtime port does not call runAgentTurn, the old collaboration Worker,
Responses execution, runDedicatedSandboxTurn or a private Conversation. Existing
chat, Work, messaging and Control MCP entries are **not automatically switched**;
Work approval must not be bypassed by such a switch. This increment exposes the API
and runtime tools. A new collaboration UI and explicit migration of old entries are
separate acceptance work.

## Opt-in and root invocation

Configure models, connected Docker sandboxes and tools for the caller and targets.
Use the caller's existing Sub-agent settings to select allowed directed targets.
An edge does not authorize access to the entire workspace.

Both caller and targets default to disabled. A workspace owner or administrator must
enable each one using an account-level Bearer credential:

```bash
curl -X PUT "$TOOLPLANE_URL/api/v1/workspaces/$WORKSPACE/agents/$AGENT_ID/a2a/local" \
  -H "Authorization: Bearer $ACCOUNT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"enabled":true}'
```

GET on the same URL returns the standard protected Agent Card; POST accepts the same
A2A 1.0 JSON-RPC methods as the public interface. Members may invoke enabled Agents,
but cannot enable them. Writes recheck administrator authority in the transaction
and record an audit. Cookies, Toolkit tokens, public credentials, runtime tokens and
browser Origin requests cannot authenticate this entry.

```bash
curl "$TOOLPLANE_URL/api/v1/workspaces/$WORKSPACE/agents/$AGENT_ID/a2a/local" \
  -H "Authorization: Bearer $ACCOUNT_TOKEN" \
  -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{
    "message":{"messageId":"review-001","role":"ROLE_USER","parts":[{"text":"Delegate review and testing, then summarize their results."}]},
    "configuration":{"returnImmediately":true,"historyLength":0}
  }}'
```

GetTask, SubscribeToTask, CancelTask and SendMessage provide observation,
cancellation and additional input. Retry a messageId only with identical content.
Use taskId only to continue a live input-required task; terminal tasks are not reopened.

## Executor tools

Each execution receives a restricted MCP bridge. This is a CLI tool adapter into the
native A2A core, not another task database or a nonstandard A2A wire binding.

| Tool | Purpose |
| --- | --- |
| a2a_list_agents | Discover linked, enabled and configured targets by ID and name |
| a2a_send_message | Send agentId plus a standard A2A SendMessageRequest; return the accepted Task immediately |
| a2a_get_task | Read a direct child Task, including its question and artifacts |
| a2a_cancel_task | Request cancellation of a child and its descendants |
| a2a_await_tasks | Persist a join on direct children, then end the current turn normally |
| a2a_request_input | Record a question, then end normally; never approve an operation |

Caller, root, parent, depth, deadlines and authorization are server-derived, not
model-controlled metadata. Signed runtime credentials bind both Task and execution
lease. Generic model-proxy tokens cannot delegate. Suspension, input requests and
completion invalidate the current lease; continuation receives a new token. Model
and MCP proxies check that same lease. Account tokens never enter the sandbox.

## Durable waiting and continuation

After submitting B and C, the parent calls a2a_await_tasks and exits the execution turn
normally. The core persists the join and releases its execution and sandbox slots.
The public Task state stays TASK_STATE_WORKING. Internal phase values queued,
executing, waiting, resumable, paused and done are never new A2A enum values.

When all selected children terminate or require input/auth, the parent becomes
resumable. Transactional claiming and fresh leases prevent duplicate execution.
A user-role continuation message in the original Context carries child results as
**untrusted task data**, not system instructions or permissions. Oversized results
are represented by IDs for explicit retrieval rather than unbounded context injection.

An input-required child wakes its parent. The parent supplies the same child taskId
with a new messageId and waits again, or asks its own caller for information. A normal
parent exit also joins unfinished direct children when no explicit wait was recorded.
Crashes/timeouts cannot masquerade as successful pauses.

Root failure, cancellation or revoked authority stops descendants. A running task is
canceled only after its executor stops; prior external effects are not rolled back.
Restart preserves waiting/resumable records, but fails previously executing tasks
whose side effects are uncertain. It does not automatically replay them.

## Capacity and operations

A root allows at most 16 tasks and three delegation edges; a parent resumes at most
16 times. Descendants inherit the root deadline (at most 840 seconds); added input
cannot extend it. A workspace admits at most 16 active local tasks and an owner keeps
at most 256 tasks; each Context permits 128 tasks. Native input/output/snapshot/history
limits also apply. The account entry admits 120 requests/minute per workspace/user;
the execution bridge has its own bounded request limit.

A single runtime owner still manages at most four executor slots, preferring deeper
tasks. Waiting parents release their slots. A sandbox write gate covers chat, Work
and A2A; a busy sandbox leaves an A2A task queued rather than executing and retrying
side effects. Different native sessions cannot rewrite the same sandbox concurrently.

These are task, execution and time limits, not a precise token/currency budget.
Binary artifacts, remote registries, native per-tool approval bridging, automatic
migration of old entry points and distributed execution are not advertised.

Apply 20260922010000_a2a_local_collaboration after the native core migration, then
regenerate Prisma Client. Existing published Context ownership is backfilled and
its revision, identity and snapshots retained. Local shape constraints and scheduling
fields are additive; legacy conversations/tasks are not replayed, migrated or deleted.

```bash
pnpm exec prisma generate
pnpm vitest run tests/unit/a2a-*.test.ts tests/integration/a2a-local.test.ts tests/integration/a2a-native.test.ts
pnpm exec tsc --noEmit
```

Runtime-port tests cover projection into all four dedicated runtimes; task lifecycle
tests use a replacement executor. MCP interoperability uses the unmodified official
client. PGlite deliberately skips real PostgreSQL concurrency tests and cannot prove
lock semantics. Live CLI/model/browser end-to-end acceptance and official A2A TCK
certification have not been completed.
