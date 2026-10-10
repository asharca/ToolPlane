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

Owners can appoint or demote existing non-owner members as workspace administrators on the members page.
This delegates the existing Agent API/client-key, A2A/remote-agent/channel operator, Pi package source, marketplace publishing, and workspace notification capabilities;
it does not change the account's site role. Invitations, member removal, renaming, deletion, ownership transfer,
and administrator appointments remain owner-only. Suspended accounts cannot receive a new administrator grant,
but can be demoted. Administrators can leave like other non-owner members. Transferring ownership demotes only
the old owner and preserves other administrators.

Invitations are generated per email as one-time links valid for 7 days; they do not depend on SMTP and never claim an email was sent.
The database stores only the token hash. Regenerating, revoking, accepting, or expiring invalidates previous links.
Credentials live in the URL fragment; the page moves them into tab-scoped sessionStorage and clears the fragment so they never reach server request logs; sign-in/sign-up in the same tab can continue the invitation.
The owner first previews the email and explicitly confirms the existing account's name/email: registration emails are not verified. Only that confirmed account receives a notification and may accept the bound invitation, through either the inbox or its token link. A deleted account's replacement cannot inherit that invitation, even with the same email.
For an unregistered email the owner creates a link only. Later registration does not automatically receive or claim a notification; the original token and matching email still allow joining. If the account changes after preview, creation fails and requires a new preview.
Reinviting reuses the pending invitation's notification, resets its receipt to unread and invalidates the old token. Acceptance rechecks the active account, receipt binding, email, expiry and workspace under the workspace lock; token/inbox races have one winner. Accepted, revoked or expired invitations retain notification history without a usable join action.

Member add/remove, invitation consumption, ownership transfer, and deletion start all take the same workspace row lock.
Removing a member also revokes that workspace's toolkit tokens and outstanding invitations — but not the user's global personal tokens.
Requests re-verify membership; connected terminals, work events, and conversation output streams are cut immediately in this process,
and cross-process revocation is enforced by a permission check at most every 5 seconds.

## Private notifications

Notifications use PostgreSQL `Notification` content and per-account `NotificationRecipient` receipts, not protocol notifications or audit logs.
Site administrators may announce to active ordinary accounts; workspace owners and administrators may announce to active owners/members of their own workspace.
Selected email audiences are normalized and deduplicated; any unavailable or out-of-scope target rejects the entire send. Audiences are snapshots at publication, not dynamic subscriptions.
Titles (1–120 characters) and bodies (1–5000 characters) are plain text; body line endings are normalized before validation so form CRLF encoding does not consume extra characters. Sending content, receipts and the metadata-only audit is one transaction; broadcasts insert receipts in batches of 500 without a queue.
Inbox access and read mutations always require the active receiving account. Reading a page does not mark it read; explicit single/all read operations are private and preserve the first read time.
Open the inbox as a workspace tab at `/app/<slug>/notifications` with the sidebar and other open tabs preserved; add `unread=1` and `page=N` for filtering/pagination (20 receipts per page). `/app?view=notifications` remains the fallback when the account has no workspace, with the same account-level privacy. Workspace sidebars, the account header and the administrator sidebar link to the same private inbox.
Publish site announcements at `/admin/notifications`, or workspace announcements on that workspace's members page. Forms default to selected recipients and show the actual committed recipient count. They do not expose a general account lookup.
The bell refreshes its count on focus, visibility restoration, explicit inbox updates and every 60 seconds while visible. It preserves the last count on failure; refresh the inbox explicitly to load new content without interrupting drafts.
Leaving a workspace or deleting its publisher/workspace does not delete received history or grant access to its resources. Apply `20261008083847_in_app_notifications` and regenerate/restart before using notifications; old invitations are not backfilled.

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
