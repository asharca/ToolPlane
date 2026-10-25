# Runtime Operations and Architecture Upgrade

> **中文**：[RUNTIME_OPERATIONS.zh-CN.md](./RUNTIME_OPERATIONS.zh-CN.md)

This guide is for operators upgrading the single-owner ToolPlane deployment. It covers runtime recovery, reviewed Pi capabilities, scoped client registrations and read-only historical storage. It does not introduce active-active execution or authorize a production migration.

## Upgrade sequence

1. Back up Postgres and managed runtime volumes. Record the deployed version and retain its restore procedure; database and volume restores are separate operations.
2. Stop the old app and confirm its child processes and external copy/import/delete operations have ended. Do not overlap old and new application instances against the same runtime domain.
3. Review the repository migrations for the intended release and apply them only to the explicitly confirmed target database using the existing deployment migrator. Generate the matching Prisma client and build the application. Retained messages, files and audit/provenance records are not disposable migration data.
4. Start one application process using `pnpm start` or the production image. Wait for `/api/v1/readiness` to return HTTP 200 before admitting runtime traffic. `/api/v1/health` is a liveness check, not proof that recovery is complete.
5. Drain all active legacy tasks before controlled cutover. Convertible Toolkit content is frozen into private packages; old client credentials are revoked and clients must register again for explicitly selected releases and scopes. Do not automatically republish public versions or restore old runtime execution. Historical messages and files remain read-only. See [Toolkit cutover](./TOOLKIT_SYNC.en.md).

Do not roll back only the application while newer operations are active. Stop the owner first and use a tested database/volume restore or compatible roll-forward plan. Keep all production backups and credentials out of test artifacts.

Online release updates require the managed production launcher. After download and validation, the updater drains the current runtime owner **before replacing any runtime files**, so shutdown imports still resolve against the old release. Missing shutdown support or an unclean drain fails the update without replacing files. Successful replacement requests SIGTERM rather than calling `process.exit()`, and the launcher completes shutdown. A failed drain leaves runtime work blocked for operator recovery; it is never automatically acknowledged.

Update completion requires the target version, a replacement process identity, and `runtimeReady=true`. The local update-status endpoint returns HTTP 503 with `Retry-After: 2` when the new process is idle but runtime recovery is not ready, preventing older clients from treating a version change as success. Download, apply and failure statuses remain available so progress and errors are not hidden. Refreshing the page or deleting ownership markers is not a recovery procedure.

Docker/Coolify health checks must use `/api/v1/readiness`, not `/api/v1/health`, and allow a 60-second stop grace period (`docker restart --timeout 60` for manual restarts). The release archive does not change an existing container's health-check or stop-timeout configuration: update the deployment definition and apply it during a controlled redeploy. Do not recreate an in-place-updated container from its old image without first preserving the running release.

The Docker build and runtime stages share `python-runtime-base` so Prisma assembly detects the same OpenSSL ABI used at startup. Keep these system libraries aligned; otherwise the image can bundle an OpenSSL 1.1 engine while production needs OpenSSL 3 and attempts a network download. Verify the final image's `prisma migrate deploy` against an isolated backup database without outbound network access before rollout.

The managed launcher loads `abort-signal.cjs` before Next. It briefly adds/removes an abort listener on each native `AbortSignal.any()` result to start weak source following: Node 24.21 otherwise retains nested timeout composites after expiry, eventually failing MCP/channel requests with `Set maximum size exceeded`. Keep this file beside the embedded `server.cjs` when assembling a release. Verify a future Node upgrade with `pnpm vitest run tests/unit/abort-signal.test.ts` before removing the workaround. An already exhausted process needs a controlled restart; restarting only an MCP bridge does not clear the app's signal registry.

## Shared MCP credential cutover

Shared MCP deployment environment values are encrypted with `AUTH_SECRET` in a
workspace-bound `credentialEnvelope`. Stored `env` entries contain empty strings;
public serializers and deployment lists expose only environment names and masked
empty/`configured` state. Neither plaintext nor the ciphertext envelope belongs in
API responses or exports. Live runtime access explicitly decrypts credentials only
after workspace ownership checks. Legacy nonempty plaintext values fail closed at
runtime until explicitly migrated. Keep the same `AUTH_SECRET` when restoring the
database; changing it does not rotate credentials.

