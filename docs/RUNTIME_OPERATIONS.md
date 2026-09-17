# Runtime Operations and Architecture Upgrade

> **中文**：[RUNTIME_OPERATIONS.zh-CN.md](./RUNTIME_OPERATIONS.zh-CN.md)

This guide is for operators upgrading the single-owner ToolPlane deployment. It covers the architecture-hardening migration, runtime recovery, installation credentials and ordinary Hermes attachment quotas. It does not introduce active-active execution.

## Upgrade sequence

1. Back up Postgres and managed runtime volumes. Record the deployed version and retain its restore procedure; database and volume restores are separate operations.
2. Stop the old app and confirm its child processes and external copy/import/delete operations have ended. Do not overlap old and new application instances against the same runtime domain.
3. Apply migration `20260917000000_architecture_hardening` using the existing deployment migrator or `pnpm exec prisma migrate deploy` against the explicitly confirmed target database. Generate the Prisma client and build the new application. The migration adds installation records, Token registration/expiry fields and attachment reservations; it does not delete old tokens or attachment metadata.
4. Start one application process using `pnpm start` or the production image. Wait for `/api/v1/readiness` to return HTTP 200 before admitting runtime traffic. `/api/v1/health` is a liveness check, not proof that recovery is complete.
5. Re-register client installations using their generated commands. Verify scopes, sync and device registrations before explicitly revoking old credentials or removing legacy local directories. Legacy scoped tokens remain confined to their Toolkit; callers that used them as account tokens must switch to personal tokens for account operations.

Do not roll back only the application while newer operations are active. Stop the owner first and use a tested database/volume restore or compatible roll-forward plan. Keep all production backups and credentials out of test artifacts.

## One runtime owner

`runtime/owner.ts` holds a PostgreSQL session advisory lock on a **dedicated connection**, not a pooled transaction. The database and `TOOLPLANE_RUNTIME_DOMAIN` (default `default`) determine the ownership domain. Two processes using the same domain cannot both recover or operate its runtimes. All app processes touching the same Docker resources must use the same database and domain; changing the domain is not a safe workaround for an ownership conflict.

The owner progresses through acquiring → recovering → ready, then draining → stopped. Execution routes reject with 503 and `Retry-After` until ready; signed runtime callbacks needed during recovery still validate their own credentials. Losing the ownership connection aborts managed operations, stops new work and leaves recovery blocked. Existing database admission locks and budgets remain independent of this process ownership guard.

A dirty `SystemSetting` marker remains until a confirmed clean shutdown. After a crash, DB disconnection or uncertain Docker operation, the next process refuses automatic takeover even when the advisory lock is free. Inspect logs, stop every previous owner and confirm Docker helpers/copy/delete operations have ended. Only then set `TOOLPLANE_RUNTIME_RECOVERY_ACK` to the exact UUID printed in the recovery error for **one restart**. Remove the variable after recovery. It acknowledges external reconciliation; it is not a password, a force-unlock switch or automatic high availability. Invalid markers require investigation rather than guessing another UUID.

SIGTERM/SIGINT on the production launcher stops accepting HTTP traffic, stops maintenance/coordinators/brokers, drains or aborts tracked work, and releases the dedicated lock last. The launcher has a 50-second outer shutdown bound; Compose grants 60 seconds. An uncertain or timed-out operation retains the dirty marker. Custom process managers must allow the same grace period and call the managed shutdown path. `pnpm dev` does not provide the production launcher's signal orchestration and may require explicit recovery after an abrupt stop.

## Ordinary Hermes attachments

All size settings pass through one resolver. The per-file default remains **1,000,000,000 bytes**. The absolute hard maximum is **2,000,000,000 bytes**, compatible with the current `AgentAttachment.size` Prisma Int; `TOOLPLANE_ATTACHMENT_HARD_MAX_BYTES` may lower it. A database setting takes precedence over `TOOLPLANE_MAX_ATTACHMENT_BYTES`, then the default. The hard maximum applies to every source. Invalid values fail rather than silently widen access; if the DB cannot be read, a warm process can use its last valid value (shown as cached), while a cold process refuses a new upload.

Default quota settings:

| Environment variable | Default | Scope |
|---|---:|---|
| `TOOLPLANE_ATTACHMENT_WORKSPACE_BYTES` | 20,000,000,000 | Committed ordinary Agent attachments plus pending reservations in one workspace |
| `TOOLPLANE_ATTACHMENT_AGENT_BYTES` | 5,000,000,000 | The same accounting for one Agent |
| `TOOLPLANE_ATTACHMENT_CONCURRENT_UPLOADS` | 2 | Active ordinary Agent uploads per workspace |

A short workspace-locked DB transaction reserves quota before upload. No database transaction remains open for the byte stream. Unknown Content-Length reserves the full per-file limit; actual streamed bytes may not exceed the reservation even with a false header. Success writes attachment metadata and removes the reservation atomically. Failures remain charged until physical cleanup is confirmed.

Reservations expire after 30 minutes, longer than the bounded upload. The owner retries a bounded cleanup every minute, deleting only the reservation's known final and temporary paths through the owning Hermes sandbox. Missing/unreachable runtimes and failed cleanup remain charged; investigate rather than deleting reservation rows to manufacture free quota. The runtime/workspace deletion workflow owns destruction of its volumes.

These are **ordinary Hermes Agent attachment** quotas, not whole-Docker disk quotas. Workspace/Work uploads, Hermes archive imports, snapshots and files produced directly inside a runtime have separate lifecycles; they are not silently included here. Connector files remain on the user's machine and are never reclaimed by this quota manager. Operators still need physical disk monitoring and filesystem limits. Existing stored bytes count toward admission and are not purged on upgrade; a deployment already over a new quota must deliberately raise it or remove data through its supported lifecycle.

## Installation and diagnostic changes

See [Toolkit sync](./TOOLKIT_SYNC.en.md) for stable names, per-device credentials, five-minute rotation grace, recoverable local updates and exact-ownership uninstall. Previewing an install link no longer issues a token. Installation links remain sensitive capabilities and should be rotated after exposure.

See [Logging and Audit](./OBSERVABILITY.md) for explicit Agent-content capture. Normal diagnostics do not enable it; opt-in capture is bounded, audited and retained for at most 24 hours. Public Endpoint suppression cannot be overridden.

## Verification boundaries

`tests/unit/runtime-owner.test.ts` tests the ownership state machine and lease failure paths. `tests/integration/runtime-owner-lease.test.ts` requires real independent PostgreSQL sessions and verifies lock contention and connection loss. `tests/integration/attachment-reservations.test.ts` tests quota admission and transactional settlement. `TOOLPLANE_TEST_PGLITE=1` is only for isolated embedded-database smoke runs and skips unsupported multi-session cases; never set it in CI or production. Docker lifecycle and real-client acceptance checks still require their respective runtimes and are not established merely by a parser or mock test.
