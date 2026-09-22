# Native A2A task service

[中文](A2A_NATIVE.zh-CN.md)

This service implements the **A2A 1.0 JSON-RPC binding**, with the official
`@a2a-js/sdk` pinned to **1.2.0**. SDK and protocol versions are not interchangeable.
See the [normative specification](https://a2a-protocol.org/latest/specification/).
No v0.3 compatibility layer, old method names or custom wire task types are enabled.

## Architecture

Authenticated A2A request → official JSON-RPC transport → NativeA2AHandler →
A2AContext / A2ATask / A2ARequest / A2AEvent → persistent worker → TaskExecutor.

The lifecycle does not invoke prepareAgentResponse, executePreparedAgentResponse,
private Conversations or the old collaboration worker. Contexts can hold several
Tasks and pin identity, service revision and isolated runtime sessions. Publication,
credential verification, clean runtime materialization and concurrency admission
are reused infrastructure, not a legacy execution facade. The first wired public
runtime adapter is isolated Hermes; other runtimes are not automatically published.

## Explicit publication and credentials

Publish an isolated Agent Endpoint in the existing console first. A2A is disabled
by default. A workspace owner/administrator uses an **account-level Bearer token**:

```bash
curl "$TOOLPLANE_URL/api/v1/workspaces/$WORKSPACE/agents/$AGENT_ID/a2a" \
  -H "Authorization: Bearer $ACCOUNT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"clientName":"A2A integration"}'
```

The token in this response is returned once. Store it server-side, never in prompts,
logs, browser bundles or source control. Supplying clientName creates a new client;
this administrative operation is **not idempotent**. After an ambiguous failure,
inspect the Endpoint client list rather than blindly retrying. Omit clientName when
only toggling the flag. Disable using `{"enabled":false}`.

Service keys, runtime tokens, Toolkit tokens and cookies cannot approve publication.
New clients receive only a2a:send, a2a:read and a2a:cancel; cancellation also needs read.
Existing responses scopes do not implicitly grant A2A access. Server-to-server only:
Origin headers are rejected. This release does not implement OAuth discovery/exchange.

## Discovery and methods

Both routes require an authorized Endpoint credential:

```text
GET  /api/v1/agent-endpoints/{endpointId}/a2a/.well-known/agent-card.json
POST /api/v1/agent-endpoints/{endpointId}/a2a
```

Use the returned Card URL directly. The root well-known path is not redefined as
an Agent array. URLs derive from NEXT_PUBLIC_APP_URL, not an untrusted Host header.
Non-loopback deployment requires HTTPS. Cards expose only public metadata and capabilities.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "review-001",
      "role": "ROLE_USER",
      "parts": [{"text": "Review this patch."}]
    },
    "configuration": {"returnImmediately": true, "historyLength": 0}
  }
}
```

Send with Content-Type: application/json, Authorization: Bearer and A2A-Version: 1.0.
Responses use result.task, official enum strings and official Part oneofs. Patch
versions do not affect major/minor negotiation. Missing version means v0.3 and is rejected.

Implemented: SendMessage, SendStreamingMessage, GetTask, ListTasks, CancelTask,
SubscribeToTask. Blocking sends wait until terminal/interrupted; immediate sends
return durable acceptance. Lists use signed identity/filter-bound keyset cursors,
status timestamp descending, explicit empty nextPageToken on the final page and
includeArtifacts field semantics. historyLength=0 never returns history.

Subscriptions start with an authoritative Task snapshot, then persisted status and
artifact events. Terminal subscriptions are rejected. No arbitrary Last-Event-ID
replay is promised. Streaming currently means task events and a final artifact,
not model token deltas. Slow observers use bounded backpressure and connection limits.

## Lifecycle, limits and rollout

A context has at most one active task. Continue INPUT_REQUIRED with taskId and a
new messageId; use a new task after terminal states. AUTH_REQUIRED is not approved
by model text. The Hermes adapter does not guess interruption/approval from prose.

Admission, deduplication and events are transactional. HTTP disconnect does not
cancel accepted execution. Cancellation is only confirmed after the executor stops;
side effects are not rolled back. Worker leases guard finalization. Restart marks
uncertain WORKING tasks failed, rather than replaying possible side effects.
Credentials, scopes and publication state are rechecked during execution/observation.
Request metadata never establishes identity. Public diagnostic payloads are suppressed.

Bounded limits include 256 KiB request bodies, 20,000 input characters, 65,536 output
characters, 512 KiB task snapshots, 32 messages/task, 128 tasks/context,
100 contexts/client, 1,000 retained tasks/client, four worker executions,
eight observers/identity and 64 globally. Deadline is at most 840 seconds, bounded
by Endpoint configuration, credential expiry and context retention. Continuation
cannot extend it. Terminal contexts are cleaned in bounded batches after retention
(up to 30 days). These limits are not exact token/currency budgets; aggregate output
and storage quota integration needs separate acceptance before production rollout.

Only JSONRPC, streaming and text/plain are advertised. REST, gRPC, push callbacks,
extended Cards, binary/structured input, remote registry, automatic parent continuation
and internal Agent delegation migration are **not** part of this increment.
Unsupported capabilities return standard errors. Input file URLs are never fetched.

Apply migration 20260922000000_a2a_native_tasks and regenerate Prisma Client using the
single-owner upgrade process. Existing conversations, runtimes and legacy tasks are
not automatically migrated, replayed or publicly exposed.

Tests: `pnpm vitest run tests/unit/a2a-*.test.ts tests/integration/a2a-native.test.ts`.
The official unmodified client/transport is used for wire interoperability. Integration
uses isolated DB fixtures and a replacement executor, not production model credentials.
TOOLPLANE_TEST_PGLITE=1 selects local embedded testing and intentionally skips the real
PostgreSQL concurrency test; CI must not set it. This is not a claim of live CLI/model
end-to-end acceptance or official TCK certification.