Back up the database, stop the application/runtime owner, and independently confirm
all MCP children/containers are stopped before this controlled cutover. The script
does not stop services or reconcile external processes. It refuses any deployment
in the selected workspace unless its persisted status is `stopped`, `error`, or
`setup_required`; a stale idle status is not proof that a process has exited.
Confirm `DATABASE_URL` and `AUTH_SECRET` refer to the intended environment, then run
once per workspace using its database ID (not its slug):

```bash
# Read-only dry-run is the default; output contains counts only.
pnpm exec node --conditions=react-server --import tsx scripts/migrate-mcp-credentials.ts --workspace WORKSPACE_ID
# Explicitly apply only after reviewing the dry-run and confirming shutdown.
pnpm exec node --conditions=react-server --import tsx scripts/migrate-mcp-credentials.ts --workspace WORKSPACE_ID --apply
```

Each invocation runs in one serializable transaction. Updates compare the original
workspace, status, timestamp and configuration; concurrent changes or invalid/mixed
plaintext/encrypted configurations abort the entire batch. Already migrated rows
are validated and left unchanged, so reruns are idempotent. No secret values,
ciphertext, hashes or database errors are printed. Investigate failures privately;
do not paste database configs into logs or support artifacts. Restart one owner
only after every required workspace has migrated and readiness succeeds.

Rotate or revoke an MCP value through its authenticated deployment environment
settings, not by editing envelope metadata. Rotation/revocation stops the old
process before storing the newly sealed values; do not bypass a failed stop.
New runtime connections resolve current workspace-owned credentials through the
explicit private resolver; metadata is never a credential source. This migration
only converts shared MCP deployment environment values, not catalog recipes or
Agent-owned credential references. Focused regression entrypoint (isolated test DB):
`pnpm vitest run tests/integration/mcp-environment-credentials.test.ts`.

Docker-backed MCPs receive configured environment values through a runtime-only
stdin bootstrap, not Docker environment flags, image/build layers or secret files.
The bootstrap consumes one private line, then execs the original image entrypoint
and command with the remaining stdin reserved for MCP JSON-RPC. Images receiving
environment values (including package cache settings) must provide POSIX `/bin/sh`
with built-in `read`, `printf`, `eval` and `export`; shell-less images fail closed.
Docker recipes with no environment projection retain their native entrypoint and
do not require the bootstrap. Do not add `--env` or `--env-file` to bypass this rule.
Runtime diagnostics redact values from both the configured environment and the
container-only environment projection, regardless of whether their keys look
secret-related. A value that appears only in the container projection must not
be exposed by captured stderr or runtime log responses.

## One runtime owner

`runtime/owner.ts` holds a PostgreSQL session advisory lock on a **dedicated connection**, not a pooled transaction. The database and `TOOLPLANE_RUNTIME_DOMAIN` (default `default`) determine the ownership domain. Two processes using the same domain cannot both recover or operate its runtimes. All app processes touching the same Docker resources must use the same database and domain; changing the domain is not a safe workaround for an ownership conflict.

The owner progresses through acquiring → recovering → ready, then draining → stopped. Execution routes reject with 503 and `Retry-After` until ready; signed runtime callbacks needed during recovery still validate their own credentials. Losing the ownership connection aborts managed operations, stops new work and leaves recovery blocked. Existing database admission locks and budgets remain independent of this process ownership guard.

A dirty `SystemSetting` marker remains until a confirmed clean shutdown. After a crash, DB disconnection or uncertain Docker operation, the next process refuses automatic takeover even when the advisory lock is free. Inspect logs, stop every previous owner and confirm Docker helpers/copy/delete operations have ended. Only then set `TOOLPLANE_RUNTIME_RECOVERY_ACK` to the exact UUID printed in the recovery error for **one restart**. Remove the variable after recovery. It acknowledges external reconciliation; it is not a password, a force-unlock switch or automatic high availability. Invalid markers require investigation rather than guessing another UUID.

SIGTERM/SIGINT on the production launcher stops accepting HTTP traffic, stops maintenance/coordinators/brokers, drains or aborts tracked work, and releases the dedicated lock last. The launcher has a 50-second outer shutdown bound; Compose grants 60 seconds. An uncertain or timed-out operation retains the dirty marker. Custom process managers must allow the same grace period and call the managed shutdown path. `pnpm dev` does not provide the production launcher's signal orchestration and may require explicit recovery after an abrupt stop.

