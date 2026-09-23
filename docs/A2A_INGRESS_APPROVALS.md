# Unified ingress and pre-execution approvals

> [中文](A2A_INGRESS_APPROVALS.zh-CN.md)

For operators and integration developers. This increment connects the existing native core; it does **not** certify every runtime or complete end-to-end acceptance.

## Scope and identity

Classic chat, Work, Agent Control MCP and explicitly authorized messaging connections for Pi, Claude Code, DSH and Hermes RPC submit through `submitNativeEntry` / `runNativeEntry` into the same A2ATask, A2AContext and Worker. Disabled or unsupported configuration fails closed, never falls back to the old executor. The managed `hermes` classic and isolated public adapters remain compatibility paths.

Local A2A must be explicitly enabled with a configured model and exclusive networked Docker sandbox. Only text ingress is supported. Attachments and legacy CLI slash commands are not silently discarded or executed outside approval.

A2AEntryBinding maps the authenticated actor, entry kind and source record to a native Context. A2AEntryReceipt binds the source message ID and content digest to its accepted Task. Task admission, mappings and receipts are transactional. Retrying identical content returns the original Task; changing content under the same ID is rejected. INPUT_REQUIRED keeps the task and deadline; terminal follow-up creates a new task in the same context.

The first migrated conversation starts a new native Context. Old history remains readable, but old tool operations and full native memory are **not imported or replayed**. WorkSession and Conversation remain presentation records, not independent executors for these runtimes. Actors do not share one another's native contexts.

Disconnect detaches observation, not execution. The classic chat stop-reading action is not task cancellation: use the linked native workbench to explicitly cancel. Explicit Work cancellation is propagated to the root and descendants. Failed Work cannot silently replay its previous accepted message as new work; submit a new explicit input. External effects are not rolled back.

## Messaging connections

An external sender ID is not a platform identity. A workspace administrator must bind their current account under **Agent settings → A2A access → Messaging execution identity**. Incoming payloads and models cannot choose a platform actor. Existing sender/source/sandbox restrictions remain in force.

Execution and approval access recheck the bound operator, connection state, configuration and ancestor permissions. Revoking the connection stops subsequent access. Missing operators never fall back to the workspace owner. The workbench link returned to a channel grants no access; the bound operator must sign in. A message saying “approve” is not an approval.

This increment does not add a durable channel outbox. A durable task must not be confused with guaranteed final-response delivery after process failure.

## One-call approvals

A2AToolApproval binds the task, execution lease, native call ID, tool name, canonical input hash and expiry. The runtime registers interception before reporting readiness; model/MCP access for that lease is blocked until ready. Persistent CLI process reuse includes the credential digest, preventing a subsequent round from reusing expired authority while keeping native conversation state.

The private console shows the exact JSON input and approve-once/deny actions. Initial policy conservatively approves each native tool call, not a permanent allowlist. Input is limited to 16 KiB, 32 approvals per task and five minutes bounded by the original deadline. Transactions serialize decisions and consumption. Changed arguments, duplicate consumption, revocation, cancellation, old leases and expiry fail closed. Uncertain permission delivery is not replayed. Audits store identifiers, hashes and decisions, not full inputs.

A live blocked pre-tool callback leaves the public state WORKING. No custom A2A status is added; AUTH_REQUIRED is not repurposed for model-driven approvals. The process keeps its execution slot and sandbox while waiting. Unresolved approvals prevent successful task completion; this is not transparent process checkpointing.

## Native adapters and limits

| Runtime | Interception | Remaining constraint |
| --- | --- | --- |
| Pi | `tool_call` extension | Pinned contract; real CLI/model acceptance is not proven |
| Claude Code | explicit SessionStart/PreToolUse settings; no blanket bypass in approval mode | dontAsk remains; runtime hook crash semantics still require real CLI acceptance |
| DSH | `tools/pre-execute` middleware preserving downstream denials | Not a post-execution log observer |
| Hermes RPC | original `tool_execution` middleware; exactly one `next_call` with the approved copy | Native session-only interactive approval requests remain rejected, not auto-approved |

Hermes middleware exceptions before `next_call` can fail open upstream. The gate returns a tool-error result on every pre-decision failure instead of throwing; downstream tool exceptions are not retried. It does not disable built-in Hermes approvals. This control plane is not an OS isolation boundary against malicious runtimes/plugins or an already-approved arbitrary shell command.

## Transport boundaries

```text
POST /api/v1/agent-runtime/a2a/{taskId}/approvals
GET  /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console/approvals?rootTaskId=...&taskId=...
POST /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console/approvals
```

The runtime uses a task/lease-bound Bearer for ready/check only, never approval. Console actions use same-origin authenticated sessions, no API-token fallback. Cross-origin requests, caller-supplied actors/arguments and stale hashes are rejected. Classic UIs link to the native workbench for decisions; not every legacy surface has an embedded approval panel.

## Migrations and acceptance

After the existing native, local, accounting and remote migrations, apply:

```text
20260923110000_a2a_tool_approvals
20260923113000_a2a_entry_bindings
```

Generate Prisma Client and restart using the single-runtime-owner procedure. Historical Work/channel operators remain unbound; records are not automatically started or replayed. Never run development seed/tests on production.

Regression tests cover identity, deduplication, continuation, revocation, one-use decisions, network errors, HTTP authorization/CSRF and UI. The Hermes contract test executes an unmodified upstream middleware module with a test plugin registry and execution callback; it is **not real CLI/model E2E**. PGlite is not evidence for PostgreSQL locks. Browser, actual models/remote TLS and full official TCK need separate measured evidence; see [acceptance prerequisites](A2A_E2E_VALIDATION.md).
