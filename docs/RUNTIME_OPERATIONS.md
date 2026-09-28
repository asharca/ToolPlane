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

## Pi version management

Open **Agents → List options → Agent management** to manage all ordinary Pi agents
in the current workspace. Check the agents you want to update, then choose
**Update selected agents to latest** or install an exact target version. Nothing
is selected by default; **Select all** enables a full-workspace batch. Empty
selections cannot update anything. The server validates every selected ID against
the authorized ordinary Pi collection before any updates; unavailable IDs reject
the request, and public endpoint runtimes and other workspaces are excluded.
The release is resolved once per batch. Unselected agents stay visible and are not
updated; the summary counts only the current batch. A failure does not stop later
selected agents, and agents already on target are skipped.
Assigned Docker sandboxes must be running with network access and the runtime owner
must be ready. Existing execution leases reject updates to busy sandboxes without
interrupting their chat, Work or A2A turns.

Updates install matching `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`
versions in separate `/workspace/.toolplane/runtime-packages/pi-<version>` directories
with lifecycle scripts disabled. Only after `pi --version` succeeds and matches
the requested version is the per-agent
`/workspace/.toolplane/runtimes/pi/agents/<agent-id>/version` pin atomically replaced.
Direct Work and terminal CLI/SDK sessions use that pin; agents without one retain
the built-in default. A2A-managed Pi tasks use the separate fixed Harness bundle
below. Workspace files, session files and previous packages are not deleted.
An earlier CLI version does not guarantee backward-compatible session data.

This changes the sandbox runtime, not ToolPlane’s host-side `pi-ai` dependency.
A registry failure does not hide a successfully read current version. Installation
or executable verification failure leaves the previous pin active; after a lost
request or uncertain outcome, check the selected version before retrying. Executable
verification is not a compatibility certification for every upstream release.

## Pi Harness managed tasks

New local Pi tasks admitted through the native A2A entrypoint use the official
Harness and SQLite Session backend. Chat, messaging and control keep their existing
task receipts; direct Work and terminal execution are not migrated by this change.
The model exposes `a2a_peers`, `a2a_call`, `a2a_status` and `a2a_cancel`, with
`agent:<id>` / `remote:<id>` targets. Explicit workspace grants, cycle/depth limits,
root-task human approvals and remote credential isolation still apply. Internal child tools are authorized by the live parent delegation; per-call receipts, revocation and lease checks remain enforced.

The managed directory is `/workspace/.toolplane/runtime-packages/pi-harness-0.87.1`.
`pi-agent-core`, `pi-session-backend-sqlite-node`, `pi-coding-agent` and `pi-ai`
are pinned to **0.87.1**; the transport uses the existing MCP **1.30.0** and A2A
**1.2.0** SDKs. Node **22.19.0 or later**, `node:sqlite`, Docker and persistent
sandbox storage are required. **Harness storage format 4 is pre-stable**: do not
automatically upgrade this bundle or assume migrations/backward compatibility.
Installation validates pins and runs a real child-process crash/recovery self-check
before execution. Failure blocks execution; there is no memory or legacy fallback.

For rollout, stop new managed Pi admissions in a maintenance window. Let existing
legacy tasks finish, or have their operator explicitly cancel them; never resend
them automatically. Back up Postgres and sandbox volumes, apply
`20260927181819_pi_harness_task_binding` using the deployment migrator or
`pnpm exec prisma migrate deploy`, run `pnpm db:generate`, and restart the app.
The migration adds `executionBackend` (existing rows stay `legacy`) and
`nativeOperationId`; it does not relabel historical work or create another task table.

Before live verification, confirm both binding columns exist in the database used
by the running service; deployed source and a configured provider do not prove the
migration was applied. Do not migrate a shared database merely to run a smoke test.
The advertised `NEXT_PUBLIC_APP_URL` must use HTTPS, except for HTTP loopback URLs.
An HTTP LAN address is rejected even when the client connects through loopback:
Card discovery returns 400, and RPC initialization cannot build its Agent Card.
SSH-only verification can use a deliberately configured loopback advertised URL;
keep the sandbox runtime origin reachable from Docker and obtain approval before
changing or restarting a shared service.

Postgres owns identity, authorization, receipts, claims, approvals and protocol
projections. Pi owns model/tool checkpoints under
`/workspace/.toolplane/runtimes/pi/agents/<agent-id>/harness/`, with the existing
A2A context ID as Session ID and lane `main`. A saved operation ID is reused after
interruption; platform snapshots are never replay instructions. Initial legacy
JSONL history is imported atomically without executing it or deleting the source.
`PI_SESSION_MISSING` / `PI_SESSION_CORRUPT` require investigation or volume restore,
not an empty replacement database—even when preparing a later task in that context.

Owner shutdown stops the driver, not the task. Recovery requires the existing
owner/dirty-marker protocol and confirmation that the previous tracked process
has stopped before a new writer opens SQLite. User cancellation, revocation and
deadline cleanup request native abort; native settlement determines the terminal
result. Unsafe or unknown tools are never blindly replayed; an uncertain side
effect remains visible. Remote sends with unknown acknowledgement are not resent,
and no remote exactly-once guarantee is made. No Redis, additional workflow service
or cross-host SQLite writer coordination is introduced.

In the authenticated conversation command UI, or a Pi message channel bound to that
conversation, send `/compact` or `/compact <custom instructions>`. For a Harness-bound
conversation this compacts its existing native Session and `main` lane, not the old
JSONL. The caller must own the conversation binding; an active context task or held
conversation/sandbox lock returns busy rather than opening another writer. Wait for
the persisted command result and usage metadata before treating compaction as complete.
Failures do not fall back to CLI compaction. Unbound legacy conversations, direct Work
and terminal paths retain their existing behavior. The communication smoke below
does not exercise `/compact`; verify it separately on an owned, idle conversation.

