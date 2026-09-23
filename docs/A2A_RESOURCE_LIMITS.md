# A2A admission and artifact resource limits

> [中文](A2A_RESOURCE_LIMITS.zh-CN.md)

For deployers and maintainers. These are ToolPlane resource policies, not new A2A fields
or standardized billing. Native A2A, the MCP facade and console share one task core.
Changing entry points does not create a separate native task or execution allowance.

## Payload storage

A Task snapshot remains capped at 512 KiB. `A2ATask.storageBytes` accounts for its snapshot,
request, verified identity metadata, event JSON and message-deduplication records. JSON
uses PostgreSQL UTF-8 serialized byte lengths; each deduplication record adds 512 units.
This is a payload charge, not physical disk usage including indexes, row overhead, WAL
or backups.

Active and input/auth-waiting tasks reserve at least 4 MiB; terminal tasks charge their
retained payload. Normal writes leave 16 KiB of headroom for failure/cancellation and
limit the journal sequence to 128. Failure settlement can still commit the necessary
terminal event. Oversized success output rolls back the whole result transaction,
including artifact publication, rather than leaving a partial state update.

Native and compatibility Responses requests share workspace admission locks and quota
checks. The workspace storage ceiling is 1,000,000,000 units. Published tasks also check
existing Endpoint/client `maxStoredCharacters` settings. Compatibility records keep their
character accounting; native tasks conservatively debit payload bytes from that same
ceiling. These are conservative compatibility units, not exact usable characters, disk
bytes or billing. A waiting parent releases its executor slot, not its retained-space
reservation.

## Output reservation before execution

Before claiming a native execution lease, reserve its output ceiling transactionally
for the workspace and applicable Endpoint/client. Published text rounds reserve 65,536
units. Local rounds also reserve fifteen 32 KiB explicit artifacts, totaling 557,056
units. Duplicate message or lease claims do not create another execution reservation.

The workspace daily ceiling is 500,000,000 units. Published tasks also honor existing
Endpoint/client `dailyOutputCharacterLimit` settings. Rounds that can cross UTC midnight
reserve both dates. Reservations are not refunded after cancellation, failure or empty
output: external model/tool consumption can be uncertain. These are not actual token
counts, emitted output totals or monetary charges.

Compatibility Responses admission reads native reservations; native admission includes
compatibility output/storage charges. Locks are acquired workspace first, then the
Endpoint/task. This still requires a single runtime owner and does not imply distributed
execution safety or exactly-once external side effects.

## Errors and migration

Admission exhaustion is the implementation-defined JSON-RPC server error `-32099`, with
HTTP 429 and a bounded retry hint at the HTTP entry. It is not a new standard A2A semantic
error. The MCP adapter reports `isError: true`. A previously accepted task that cannot
reserve quota at claim time is failed without starting its executor. Payload exhaustion
after execution cannot undo effects already performed outside the platform.

Apply this additive migration after both native A2A migrations, then regenerate Prisma:

```text
20260923050000_a2a_storage_accounting
```

It adds/backfills payload accounting and a nonnegative constraint. It does not replay,
delete or rewrite old task identities, requests, messages or artifacts. Existing large
tasks are accounted for rather than silently deleted by the new ceiling.

Tests cover persistence, rollback, repeated claims, UTC rollover, cross-protocol admission
and populated migration preservation. PGlite explicitly skips actual PostgreSQL concurrent
claims; real database and runtime acceptance are required before production rollout.