## Frozen Pi extension packages

`pi-package` releases are immutable Pi resources and optional executable extensions.
All new executable Agents use the fixed Pi SDK path; other runtime records retain
read-only history/files, not execution compatibility. Create fresh Pi objects and
review/authorize capabilities explicitly. Apply only the reviewed release migrations
under the controlled upgrade procedure above; do not migrate a live shared runtime
merely to enable a package.

Build the trusted capture image explicitly; publication never builds it implicitly:

```bash
docker build --target pi-package-capture -t toolplane-pi-package-capture:0.87.1 .
```

Capture requires the ready runtime owner and allows one operation at a time
(`capture_busy`). The non-root container has no external network or mounted host
files. Its bounded TLS CONNECT broker rejects private, mixed-DNS and redirected
private destinations. Public or explicitly credentialed npm/Git production dependencies are frozen without
executing factories, lifecycle scripts, hooks or pnpmfile. Packages requiring a
build must supply runnable artifacts; files over 16 MiB are rejected, not skipped.
Uploaded Pi ZIPs use the same isolated capture, dependency freezing, inventory and
review pipeline for native extensions, Skills, prompts and themes. Submit
`sourceType=zip` with an `archive` File and explicitly checked
`confirmExecutableCode=on`; the server records the upload SHA-256 in immutable
source provenance. ZIP limits are 32 MiB compressed, 64 MiB expanded, 16 MiB per
file, 20,000 entries and a 1,000:1 per-file compression ratio. Only stored/deflated
regular files and directories are accepted; traversal, links, special files,
case/Unicode collisions, malformed headers and CRC mismatches fail capture.
Archives may contain a package root directly or one enclosing directory.
Rebuild the capture image after updating these trusted scripts.
Npm/Git/ZIP publication first calls `previewPiPackageSourceAction` with the same
source fields (ZIP preview also requires explicit code consent). This is a real
isolated capture, not URL-derived labels: it returns typed resource/file metadata,
platform/runtime, MCP requirements, the resolved source pin and `sourceDigest`,
never file contents or credentials. Pass that digest to
`publishPiPackageReleaseAction`; publication captures again and compares the entire
validated snapshot, including dependencies. Missing previews fail with
`source_preview_required`; changed uploads, moved refs or dependency drift fail
with `source_changed`, requiring a fresh preview. Assembly also requires its
reviewed frozen digest. Catalog/service callers have no digest bypass. An explicit
`sourceType=release` instead selects an exact owned immutable release; it reuses
validated frozen bytes without fetching upstream. Preview creates no market records
and installs no code; it requires the same owner/admin and runtime ownership as capture.

Approval revalidates paths, links, decoded secret scans, file hashes and the whole
release checksum. Installation creates only a ready `MarketInstall`; it does not
execute code. Workspace updates change both install release pointers, while each
Agent retains its explicitly enabled release. Apply updates explicitly, after
active tasks/Work/leases finish. Uninstall atomically publishes each affected active
Agent's applied revision with only that package removed, then removes draft bindings.
It never applies unrelated draft edits. Revision CAS/validation failure rolls back
the whole uninstall; repeated concurrent uninstalls do not duplicate revision changes.
New sessions use the narrowed default; existing session revisions, referenced
artifacts and shared MCP deployments remain intact.
This removal-only publication does not require unrelated already-revoked grants
to become valid again; their live restrictions remain enforced at execution.
Public details expose a small summary and the original checksum, never base64 or
dependency files. Dangerous-release revocation blocks new execution immediately,
including retained pins. Ordinary uninstall or listing withdrawal does not revoke
an exact approved artifact already retained by the same Agent revision; current
MCP, provider and credential grants are still revalidated. Package MCP tools must
remain inside both the immutable revision grant and the live Agent connection's
explicit allowlist; removing the connection or narrowing away a required tool
denies restoration rather than recovering permission from package/session files.
Use the authenticated owner/admin endpoint
`POST /api/v1/pi-packages/releases/{releaseId}/revoke` with
`{"workspace":"<workspace-slug>","reason":"<reviewed reason>"}` for a dangerous
release, not ordinary unpublish/uninstall. It records explicit `revoked` status,
revokes dependent client registrations and retains readable release/revision history.
Approval accepts arbitrary Node/file/network side effects inside the Agent sandbox;
tool approval is not an arbitrary-code isolation boundary.

