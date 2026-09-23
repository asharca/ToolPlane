# Native A2A workbench

> [中文](A2A_WORKBENCH.zh-CN.md)

For workspace users. Open **A2A workbench** from the Work page header or **Agent settings → A2A integration → Open workbench**.
Direct entry and recoverable task links:

```text
/app/{workspace}/work?mode=a2a&agent={agentId}
/app/{workspace}/work?mode=a2a&agent={agentId}&task={taskId}
```

This mode calls the native A2A Handler, Task, Context and Worker directly. It does not create a compatibility Response,
private Conversation or legacy WorkSession. URLs contain selections, never credentials. Opening a link, refreshing or
selecting an Agent only reads state. Sharing a link does not grant access: the current session and workspace authorization
are checked before every task read or operation.

## Getting started

Configure the model and exclusive networked Docker sandbox, then explicitly enable internal A2A in the
[A2A settings](A2A_CONSOLE.md). Supported local runtimes are Pi, Claude Code, DSH and Hermes RPC. Managed Hermes retains
its existing public-service and classic Work entry points. Only supported ordinary Agents in the current workspace are
listed, and disabled Agents are never enabled automatically.

Select an Agent, enter a goal and submit it. On acceptance, the page updates its task URL and displays the collaboration
tree, task states, message history and artifacts. Submission consumes model/tool resources. Accepted does not mean completed.
No account token or external-service credential needs to be pasted into the browser.

The sidebar initially lists the current caller's latest 20 tasks. More pages can be requested explicitly, up to 200 retained
list entries in this UI. Selecting history is read-only. List failures and task-lookup failures are displayed separately;
a failed initial lookup can be retried explicitly without submitting new work. The native core still enforces full read
scope: a different member's ID or a guessed delegated task ID does not authorize a standalone read.

## Task versus Context continuation

| State | Input behavior |
|---|---|
| No selected task | A new message creates a new Task and Context |
| `INPUT_REQUIRED` | A new messageId addresses the same taskId and contextId without extending its deadline |
| `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED` | A new Task uses the same contextId and referenceTaskIds containing the previous task; terminal tasks are not reopened |
| `SUBMITTED`, `WORKING` | Observe the task or cancel explicitly; do not start concurrent execution in its Context |
| `AUTH_REQUIRED` | Ordinary text does not grant authorization; no automatic approval is offered |

**New context** differs from a follow-up in the selected Context. It starts a new native session rather than reusing the
Context's runtime-session binding. An independent Context is **not a new filesystem**: the Agent still uses its configured
sandbox files and native memory. Message history is bounded to 32 entries; tree and artifact limits remain those of the
core, rather than loading unlimited history into the browser or model.

## Network errors, retries and cancellation

Before submission, the current page retains the messageId and complete request in memory. If the network fails or the
result cannot be confirmed, nothing is resent automatically. **Retry the same message** explicitly resends that identical
request; native message deduplication returns already accepted work. While the outcome is unresolved, editing and task
selection are disabled to prevent changing content under the same ID. The task list can still be refreshed for inspection.

Discarding the local pending request does **not cancel work the server may already have accepted**. Pending content is not
written to localStorage/sessionStorage, so a reload or navigation cannot guarantee recovery of an unconfirmed message ID.
Inspect the task list before submitting the same business action again. Accepted tasks have taskId-bearing URLs that restore
state on reload without executing again.

Leaving the page aborts browser reads, not accepted tasks. Cancellation requires an explicit confirmation and the UI keeps
observing until the core confirms cancellation or reports the actual terminal outcome. Past tool side effects are not rolled
back, and requests already sent to remote services cannot be forcibly recalled.

The task tree uses read-only polling, not model token streaming. Hidden pages pause, users can pause/refresh, and transient
read failures have a bounded retry policy. A 401/403/404 clears the prior task snapshot and stops automatic reads instead of
continuing to display an access-revoked cache. Other temporary failures may retain the last snapshot with an error notice.
Restored access requires an explicit read again.

## Classic Work, chat and messaging boundaries

This is an **explicit native mode** of `/work`, not a rename of old records. Existing `w` and `c` URLs keep opening classic
Work/chat; combining them with `mode=a2a` is rejected. Returning to classic Work does not migrate, delete or replay old sessions.

Native execution uses the explicitly enabled Agent's scope and new one-call approvals, not old WorkApproval records.
Supported classic adapters now use [unified ingress](A2A_INGRESS_APPROVALS.md). Managed Hermes, some native
interactive approval callbacks and full historical memory migration remain outside this increment.
Local/remote delegation uses existing restricted runtime tools. Remote access still requires the deployment allowlist,
admin registration/enablement and per-Agent grants. See [remote Agents](A2A_REMOTE_AGENTS.md) and
[local collaboration](A2A_LOCAL_COLLABORATION.md).

## Validation and deployment

This increment changes no schema or dependencies. Deploying the full PR still requires its previously listed native, local,
storage-accounting and remote migrations. Component and isolated database tests cover follow-ups, input continuation,
deduplication, recovery URLs, authorization and safe text rendering. Runtime test doubles are not real model/browser/TCK acceptance,
and local PGlite is not a substitute for PostgreSQL concurrency tests.
