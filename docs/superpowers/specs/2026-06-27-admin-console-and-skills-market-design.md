# System Admin Console + Skills Market — Design

**Date:** 2026-06-27
**Status:** Approved (ready for implementation plan)

> 中文摘要:为平台加一套**全局后台 `/admin`**(管理所有用户/工作区、MCP 与 Skills 市场目录、系统总览),并把 **Skills 做成像 MCP 市场一样可浏览 + 一键添加**。后台权限基于 `User.role` 枚举 + `ADMIN_EMAILS` 环境变量引导;admin 手改的市场条目用 `curated` 标志防止被爬虫覆盖;目录删除遇到运行时依赖时拒绝,避免误杀用户在跑的部署/已装 skill。

---

## Goal

One global admin area that lets a designated admin manage **all** users, workspaces, and the **MCP / Skills directory ("market")**, plus a system-wide health overview. Separately, turn **Skills** into a first-class public market parallel to the MCP market: browsable on the public site with a one-click "Add to my workspace".

## Why now / context

- There is **no global admin concept** today. `User` has no role; `Membership.role` (`owner`/`member`) is workspace-scoped only. No `/admin` route, no admin API, no special first-user handling.
- The **directory content** (`Server`, `Skill`, `Client`, `Category`) is populated **only by `scraper/*`**. No UI exists to create/edit/feature/remove entries.
- **Skills already have** a public browse page (`(site)/tools/skills`), a detail page, and a console-side add flow (`AddSkillDialog`: create / import-from-GitHub / upload-folder; `installSkillAction` to install from the directory). What's missing is (a) admin management of the Skill **directory**, and (b) a public-site **one-click add** comparable to the MCP market.

## Decisions (locked with the user)

1. **Admin identity:** add a `role` field to `User`; bootstrap admins from an `ADMIN_EMAILS` env allowlist, reconciled at login/signup. (User picked this over an env-only check or first-user-is-admin.)
2. **Skills market:** do **both** — admin-managed directory **and** a public browse + one-click add.
3. **Scope:** build **all** subsystems in one pass (foundation → shell+overview → users/workspaces → market mgmt → public add).
4. **User management power:** view + role toggle **+ suspend/enable + delete** (delete behind typed confirmation).
5. **Scraper conflict:** add a **`curated`** flag on `Server`/`Skill`; the scraper skips updating curated rows.
6. **Field types:** use **Prisma enums** for `User.role` and `User.status` (user's explicit choice, overriding the codebase's String-role convention). `curated` stays `Boolean`.

## Non-goals (YAGNI)

- No admin impersonation / "view as workspace".
- No Client-directory management UI (clients are scraped-only; not requested).
- No audit log of admin actions (can add later).
- No per-permission RBAC; a user is either `admin` or not.

---

## Architecture overview

```
src/app/
  (site)/ …                      # public site (unchanged except skills detail CTA)
  app/[workspace]/ …             # console (unchanged except optional Admin entry in chrome)
  admin/                         # NEW top-level route group — global, NOT workspace-scoped
    layout.tsx                   # requireAdmin() gate + AdminChrome
    page.tsx                     # system overview
    users/{page, [id]/page}
    workspaces/{page, [id]/page}
    servers/{page, new, [id]/edit}
    skills/{page, new, [id]/edit}
    categories/page

src/lib/
  auth/admin.ts                  # NEW: ADMIN_EMAILS, reconcileAdminRole, requireAdmin
  admin/overview.ts              # NEW: getSystemOverview()
  admin/users.ts + user-actions.ts
  admin/workspaces.ts + workspace-actions.ts
  admin/market.ts                # directory Server/Skill CRUD queries+actions
  admin/categories.ts
  skills/public-install.ts       # NEW: addSkillToWorkspaceAction

src/components/admin/
  AdminChrome.tsx, AdminSidebar.tsx
  ServerForm.tsx, SkillForm.tsx
  ConfirmDialog.tsx              # typed-confirmation for destructive actions (reuse danger-zone style)
```

`/admin` is a **literal top-level segment** (sibling of `(site)` and `app`). Verified there is **no catch-all** under `(site)`, so `/admin` does not collide with any marketing route or workspace slug (`[workspace]` lives under `/app`).

---

## Phase 1 — Foundation: roles, status, curated flag

### Schema (`prisma/schema.prisma`)

```prisma
enum UserRole {
  user
  admin
}

enum UserStatus {
  active
  suspended
}

model User {
  // …existing fields…
  role   UserRole   @default(user)
  status UserStatus @default(active)
}

model Server {
  // …existing…
  curated Boolean @default(false)
}

model Skill {
  // …existing…
  curated Boolean @default(false)
}
```