Create a fresh **Pi Agent**, select installed packages in its draft, then follow
**Save draft → Prepare → Review → Apply**. There is no alternative Pi SDK runtime
selector or old Harness execution fallback. Draft edits do not activate packages
or change existing sessions. The SDK is pinned to 0.87.1 on Linux/Node 24; captured
package architecture must match the Docker daemon. TP-assembled packages declare
portable `any/any` resources; this does not waive the SDK version/Node requirement.
The sandbox installer uses `pnpm add --save-prod` for trusted runtime packages
(compatible with pnpm 10 and 12); reviewed extension dependencies are never installed at turn time.

SDK sessions use official JSONL files, not Harness checkpoints. Conversations,
A2A contexts and Work pin an immutable Agent revision and exact package artifacts;
workspace updates do not change those pins. Publishing or rolling back creates a
new default revision and never rewrites an existing session.
The guided installer creates workspace resources and, with explicit Review + Apply
confirmation, publishes the selected Agent's current applied revision with only the
reviewed package and MCP grants merged in. Unrelated draft edits remain unapplied;
existing session pins stay unchanged. A target without an applied revision must
first prepare, review and apply its configuration from the Agent page; setup refuses
before installing resources. Revision CAS failure retains the previous default.
An unshared MCP created by the same authenticated setup operation may be configured
again after a partial failure. Existing/shared connections are never silently
reconfigured: use real connection settings with impacted-object review, or create
a new connection. Executable-code and MCP privilege confirmations remain required.
Failed later steps report actual completed deployment/install IDs and partial
results, not fictitious rollback or successful enablement. Version updates may
explicitly supply reviewed target `mcpBindings` atomically; missing new tool grants
fail with `pi_package_mcp_binding_required`. Live revocation cannot be undone by a pin.
Before switching, authenticated account clients can GET
`/api/v1/workspaces/{slug}/market/installs/{installId}/diff?targetReleaseId={id}&page=1&pageSize=50`.
Only approved same-listing Pi/Skill/MCP releases can be compared; both artifact checksums
and current workspace access are revalidated. The response contains paginated changed
paths (maximum 100 per page), permission/tool and environment names, transport/runtime
compatibility and a configuration-change flag—never file bytes, recipe args or credentials.
Work pins at admission, before its independent volume is allocated. Uninstall removes
defaults but retains referenced artifacts and shared MCP deployments. Release approval
and live workspace/Agent/MCP access are revalidated; revoked grants are not snapshotted.
`PI_SDK_PACKAGE_SET_CHANGED` remains a fail-closed integrity check for mismatched state.
A missing persisted file or lost unpersisted host fails with `PI_SDK_SESSION_MISSING`;
history is not replayed to fake recovery. Interrupted native tasks fail rather than replay.
Legacy or unresolved revision/package state fails with `AGENT_REVISION_UNRESOLVED`.
Do not infer a revision from current defaults, overwrite checksums or replay old
messages to manufacture recovery. Retain the historical state read-only and create
a fresh authorized Pi object/session when a valid immutable pin is unavailable.
Modified snapshot bytes/links fail with `PI_PACKAGE_CHECKSUM_MISMATCH`, and selected
extension load failures fail with `PI_EXTENSION_LOAD_FAILED`.

Commands preserve SDK invocation case and collision suffixes such as `:1`. Chat and
channel commands use the same native task authorization and fresh lease readiness
as prompts; Work uses its coordinator. Headless extensions have no terminal UI;
command-only results are explicit completion receipts, not model answers.
### Catalogs, assembly, and client registrations

