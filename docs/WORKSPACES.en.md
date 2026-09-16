# Workspace Flows

> **中文**：[WORKSPACES.md](./WORKSPACES.md)

A workspace is the isolation boundary for members, shared resources, and run records. Personal language, theme, time zone, password, and personal API tokens do not belong to any workspace. Current members are trusted collaborators; there is no resource-level read-only role.

## Entry Points

- `/app?view=workspaces`: workspace list, create, enter, leave, and recovery entry for failed cleanups.
- `/app?view=account`: cross-workspace personal settings and API tokens; legacy in-workspace tokens pages redirect here.
- `/app/[workspace]/members`: member list, invite/revoke invitations, remove members, leave voluntarily.
- `/app/[workspace]/settings`: name, default model, ownership transfer, and deletion.
- `/app`: restores the account's last-visited still-accessible workspace in this browser, or offers a choice of accessible workspaces. With no workspace it shows an empty state — workspaces are no longer created implicitly. When a marketplace install has multiple candidate target workspaces, the target is chosen first.

Account-level pages use query parameters so no new static path can collide with an existing workspace slug.
A new workspace only requires a name; Chinese is supported, capped at 80 UTF-16 units, matching HTML maxlength.
The URL contains a random suffix; renaming does not change the URL. After creation you land in Work for onboarding.

## Members & Invitations

The owner manages workspace configuration, model providers, messaging channel credentials, and members; members use and edit business resources.
The server treats `Workspace.ownerId` as the source of truth for ownership — never rely on the UI or `Membership.role` alone.
A departing member does not delete shared resources; the owner must first transfer ownership to a valid existing member.

Invitations are generated per email as one-time links valid for 7 days; they do not depend on SMTP and never claim an email was sent.
The database stores only the token hash. Regenerating, revoking, accepting, or expiring invalidates previous links.
Credentials live in the URL fragment; the page moves them into tab-scoped sessionStorage and clears the fragment so they never reach server request logs; sign-in/sign-up in the same tab can continue the invitation. Acceptance must validate the link, email, expiry, and workspace state together. Joining directly from an "invitation inbox" based on an unverified registration email alone is not allowed.

Member add/remove, invitation consumption, ownership transfer, and deletion start all take the same workspace row lock.
Removing a member also revokes that workspace's toolkit tokens and outstanding invitations — but not the user's global personal tokens.
Requests re-verify membership; connected terminals, work events, and conversation output streams are cut immediately in this process,
and cross-process revocation is enforced by a permission check at most every 5 seconds.

## Deletion & Deployment

Deletion requires typing the current workspace name and shows impact counts. The state sequence is `active` → `deleting` →
record deleted; on failure the workspace stays `delete_failed` and cannot be treated as usable again. Cleanup stops tasks,
processes, and containers and deletes managed volumes; it cannot promise to undo or recover already-deleted data. Existing
files on connected devices are not deleted by this. The owner can retry from the workspace list; other members can still leave.

Cleanup concurrency dedup currently lives inside a single admin-service process; before deploying multiple independent admin
workers, add a renewable database cleanup lease. The closed state in the database keeps blocking the console and runtime
processes from starting again after restarts.

The release ships migration `20260908000000_workspace_lifecycle`; apply migrations, regenerate the Prisma client, and
restart the app when deploying. Never run migrations without confirming the target database.

Regression: `pnpm vitest run tests/integration/workspace-management.test.ts tests/unit/workspace-access-stream.test.ts tests/unit/workspace-navigation.test.ts`
