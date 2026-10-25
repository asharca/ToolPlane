# Capability client registration and legacy Toolkit cutover

> **中文**：[TOOLKIT_SYNC.md](./TOOLKIT_SYNC.md)

Toolkit execution and its installer are retired. Historical Toolkit records remain readable; they are not a separately publishable or executable combination. Compose private Pi packages in the resource center (`/app/:workspace/market/compose`) and manage capture sources at `/app/:workspace/market/sources`.

## Frozen publication

Capture/assembly preview returns `sourceDigest`. Commit must submit that same digest; changed bytes or dependencies require another preview. Selecting an owned immutable private release is also a valid frozen source. Private listing history can never be made public in place: submit the selected approved bytes into a separate public listing for human review. Authenticated/private source metadata is not distributed in that public artifact. Scan results still apply to the actual distributed bytes, including decoded binary Skill attachments.

Skill bundles preserve `SKILL.md`, relative attachment paths, binary contents and executable metadata supported by the package format. Archive extraction validates paths and symlink containment; package installation does not execute captured source in the web process. Native extension command/tool registration is checked by the isolated Pi preflight at Agent Review + Apply and again at runtime, not by guessing JavaScript behavior with a regular expression.

## One registration mechanism

Use the existing Pi-package registration model for either:

- a ready workspace package installation (`marketInstallId`); or
- fixed standalone Skill/MCP/package releases (`selections`).

Each selection has exactly `{ releaseId, checksum, kind }`, where kind is `skill`, `mcp` or `pi-package`. These are immutable selected versions, not a new market listing or independently publishable combo. The database maintains normalized release references to prevent referenced release deletion. It validates selection checksums/kinds and forbids changing owner/workspace/client identity.

Account-authenticated endpoints:

| Operation | Endpoint | Body |
|---|---|---|
| List/create | `GET/POST /api/v1/workspaces/:workspace/pi-packages/installations` | POST: `client`, `label`, optional `marketInstallId` or `selections`, explicit `bindings` |
| Reviewed update | `PATCH /api/v1/workspaces/:workspace/pi-packages/installations/:id` | Required integer `expectedConfigVersion`; selected `releaseId` or `selections`; `bindings`; explicit `confirmExpandedPrivileges` when needed |
| Revoke | `DELETE /api/v1/workspaces/:workspace/pi-packages/installations/:id` | None |

The token-authenticated artifact, manifest, MCP and revoke endpoints remain under `/api/v1/pi-packages/installations/:id/`. Tokens are random, hashed at rest, revocable and restricted to one registration; they are not account API credentials. Every request rechecks workspace membership, selected release approval, live MCP tool grants and current deployment configuration. Updating selection is owner-scoped compare-and-swap against the independently incremented `configVersion`; a stale review cannot overwrite concurrent configuration changes, while authentication's `lastUsedAt` writes do not change that version. Expanded privileges require explicit confirmation. Non-Pi clients receive only their supported Skill/MCP resources, never a claim that native Pi extensions, Prompt or Theme resources were installed.

Package setup configures fresh connections and may retry credentials on an unshared connection created by the same authenticated idempotent operation. It does not mutate selected existing/shared MCP connections; use MCP settings with explicit impacted-object confirmation instead. For a selected Agent, explicit Review + Apply publishes a new default from its current applied revision with only this package and confirmed MCP scopes merged in (`enabled: true`, `agentRevisionId`). Unrelated drafts and existing session revisions stay unchanged. Targets without an applied revision must first prepare, review and apply their configuration; no install side effects occur before this check. Unencrypted HTTP recipes remain `setup_required` until the workspace operator explicitly approves HTTP; an artifact author's flag is not operator consent.

## Security revocation and retention

`POST /api/v1/pi-packages/releases/:releaseId/revoke` takes `{ workspace, reason }`. A publishing workspace administrator or platform administrator can mark a dangerous release `revoked`; dependent client registrations are revoked and execution boundaries recheck release status immediately. References and historical bytes are retained for reading/audit. Uninstall is not security revocation: removing defaults must not break already pinned session artifacts. Agent revisions and embedded Assistant Prompt `sourceReleaseId` references retain their source releases independently of the original install. Public withdrawal does not authorize deletion of retained references.

## Controlled Toolkit conversion

The maintenance endpoint is `POST /api/v1/workspaces/:workspace/toolkits/cutover`:

```json
{ "toolkitId": "owned-toolkit-id", "mode": "dry-run" }
```

The response reports `ready`, `blocked` or `already-applied`, the frozen digest when available, blockers and `requiresReauthorization: true`. After draining all active legacy Work/public/A2A tasks, explicitly apply the reviewed digest:

```json
{ "toolkitId": "owned-toolkit-id", "mode": "apply", "expectedDigest": "64-character-sha256", "confirmReauthorization": true }
```

The domain operation is `cutoverToolkitToPrivatePackage` in `src/lib/toolkits/cutover.ts`. It requires workspace owner/admin or platform-admin authorization, locks the workspace and runs transactionally. Apply rejects active tasks, stale content, unsupported/empty conversion and credential-bearing artifacts. A successful conversion creates a **PRIVATE** frozen package without an install or execution grant; archives any old market association; revokes old Toolkit install tokens/registrations; disables the old Toolkit; and records audit/provenance. Repeating it returns the original conversion rather than creating another package. Old public versions are never automatically republished. Legacy records are not deleted and historical non-Pi sessions are not resumed under fabricated Pi state.

This endpoint is an explicit maintenance operation, not an automatic startup migration. Deploying code, reading this document or running a dry-run does not authorize applying migrations or changing a production runtime. Legacy Toolkit sync, install and execution routes are removed rather than retained as compatibility shims; historical records remain readable through history surfaces. Admin market mutation/approval cannot republish retired Toolkit releases.

## Regression suites

Focused behavior coverage lives in `tests/integration/pi-package-market.test.ts`, `pi-package-bindings.test.ts`, `pi-package-clients.test.ts`, `toolkit-market.test.ts`, `capability-client-registration-schema.test.ts`, and the package setup/assembly unit suites. Run them against an isolated test database under the main verification workflow; implementation workers do not run runtime/database actions.