Migration: `pnpm db:migrate` (creates the two Postgres enum types + columns). Prisma 7 driver-adapter (`@prisma/adapter-pg`) handles enums normally. **After migrating, restart `pnpm dev`** (stale client → `db.user.role` undefined otherwise).

### Admin auth (`src/lib/auth/admin.ts`)

```ts
import 'server-only';
import { db } from '@/lib/db';
import { redirect } from 'next/navigation';
import { getCurrentUser } from './current-user';

export function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminEmail(email: string): boolean {
  return adminEmails().has(email.toLowerCase());
}

// Promote a user to admin if their email is allowlisted. Called after a session
// is established (login/signup). Only writes when a change is needed.
export async function reconcileAdminRole(user: { id: string; email: string; role: 'user' | 'admin' }): Promise<void> {
  if (user.role !== 'admin' && isAdminEmail(user.email)) {
    await db.user.update({ where: { id: user.id }, data: { role: 'admin' } });
  }
}

// Server-side gate for /admin layout, admin queries, and admin actions.
export async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/login?next=/admin');
  if (user.role !== 'admin') redirect('/');
  return user;
}
```

### Suspension + role wiring

- `src/lib/auth/current-user.ts` — extend `select` with `role` and `status`. **If `status === 'suspended'`, return `null`** (treats suspended users as logged-out; invalidates existing JWT sessions on next request with no session store). `CurrentUser` type now includes `role` / `status`.
- `src/lib/auth/tokens.ts` `verifyApiToken()` — reject (`return null`) when the resolved user's `status === 'suspended'`.
- `src/lib/auth/actions.ts`:
  - `loginAction` — after loading the user, if `status === 'suspended'` return `{ error: 'This account has been suspended.' }` (no session). After `createSession`, call `reconcileAdminRole(user)`.
  - `signupAction` — after `createSession`, call `reconcileAdminRole(user)`.

**Self-protection invariants** (enforced in actions, Phase 3): an admin cannot demote, suspend, or delete **their own** account.

### Tests (Phase 1)

- `reconcileAdminRole` promotes allowlisted user, no-ops otherwise.
- `requireAdmin` returns admin; redirects non-admin / logged-out (assert redirect called).
- `getCurrentUser` returns `null` for a suspended user.
- `loginAction` rejects suspended user without creating a session.
- `verifyApiToken` returns `null` for a suspended user's token.

---

## Phase 2 — Admin shell + system overview

### Shell

- `src/app/admin/layout.tsx` (server) — `await requireAdmin()`; renders `AdminChrome`. `export const dynamic = 'force-dynamic'`.
- `src/components/admin/AdminChrome.tsx` + `AdminSidebar.tsx` — mirror `DashboardChrome`/`DashboardSidebar` structure and zinc dark-mode token convention. Distinct **"Admin"** marker (e.g. red accent) and a "← Back to app" link to avoid confusing it with a workspace. Nav items: Overview (`/admin`), Users, Workspaces, ToolPlane (`/admin/servers`), Skills Market (`/admin/skills`), Categories.
- Console entry: pass `isAdmin` into the console chrome (`DashboardChrome`) and show an "Admin" link only when `role === 'admin'`. Minimal, non-invasive.

### Overview data (`src/lib/admin/overview.ts`)

`getSystemOverview()` returns:

- **Counts:** users (total / admins / suspended / created last 7d), workspaces, deployments by `status` (`db.deployment.groupBy`), agents, toolkits, installedSkills, providers, directory `Server`/`Skill`/`Client`.
- **Requests (last 24h, global):** total, errors (`statusCode >= 400`), error rate, avg + p95 `durationMs` over `RequestLog` (reuse the existing observability aggregation math, dropping the `workspaceId` filter), plus a 7-day per-day series.
- **Plugin telemetry (24h):** `SkillInvocation` total/errors, `SyncEvent` applied/failures.
- **Scraper:** all `ScrapeCheckpoint` rows (`job`, `doneCount`, `updatedAt`).

`src/app/admin/page.tsx` — stat-card grid + recent-signups list + scraper status table. Read-only.

### Tests (Phase 2)

- `getSystemOverview` returns the documented shape with seeded fixtures (counts correct, deployment groupBy buckets, request aggregates).

---

## Phase 3 — Users & workspaces management

### Users (`src/lib/admin/users.ts`, `user-actions.ts`)