The settings page separates internal authorization, external connection and
authenticated inbound integration. Card URL plus optional remote token registers,
enables and authorizes one remote connection; ambiguous endpoints need the advanced
RPC override. Internal collaboration requires only selecting allowed sub-agents:
neither caller nor target needs `a2aInternalEnabled`. Authenticated chat, Work and
control retain workspace, actor, selected-edge, cycle/depth, lease and approval checks.
The existing `set-local` / `a2aInternalEnabled` opt-in is presented separately as
**External A2A & channel access**. It still gates external outbound calls, personal-token
A2A ingress and channel authorization; remote targets and channel operators retain
their separate permissions. Changing it requires manager rights and confirmation,
and selecting sub-agents never enables it. Personal Bearer tokens belong only in
operator-controlled services, never third-party Agent prompts or browser code.
Hermes published services and their isolated keys are unchanged.

Run `pnpm vitest run --no-file-parallelism tests/integration/pi-harness-recovery.test.ts tests/integration/pi-harness-host.test.ts tests/integration/pi-harness-binding.test.ts tests/integration/pi-harness-worker.test.ts tests/integration/pi-agent-communication.test.ts`
against a disposable real PostgreSQL database; never run another suite against that
database concurrently or use PGlite for lock/process-recovery evidence.
`node scripts/pi-harness-recovery-check.mjs --self-test` exercises the installed official
backend without a paid model. This does not prove live provider or Docker integration.

To check the retained direct Pi CLI separately, install its existing pinned default
bundle in a disposable Docker container and run
`TOOLPLANE_NATIVE_COMMAND_SANDBOX=<container> TOOLPLANE_NATIVE_COMMAND_KIND=pi pnpm vitest run tests/integration/native-runtime-session.test.ts`.
This exercises prompt, compact, reconnect and missing-history rejection against a local
controlled model endpoint, not a paid provider. The fixture uses Docker Desktop host DNS
on macOS/Windows and the container network gateway on Linux.

Run `node scripts/pi-agent-communication-smoke.mjs --help`, then configure exactly these
five required inputs: `TOOLPLANE_SMOKE_BASE_URL`, `TOOLPLANE_SMOKE_WORKSPACE_SLUG`,
`TOOLPLANE_SMOKE_AGENT_A_ID`, `TOOLPLANE_SMOKE_AGENT_B_ID`, and
`TOOLPLANE_SMOKE_PERSONAL_TOKEN`. The base URL is an origin; use HTTPS except for
loopback HTTP. Keep the token in the local environment, never in command arguments,
prompts or third-party services. The runner sends it only to the selected workspace's
public Agent MCP and the two local A2A endpoints, not the session-only console BFF;
redirects are rejected. Console links are for the operator's separate signed-in browser.

Use an isolated test app/runtime-owner and two configured Pi Agents whose name or slug
starts `pi-smoke-disposable-`, each with one distinct running Docker sandbox and explicit
A → B collaboration permission. Enable the required tools; root tasks retain human approvals and B's internal child calls use parent-delegated authorization.
With a live provider, Docker, PostgreSQL, an interactive terminal and
`TOOLPLANE_SMOKE_ALLOW_PROCESS_KILL=1`, run `node scripts/pi-agent-communication-smoke.mjs`.
Console links are for root-task approvals: approve A's delegation call and the separate
cancellation/restart-counter tasks; B's delegated counter needs no human approval. **Deny** the separate denied-write task. Type the exact confirmations
requested by the runner only after the actual decision. It never grants approval.
Missing prerequisites, approvals or an observed crash boundary are failures, not skips.
Without a configured live provider this paid-model smoke is unavailable; neither this
documentation nor the backend self-test supplies evidence that it passed.

The runner requires committed tool settlement with counter **1** and an unfinished
`assistant.effect_pending` boundary before SIGKILL. It checks the exact tracked wrapper
arguments, PID-file ownership, wrapper/child start times and ancestry, host/config paths,
Agent directory, task, context and operation immediately before targeting that child.
Native inspection uses read-only SQLite transactions, never another SessionRepo writer.
Recovery must finish the same child operation with count **1**, and its owned result
must appear in the parent's result. Cancellation additionally requires native `aborted`,
no driver and a stopped counter; denial requires native refusal/`aborted` and zero writes.

For platform restart the runner creates a separate counted task. At
`OPERATOR_STOP_REQUIRED`, stop **only your isolated test app/runtime-owner**, leaving
Docker and this runner running. Do not restart until instructed: it must observe API
downtime, the tracked driver gone and the original native operation still unfinished.
Confirm `STOPPED <taskId>`, then start the same app normally at `OPERATOR_START_REQUIRED`;
never force owner takeover or resubmit the prompt. The runner polls the existing task
and requires the same task/context/operation, native completion and count **1**, then
requests `RESTARTED <taskId>` and the actual approval confirmation. Canceled/denied tasks
must remain natively aborted after this restart. Each wait is bounded to five minutes;
if the model completes before the stop is observed, the scenario fails rather than
claiming restart evidence. The runner never stops a shared server or restarts containers.

Fixtures/configuration are retained; failure cleanup requests cancellation only for
receipts created in this run, and reports unconfirmed cleanup for operator action.
Remote HTTPS peers, other-account authorization and `/compact` remain separate live
checks; no remote exactly-once guarantee is made.
`node scripts/a2a-e2e-preflight.mjs` reports prerequisites, not E2E acceptance.


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