**Market → Pi extensions** defaults to the complete, searchable and paginated
[official Pi catalog](https://pi.dev/packages). Members can install a selected exact
version without human review. The server verifies live directory membership and
public npm version/integrity, then captures and validates the immutable artifact.
The interactive official installer requires `confirmExecutableCode=on`; explanatory warning text alone does not authorize executable package intake.
The release records `reviewPolicy: 'official-directory'`, with no human reviewer;
this is not a security endorsement or proof of Web compatibility. Installation
does not execute code or change Agent pins. Public custom sources and assembled
packages retain human review. For private npm/Git/ZIP or assembled packages, an
owner/admin may explicitly authorize executable code (`confirmExecutableCode=on`)
for workspace-only use. The release records `reviewPolicy: 'workspace-owner-trust'`
and the authorizer/time, not a human public reviewer or official-directory approval.
Private releases remain unavailable to public discovery and other workspaces.
A listing with workspace-trusted history cannot be flipped public: submit a new
public listing from its frozen artifact with `sourceType=release` and
`targetReleaseId=<private-release-id>` using the same publication action. The
server verifies workspace ownership, revalidates the snapshot and queues human
review without re-fetching upstream bytes. The new public artifact removes private
source origins and workspace IDs; private history is never made public. Owners/admins
manage HTTPS catalog, npm registry or Git sources under **Resources → Sources**
(`/app/{workspace}/market/sources`).
Credentials are encrypted and write-only; only the configured authority/path receives them.
Catalog credentials never propagate to discovered package origins. Private repositories on
public HTTPS hosts are supported; LAN/loopback/link-local/mixed-DNS destinations and redirects
remain blocked. Capture credentials enter the trusted container over stdin, not argv or Docker env.

A custom catalog responds to `GET <configured-url>?query=<text>&page=<1-based>` with
`{schemaVersion:1,entries:[{name,source,description?,version?}],hasMore:boolean}` (at most 50
entries and 2 MiB). `source` is a supported npm/Git identifier; no package code runs during discovery.

**Resources → Compose** (`/app/{workspace}/market/compose`) freezes selected installed
Skill files and generates a real Pi MCP extension for explicitly selected tools.
Packages default to private; public publication is explicit and separately reviewed.
MCP requirements contain logical keys/tool names, not credentials or publisher
deployment IDs. Other workspaces bind their own connections; no selected resource
grants execution authority until the target Agent draft is reviewed and Applied.
Skill/Prompt/Theme-only packages need no dummy extension. Review the frozen assembly
before committing; changed input requires a fresh preview. Imports and tracked-source
recapture use **Resources → Import** and the same preview/commit contract, not an
automatic capture-to-publication shortcut. Toolkit history is read-only; controlled
conversion is a separate drained, authorized dry-run/apply operation, not an editor
or execution product. Existing published versions are never automatically republished.

Approved artifact downloads are deterministic npm-compatible tarballs. Registry publication requires
owner/admin authorization, a configured npm source, and explicit confirmation; it never overwrites an
existing version. It does not automatically register a package in the official catalog.

**Resources → Registrations** uses the existing Pi package client mechanism for
fixed package releases or standalone Skill/MCP release selections; a registration
is not a separately publishable combination. Pi receives native package resources;
Claude Code, Codex, OpenCode and Hermes receive only supported Skills/MCP, never Pi
extensions, prompts or themes. Download the installer and one-time private config,
protect it with `chmod 600`, then run `node pi-package-install.mjs install --config
<private-config.json>`; `update` and `uninstall` use the same config. Installation is
user-global, not project-scoped. MCP requires connectivity to this instance.

Each registration has an independent hashed revocable token and fixed exact-release
selection. Ordinary account/Toolkit tokens are not accepted by device endpoints.
Account updates require owner scope, integer `expectedConfigVersion` and explicit
review of expanded privileges. Reviewed configuration changes increment the version;
ordinary authentication only updates `lastUsedAt` and cannot invalidate an open review.
Membership, release status, deployment scope and exposed tools are checked on requests.
Added tools never expand grants automatically. Local updates refuse modified
managed files and symlink escapes. Uninstall acknowledges self-revocation before deleting unchanged
managed files; web revocation alone does not delete local files. Active device registrations block
workspace uninstall. Never log, commit, or screenshot private configuration contents.

The runtime-owner maintenance tick checks at most eight due tracked packages every five minutes;
each package is checked no more often than every six hours. Manual checks are available. Tags/ranges
and Git branches produce notices; exact versions/commits stay pinned. Checks never capture, install,
publish, or change an Agent/device. Same-version integrity changes are suspicious, not ordinary updates.
Capture and approve a new release, then update the workspace and individual Agent/device explicitly;
expanded device privileges require confirmation. TP compositions are republished explicitly from
selected workspace resources, not silently regenerated.

## Immutable Pi SDK revisions

All executable Agents use **Pi SDK 0.87.1**. Chat, channels, control, Work and local
A2A use the same pinned native SDK path; there is no direct Pi CLI, host Agent loop,
Hermes or Harness execution fallback. Other Pi versions are rejected rather than
installed into a live Agent or substituted for the selected version. Native extension
preflight requires the fixed isolated image `toolplane-pi-package-capture:0.87.1`.
The preflight container mounts only staged public helper scripts read-only and uses
a separate writable `/tmp`; it never copies scripts into its read-only root filesystem.
Loader namespace collisions retain the typed `PI_CAPABILITY_CONFLICT` classification.
`PI_EXTENSION_LOAD_FAILED` retains a bounded stage-specific diagnostic cause; inspect it
before treating the failure as an extension factory problem. Native npm snapshots must
match the execution platform and architecture; do not relabel or transplant their bytes.
Control MCP creates native `pi-sdk` drafts only. Creation is not execution authority:
explicitly configure, authorize, and publish the immutable revision before running it.

Runtime changes follow **Save draft → Prepare → review → Apply**:

1. Save configuration changes as a draft. Saving does not change the published
   default or any existing session.
2. Prepare the revision. Dependency capture/build and native capability preflight
   happen outside the publication transaction. The prepared config freezes the
   digest-pinned environment image, Pi version, network/resource limits, optional
   checksum-verified initial snapshot, credential references, model and instructions,
   Skill/package content and MCP/A2A grants. Secrets are not copied into the config.
3. Review that exact prepared config, including capability and permission changes.
   Apply submits it with the expected current revision ID. Publication revalidates
   permissions, artifacts, source digests and native preflight, then atomically
   compares and changes the default. A stale expected revision or failed validation
   leaves the previous published default unchanged; prepare and review again.
4. Rollback publishes a **new** revision from a same-Agent historical revision using
   `rollbackAgentRevision(...)` and the expected current revision ID. It revalidates
   retained artifacts and current authority; it does not rewrite history, restore a
   revoked permission, or mutate an existing session. Retained historical package
   pins can survive uninstall/withdrawal, but dangerous release, MCP and credential
   revocations still block execution.

Uninstall removes only that package from a new default revision using CAS; it preserves
the other applied fields exactly and does not require unrelated revoked scopes to become
publishable again. This removal-only operation grants or executes nothing and never
restores revoked permissions; historical sessions still enforce their live intersections.

Do not edit runtime version files, install a newer upstream release in an active
sandbox, or update a mutable template to migrate sessions. New Conversation, Work
and local A2A sessions persist their selected `agentRevisionId`. Existing sessions
continue with that revision, intersected with live provider, credential, package,
MCP and directional collaboration permissions. A missing, mismatched or unresolved
pin fails closed; current Agent configuration is never a recovery fallback.

### Reviewed individual Skills and MCP connections

Single-resource Enable is a review-and-publication flow, not a draft attachment. Select
a published native Agent, then call `previewAgentResourceAction` to review its full Skill
artifact or perform a controlled MCP `tools/list` handshake. Unpublished targets fail
with `revisionPreparationRequired` before probes, grants or installations. Inspection
does not invoke tools, mount Agent work volumes, or require a shared stdio process to run.

The preview returns a user/workspace/Agent/resource/current-revision-scoped signed
`reviewReceipt`, `sourceChecksum`, and 15-minute `expiresAt`. This proof is not authority
by itself. MCP Apply requires an explicit `allowedToolNames` selection; omitted tools
never mean all tools. `enableAgentResourceAction` checks the receipt and
`expectedRevisionId`, revalidates source/definition/files/discovery and live authority,
then publishes only that reviewed addition over the applied configuration using native
preflight. Unrelated drafts and existing conversation pins remain untouched. Changed
sources or stale/expired reviews require a new preview; failed publication rolls back
the grant and default revision together. Success includes the actual new `revisionId`.

## Native sessions and historical runtime boundaries

Before SDK session initialization or model requests, the native host checks its approval
broker's readiness. The helper accepts only `/api/v1/agent-runtime/sessions/approvals`
for ordinary sessions or `/api/v1/agent-runtime/a2a/<task-id>/approvals` for delegated
tasks. Both retain HTTP(S)-only, no embedded credentials/query/fragment, no redirect,
bounded response and runtime-token requirements. A readiness refusal prevents model
execution; it is not a reason to bypass approval or replay the turn.

Each session lazily receives its own persistent sandbox from its pinned environment,
not the Agent's current template. Native SDK state is scoped under
`/workspace/.toolplane/runtimes/pi-sdk/agents/<agent-id>/`; local A2A state uses its
persisted context ID. The database owns identity, revision/sandbox bindings, task
receipts and authorization; the native session file owns the SDK conversation state.
Retained contexts must reopen their existing session. Missing state requires
investigation or volume restore, never fabricated history or an empty replacement.

Same-session serialization, native/session-MCP leases and existing Agent/platform
concurrency limits remain enforced. Stop and cancellation stop the bound processes
and session MCP sidecars without deleting work volumes. Generic runtime ownership,
dirty-marker and recovery rules elsewhere in this guide still apply. Unknown tool
side effects and remote acknowledgements remain unknown; do not replay them to
manufacture completion or claim remote exactly-once delivery.
Busy session or sandbox admission leaves an unclaimed delegated task queued, without
executing or replaying it. Admission resumes only after the normal lease becomes available.
An authorized pinned MCP recipe is not removed because its shared deployment is stopped:
the session broker validates its pinned image/recipe and current grants, then lazily starts
the isolated session sidecar. It never borrows the shared deployment process.

`/compact` or `/compact <custom instructions>` on an owned idle Pi SDK conversation
executes native `session.compact()` against that same retained session. Wait for the
persisted native command result; busy bindings reject another writer and failure
does not fall back to host summarization or CLI compaction. Verify compaction
separately; the communication smoke below does not cover it.
Authenticated conversation-command requests generate native receipt IDs. Commands arriving
through an external channel transport must instead supply its stable message ID for deduplication.

Collaboration uses independent inbound/outbound permissions and explicit bounded
target grants. Selecting a target does not silently enable either direction.
Workspace/actor scope, live grants, cycle/depth limits, task leases and approval
policy still apply. The old `set-local` / `a2aInternalEnabled` control is removed.
Every edge's pinned/live policy intersection is checked against the final chain depth,
including a remote leaf. A broad child-to-remote policy cannot enlarge an ancestor's
approved depth. Current child authorization is also required before continuation output
is incorporated; revocation cannot leave a parent waiting forever on an unauthorized child.
Keep personal Bearer tokens only in operator-controlled services, not prompts,
browser code or third-party Agents.

Non-Pi and unresolved historical sessions are read-only. Old Hermes public execution,
runtime MCP/dashboard, terminal, upload, model and profile endpoints are retired
with HTTP **410**; they are not mapped to a new executor. Retained transcript,
response and bound-file reads, plus real already-bound cancellation/drain, remain.
The old `pi-harness` task tag is only for bound cleanup, not new admissions or replay.
Conversion creates a fresh Pi draft requiring new authorization; it does not resume
the old runtime state.
Active conversation terminal streams reauthorize the same current authenticated
identity, workspace membership, pinned revision, sandbox mapping and bridge every
15 seconds. Credential, identity or execution-authorization revocation closes the
stream; a previously opened connection is not permanent authority.
Reusing a genuinely running session also revalidates its revision, volume, and credentials,
but does not restart the bridge or require closing an active terminal. Disruptive lifecycle
operations remain excluded while file or terminal access is active.

### Native SDK verification

Use an approved isolated PostgreSQL/Docker environment and the fixed capture image.
Run the current native host, capability, lease and communication suites serially:

```sh
pnpm test --no-file-parallelism tests/integration/pi-sdk-host.test.ts tests/integration/pi-sdk-capabilities.test.ts tests/integration/pi-sdk-native-leases.test.ts tests/integration/pi-agent-communication.test.ts
```

Do not run another suite against the same database concurrently or use PGlite as
evidence for independent-session locking. Deleted Harness host/recovery/binding
suites and `pi-harness-recovery-check.mjs` are not rollout checks. Unit/parser results
do not establish live provider, Docker or cross-account acceptance.

### Paid-model communication smoke

Read `node scripts/pi-agent-communication-smoke.mjs --help`, then supply all six
required environment variables:

| Variable | Required scope |
|---|---|
| `TOOLPLANE_SMOKE_BASE_URL` | Local isolated app origin on `localhost`, `127.0.0.1` or `[::1]`; HTTPS or loopback HTTP, without credentials/path/query/fragment |
| `TOOLPLANE_SMOKE_WORKSPACE_SLUG` | Authorized disposable test workspace |
| `TOOLPLANE_SMOKE_AGENT_A_ID` | Existing published `pi-smoke-disposable-*` Pi Agent |
| `TOOLPLANE_SMOKE_AGENT_B_ID` | A distinct existing published `pi-smoke-disposable-*` Pi Agent |
| `TOOLPLANE_SMOKE_PERSONAL_TOKEN` | Operator token authorized for those local A2A endpoints; environment only |
| `TOOLPLANE_SMOKE_DATABASE_URL` | Explicit local isolated PostgreSQL database whose name contains `test`, `acceptance` or `disposable` |

Both Agents must already have active published Pi SDK 0.87.1 revisions, digest-pinned
environment images, configured live models, inbound authorization and native `bash`
permission. A must have both published and live outbound permission for a bounded,
text-only A → B grant. The app/runtime owner and Docker must be ready. Do not alter
configuration or grants during the run to force an acceptance result.

With an approved live provider, run `node scripts/pi-agent-communication-smoke.mjs`.
Its explicit inspection database connection is forced read-only; it does **not**
use that connection to configure Agents or write runtime ledgers. The authenticated
application still creates tasks and the delegated native tool writes a uniquely
named smoke file. Token-bearing requests are limited to the two selected local A2A
endpoints and reject redirects; the token is not sent to the console BFF or third
parties.

The smoke checks idempotent message admission, one actual completed child task,
native tool settlement and file contents, distinct revision-bound context sandboxes,
then a new task in the same retained context/session with no further delegation.
It inspects the ledger-bound container and native session read-only and verifies
that published defaults did not change. It installs nothing, mutates no runtime
configuration, kills no processes and performs no crash/restart replay probe.
It does not request interactive kill/restart or approval confirmations. Missing
prerequisites, input-required tasks, timeouts and unknown outcomes fail rather than
being skipped or fabricated. Failure cleanup cancels only submitted receipts that
are still active and reports unconfirmed cleanup; artifacts remain for inspection.

This is paid-model acceptance, not a prerequisite checker or proof of crash recovery.
Remote HTTPS peers, other-account authorization and `/compact` remain separate live
checks; `a2a-e2e-preflight.mjs` only reports prerequisites. Never target production or
an ordinary shared development runtime, and do not change ownership/recovery ACKs,
migrate a shared database or restart services merely to run this smoke.

## Historical Hermes attachments

Historical attachment metadata, archives and bound workspace files are retained.
Use the scoped read-only session file endpoint, including offline volume reads;
reading history must not start the old runtime. Legacy upload/reservation execution
and its automatic Hermes cleanup worker are removed. Do not delete reservation
rows or claim that an upgrade purged retained bytes. Explicit authorized deletion
owns physical destruction; ordinary stop preserves volumes.

Fresh Pi session files and Workspace/Work attachments use their current scoped file
and attachment lifecycles, not the removed Hermes quota/reservation flow. Historical
archive import copies files into stopped storage only. Connector files stay on the
user's machine. Continue monitoring physical disk usage and filesystem limits;
read-only retention is not automatic reclamation.

## Installation and diagnostic changes

See [Toolkit cutover](./TOOLKIT_SYNC.en.md) for drained dry-run/apply conversion and retained read-only history. Legacy Toolkit bootstrap, sync, executable install links and old scoped tokens are not accepted. New clients use reviewed Resource Center registrations; protect their one-time configuration and explicitly revoke exposed registration tokens.

See [Logging and Audit](./OBSERVABILITY.md) for explicit Agent-content capture. Normal diagnostics do not enable it; opt-in capture is bounded, audited and retained for at most 24 hours. Public Endpoint suppression cannot be overridden.

## Verification boundaries

`tests/unit/runtime-owner.test.ts` tests the ownership state machine and lease failure paths. `tests/integration/runtime-owner-lease.test.ts` requires real independent PostgreSQL sessions and verifies lock contention and connection loss. `tests/integration/hermes-runtime-mcp.test.ts` covers retired endpoint behavior and retained history; it does not execute Hermes. The native SDK suites above cover their own host/capability/lease boundaries. `TOOLPLANE_TEST_PGLITE=1` is only for isolated embedded-database smoke runs and skips unsupported multi-session cases; never set it in CI or production. Docker lifecycle and real-client acceptance checks still require their respective runtimes and are not established merely by a parser or mock test.