Queries:
- `listUsers({ page, q })` — paginated; optional case-insensitive search on email/name; selects role, status, createdAt, and `_count` of ownedWorkspaces / memberships / apiTokens.
- `getUserDetail(id)` — user + owned workspaces + memberships (with workspace name).

Actions (each begins with `await requireAdmin()`, returns an `ActionState`-style `{ error? }`):
- `setUserRoleAction(userId, role)` — **reject if `userId === admin.id`** ("You can't change your own role.").
- `setUserStatusAction(userId, status)` — **reject if `userId === admin.id`**.
- `deleteUserAction(userId)` — **reject if `userId === admin.id`**; require typed-confirmation (UI passes a `confirm` field === user's email). Before delete: `killMany` over the user's workspaces' deployment ids (see shared teardown below). Cascade deletes the rest via FK.

Pages: `src/app/admin/users/page.tsx` (table + search + role/status badges + per-row action menu), `users/[id]/page.tsx` (detail + danger zone). Destructive actions use `ConfirmDialog` (typed confirmation), mirroring the existing settings danger-zone (delete agent/workspace).

### Workspaces (`src/lib/admin/workspaces.ts`, `workspace-actions.ts`)

- `listWorkspaces({ page, q })` — owner email, member count, deployment count, createdAt.
- `getWorkspaceDetail(id)` — owner, members, deployments (with status), counts.
- `deleteWorkspaceAction(workspaceId)` (admin) — `requireAdmin`; **no owner check**; reuse shared teardown then `db.workspace.delete`.

### Shared teardown helper

The existing owner-only `deleteWorkspaceAction` (`src/lib/workspace/actions.ts:248`) already does `killMany(deploymentIds)` then `db.workspace.delete`. Extract that into a reusable helper (e.g. `teardownWorkspaceProcesses(workspaceId)` in `src/lib/workspace/teardown.ts`) and call it from **both** the owner action and the admin action, so no path leaks orphaned MCP child processes.

### Tests (Phase 3)

- `setUserRoleAction` / `setUserStatusAction` / `deleteUserAction` each reject acting on self.
- `deleteUserAction` with wrong `confirm` value is refused.
- Admin `deleteWorkspaceAction` calls teardown (assert `killMany` invoked with the workspace's deployment ids) and deletes.
- `listUsers` search + pagination shape.

---

## Phase 4 — MCP & Skills market management

### Servers (`src/lib/admin/market.ts`)

Queries: `listDirectoryServers({ page, q })`, `getDirectoryServer(id)` (with categories + `_count.deployments`).

Actions (`requireAdmin`, set **`curated: true`** on every create/edit):
- `createServerAction` / `updateServerAction` — fields: `slug` (unique, validated `^[a-z0-9][a-z0-9-]*[a-z0-9]$`), `name`, `author`, `description`, `iconUrl`, `isOfficial`, `isFeatured`, `stars`, `categories` (multi, connectOrCreate by slug), `installCfg` (JSON textarea → parsed/validated), `readme`.
- `toggleServerFeaturedAction` / `toggleServerOfficialAction` — also set `curated: true`.
- `deleteServerAction` — **refuse when `_count.deployments > 0`**; return an error naming the count (because `Deployment.serverId` is `onDelete: Cascade` — deleting would kill users' running deployments).

Pages: `servers/page.tsx` (table + feature/official toggles + search), `servers/new/page.tsx`, `servers/[id]/edit/page.tsx`, sharing `ServerForm.tsx`.

### Skills (`src/lib/admin/market.ts`)

Queries: `listDirectorySkills({ page, q })`, `getDirectorySkill(id)` (with categories + `_count.installs`).

Actions (`requireAdmin`, set **`curated: true`**):
- `createSkillAction` / `updateSkillAction` — `slug`, `name`, `author`, `description`, `iconUrl`, `score`, `categories`.
- `deleteSkillAction` — **refuse when `_count.installs > 0`** (`InstalledSkill.skillId` is `onDelete: Cascade`; deleting would remove users' installed skills).

Pages: `skills/page.tsx`, `skills/new/page.tsx`, `skills/[id]/edit/page.tsx`, sharing `SkillForm.tsx`.

### Categories (`src/lib/admin/categories.ts`)

- `listCategories()` with `_count` of servers/skills/clients.
- `createCategoryAction(slug, name)`; `deleteCategoryAction(id)` — refuse unless the category is empty.
- Page: `categories/page.tsx` (list + inline create). Used to populate the category multi-select in the server/skill forms.

### Scraper protection (`scraper/ingest.ts`)

In `upsertServer` and `upsertSkill`: look up the existing row's `curated` first; if `curated === true`, **skip the update** (preserve admin edits) but still allow `create` for new slugs.

```ts
const existing = await db.server.findUnique({ where: { slug: card.slug }, select: { id: true, curated: true } });
if (existing?.curated) return;            // leave admin-managed row untouched
// …existing upsert…
```

### Tests (Phase 4)

- `upsertServer`/`upsertSkill`: curated row not updated; non-curated row updated; new slug created.
- `createServerAction`/`updateServerAction`/`createSkillAction`/`updateSkillAction` set `curated: true`; slug validation rejects bad slugs.
- `deleteServerAction` refuses with deployments present; `deleteSkillAction` refuses with installs present; both succeed when none.

---

## Phase 5 — Public Skills market + one-click add

### Public install action (`src/lib/skills/public-install.ts`)

```ts
'use server';
// requires a logged-in user; resolves their default workspace and installs the skill.
export async function addSkillToWorkspaceAction(formData: FormData) {
  const user = await getCurrentUser();
  const skillId = String(formData.get('skillId') ?? '');
  if (!user) redirect(`/app/login?next=/tools/skills`); // CTA also gates when logged-out
  if (!skillId) return;
  const ws = await getOrCreateDefaultWorkspace(user.id, user.email);
  const install = await db.installedSkill.upsert({
    where: { workspaceId_skillId: { workspaceId: ws.id, skillId } },
    update: {},
    create: { workspaceId: ws.id, skillId },
  });
  revalidatePath(`/app/${ws.slug}/skills`);
  redirect(`/app/${ws.slug}/skills/${install.id}`);
}
```

Mirrors the console `installSkillAction` upsert (`workspaceId_skillId`, idempotent) but resolves the default workspace via the existing `getOrCreateDefaultWorkspace(userId, email)` and redirects into the console.

### Public detail CTA (`src/app/(site)/tools/skills/[slug]/page.tsx`)

Add an "Add to my workspace" card mirroring the server detail page's auth-gating:
- **Logged out** → `Sign in to add` link to `/app/login?next=/tools/skills/<slug>`.
- **Logged in** → a `<form action={addSkillToWorkspaceAction}>` with a hidden `skillId` and a `SubmitButton` (`pendingLabel="Adding…"`) for click feedback.

This makes Skills a complete public market: browse (`/tools/skills`, already present) + one-click add, parallel to the MCP market. The catalog those pages render is what admins curate in Phase 4.

### Tests (Phase 5)

- `addSkillToWorkspaceAction` upserts into the default workspace and is idempotent on repeat.

---

## Security invariants to preserve

- **Every** admin query and action begins with `requireAdmin()`. Admin surfaces are intentionally **not** workspace-scoped, so the admin check is the only gate — it must be present on each.
- Suspended users are denied via **both** channels: session (`getCurrentUser` → null) and API token (`verifyApiToken` → null).
- Self-protection: an admin cannot demote / suspend / delete their own account (prevents lockout).
- Directory **deletes refuse** when they would cascade onto users' runtime rows (deployments / installed skills).
- Workspace deletion (owner or admin) always tears down MCP child processes first (shared helper) — no orphans.
- Unchanged invariant: API tokens still return plaintext once; only the hash is stored. Never persist a chat turn to a foreign conversation.

## Verification

1. `pnpm exec tsc --noEmit` clean; `pnpm test` green; `pnpm build` ok.
2. Set `ADMIN_EMAILS=<your-email>` in `.env`, log in → `/admin` reachable; a non-admin account is redirected away from `/admin`.
3. Suspend a test user in `/admin/users` → that user's next request logs them out; their API token stops working. Re-enable restores access.
4. Edit a market entry in `/admin/servers` (now `curated`), run the relevant scraper → the edit survives. A new scraped slug still appears.
5. Try to delete a directory Server that has a deployment / a Skill that has an install → refused with a clear message. Delete one with no dependents → succeeds.
6. On `(site)/tools/skills/<slug>`, logged in, click **Add to my workspace** → skill appears in the console; clicking again is idempotent.

## Implementation phases (for the plan)

1. Foundation (schema + admin auth + suspension wiring) — everything depends on it.
2. Admin shell + system overview.
3. Users & workspaces management (+ shared teardown helper).
4. MCP & Skills market management (+ scraper curated guard).
5. Public Skills market one-click add.

Each phase is independently testable and leaves the app working.
