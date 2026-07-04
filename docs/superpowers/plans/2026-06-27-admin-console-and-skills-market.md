# System Admin Console + Skills Market — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global `/admin` console (manage all users, workspaces, the MCP/Skills directory, and a system overview) and turn Skills into a public market with one-click "Add to my workspace".

**Architecture:** A new top-level `/admin` route group gated by a `requireAdmin()` server check. Admin identity = a `UserRole` enum bootstrapped from an `ADMIN_EMAILS` env allowlist at login/signup. Suspended accounts are denied through both the session and API-token paths. Directory rows edited by admins carry a `curated` flag so the scraper won't overwrite them; directory deletes refuse when they'd cascade onto users' runtime rows. **All testable logic lives in pure query/mutation modules; thin `'use server'` wrappers add `requireAdmin()` — tests target the pure functions** (matching how the codebase tests `mutations`, not cookie-bound `actions`).

**Tech Stack:** Next.js 16 App Router (RSC + server actions), Prisma 7 (`@prisma/adapter-pg`, Postgres), Vitest (unit jsdom + integration node, `fileParallelism: false`), Tailwind (zinc tokens + `dark:` pairs).

**Spec:** `docs/superpowers/specs/2026-06-27-admin-console-and-skills-market-design.md`

---

## Conventions (read once before starting)

- **pnpm only.** `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm build`. Never `npm`.
- **After editing `prisma/schema.prisma`, run `pnpm db:migrate` and then restart any running `pnpm dev`** — the running Next process keeps a stale Prisma client otherwise (`db.<model>` undefined → 500).
- **Trust `pnpm exec tsc --noEmit`, not the editor LSP**, for type errors (LSP lags the regenerated client).
- **Commits carry NO attribution trailer** (no `Co-Authored-By`). Conventional-commit format (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).
- Run a single test file: `pnpm vitest run tests/unit/<name>.test.ts`. Run by name: `pnpm vitest run -t "<name>"`.
- Integration tests (node env, real DB) create their own users/workspaces with a `Date.now()` stamp for unique slugs/emails and clean nothing up (shared DB, sequential files). Unit tests that touch only pure functions use `// @vitest-environment node` when they need node APIs.
- Security invariant: **every admin page and every admin server action calls `requireAdmin()`**. Pure data functions stay auth-free (testable) but are only reachable through a gated page/action.

## File structure (what each new file owns)

```
prisma/schema.prisma                         # +UserRole, +UserStatus enums; User.role/status; Server/Skill.curated
.env.example                                 # +ADMIN_EMAILS

src/lib/auth/admin-policy.ts                 # PURE: adminEmails, isAdminEmail, adminGate, activeUserOrNull  (unit-tested)
src/lib/auth/admin.ts                        # server-only: reconcileAdminRole, requireAdmin (wired)
src/lib/auth/current-user.ts                 # MODIFY: select role/status, drop suspended
src/lib/auth/tokens.ts                       # MODIFY: verifyApiToken rejects suspended
src/lib/auth/actions.ts                      # MODIFY: login rejects suspended; login+signup reconcile admin

src/lib/workspace/teardown.ts                # NEW: workspaceDeploymentIds, killWorkspaceProcesses
src/lib/workspace/actions.ts                 # MODIFY: deleteWorkspaceAction reuses teardown

src/lib/admin/overview.ts                    # getSystemOverview (read-only query)
src/lib/admin/users.ts                       # queries + pure mutations (setUserRole/Status/deleteManagedUser)
src/lib/admin/user-actions.ts                # 'use server' wrappers (requireAdmin)
src/lib/admin/workspaces.ts                  # queries + deleteManagedWorkspace (pure)
src/lib/admin/workspace-actions.ts           # 'use server' wrappers
src/lib/admin/market.ts                       # directory Server/Skill queries + pure mutations
src/lib/admin/market-actions.ts              # 'use server' wrappers
src/lib/admin/categories.ts                  # queries + pure mutations
src/lib/admin/category-actions.ts            # 'use server' wrappers
src/lib/skills/install.ts                    # upsertInstalledSkill (pure, testable)
src/lib/skills/public-install.ts             # addSkillToWorkspaceAction ('use server')

src/components/admin/AdminChrome.tsx          # sidebar shell
src/components/admin/AdminSidebar.tsx         # nav
src/components/admin/ConfirmDialog.tsx        # typed-confirmation destructive button
src/components/admin/ServerForm.tsx           # create/edit directory server
src/components/admin/SkillForm.tsx            # create/edit directory skill

src/app/admin/layout.tsx                      # requireAdmin gate + AdminChrome
src/app/admin/page.tsx                         # overview
src/app/admin/users/page.tsx + [id]/page.tsx
src/app/admin/workspaces/page.tsx + [id]/page.tsx
src/app/admin/servers/page.tsx + new/page.tsx + [id]/edit/page.tsx
src/app/admin/skills/page.tsx + new/page.tsx + [id]/edit/page.tsx
src/app/admin/categories/page.tsx
src/app/(site)/tools/skills/[slug]/page.tsx   # MODIFY: add CTA

src/components/dashboard/{DashboardChrome,DashboardSidebar}.tsx + app/[workspace]/layout.tsx  # MODIFY: optional Admin link
```

---

# PHASE 1 — Foundation: roles, status, curated, suspension

### Task 1: Schema — enums + curated flag

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `.env.example`

- [ ] **Step 1: Add the enums and fields**

Add these two enum blocks near the top of `prisma/schema.prisma` (after the `datasource` block):

```prisma
enum UserRole {
  user
  admin
}

enum UserStatus {
  active
  suspended
}
```

In `model User`, add after the existing scalar fields (e.g. after `passwordHash`):

```prisma
  role   UserRole   @default(user)
  status UserStatus @default(active)
```

In `model Server`, add after `isFeatured`:

```prisma
  curated Boolean @default(false)
```

In `model Skill`, add after `score`:

```prisma
  curated Boolean @default(false)
```

- [ ] **Step 2: Add the env var to the example**

In `.env.example`, add a line:

```
# Comma-separated emails that are auto-promoted to admin on login/signup.
ADMIN_EMAILS=
```

- [ ] **Step 3: Migrate**

Run: `pnpm db:migrate --name admin_roles_curated`
Expected: a new migration is created and applied; `prisma generate` runs. If a `pnpm dev` is running, stop and restart it.

- [ ] **Step 4: Verify the client picked up the fields**

Run: `pnpm exec tsc --noEmit`
Expected: No errors. (If the editor still flags `role`/`status`/`curated`, ignore it — trust tsc.)

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations .env.example
git commit -m "feat: add UserRole/UserStatus enums and curated directory flag"
```

---

### Task 2: Admin policy (pure) + admin auth helpers

**Files:**
- Create: `src/lib/auth/admin-policy.ts`
- Create: `src/lib/auth/admin.ts`
- Test: `tests/unit/admin-policy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/admin-policy.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { adminEmails, isAdminEmail, adminGate, activeUserOrNull } from '@/lib/auth/admin-policy';

const orig = process.env.ADMIN_EMAILS;
afterEach(() => { process.env.ADMIN_EMAILS = orig; });

describe('adminEmails / isAdminEmail', () => {
  it('parses a comma list, trims and lowercases', () => {
    process.env.ADMIN_EMAILS = ' Alice@Example.com , bob@x.io ';
    expect(adminEmails()).toEqual(new Set(['alice@example.com', 'bob@x.io']));
    expect(isAdminEmail('ALICE@example.com')).toBe(true);
    expect(isAdminEmail('carol@x.io')).toBe(false);
  });
  it('is empty when unset', () => {
    delete process.env.ADMIN_EMAILS;
    expect(adminEmails().size).toBe(0);
    expect(isAdminEmail('a@b.c')).toBe(false);
  });
});

describe('adminGate', () => {
  it('returns login for no user', () => expect(adminGate(null)).toBe('login'));
  it('returns forbidden for non-admin', () => expect(adminGate({ role: 'user' })).toBe('forbidden'));
  it('returns ok for admin', () => expect(adminGate({ role: 'admin' })).toBe('ok'));
});

describe('activeUserOrNull', () => {
  it('drops suspended users', () => expect(activeUserOrNull({ id: '1', status: 'suspended' })).toBeNull());
  it('keeps active users', () => {
    const u = { id: '1', status: 'active' };
    expect(activeUserOrNull(u)).toBe(u);
  });
  it('passes through null', () => expect(activeUserOrNull(null)).toBeNull());
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/admin-policy.test.ts`
Expected: FAIL — cannot find module `@/lib/auth/admin-policy`.

- [ ] **Step 3: Write the pure policy module**

Create `src/lib/auth/admin-policy.ts` (no `server-only`, no db — importable from tests):

```ts
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

export type AdminGate = 'login' | 'forbidden' | 'ok';

export function adminGate(user: { role: string } | null): AdminGate {
  if (!user) return 'login';
  if (user.role !== 'admin') return 'forbidden';
  return 'ok';
}

// Treat suspended accounts as logged-out. Generic so it preserves the input type.
export function activeUserOrNull<T extends { status: string }>(user: T | null): T | null {
  if (!user) return null;
  return user.status === 'suspended' ? null : user;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/admin-policy.test.ts`
Expected: PASS (10 assertions).

- [ ] **Step 5: Write the wired admin helpers**

Create `src/lib/auth/admin.ts`:

```ts
import 'server-only';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from './current-user';
import { adminGate, isAdminEmail } from './admin-policy';

// Promote an allowlisted user to admin. Called after a session is established.
export async function reconcileAdminRole(user: { id: string; email: string; role: string }): Promise<void> {
  if (user.role !== 'admin' && isAdminEmail(user.email)) {
    await db.user.update({ where: { id: user.id }, data: { role: 'admin' } });
  }
}

// Gate for /admin layout, admin pages, and admin server actions.
export async function requireAdmin() {
  const user = await getCurrentUser();
  const gate = adminGate(user);
  if (gate === 'login') redirect('/app/login?next=/admin');
  if (gate === 'forbidden') redirect('/');
  return user!;
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm exec tsc --noEmit` → Expected: No errors.

```bash
git add src/lib/auth/admin-policy.ts src/lib/auth/admin.ts tests/unit/admin-policy.test.ts
git commit -m "feat: admin policy helpers and requireAdmin gate"
```

---

### Task 3: Suspension wiring — current-user, token verify, login/signup

**Files:**
- Modify: `src/lib/auth/current-user.ts`
- Modify: `src/lib/auth/tokens.ts`
- Modify: `src/lib/auth/actions.ts`
- Test: `tests/integration/auth-status.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/auth-status.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/lib/db';
import { verifyApiToken, createApiToken } from '@/lib/auth/tokens';
import { reconcileAdminRole } from '@/lib/auth/admin';

const stamp = Date.now();
let activeToken = '';
let suspendedToken = '';

beforeAll(async () => {
  const active = await db.user.create({ data: { email: `act-${stamp}@t.dev`, passwordHash: 'x' } });
  const suspended = await db.user.create({
    data: { email: `sus-${stamp}@t.dev`, passwordHash: 'x', status: 'suspended' },
  });
  activeToken = (await createApiToken(active.id, 'a')).token;
  suspendedToken = (await createApiToken(suspended.id, 's')).token;
});

describe('verifyApiToken honors suspension', () => {
  it('accepts an active user token', async () => {
    const u = await verifyApiToken(`Bearer ${activeToken}`);
    expect(u?.email).toBe(`act-${stamp}@t.dev`);
  });
  it('rejects a suspended user token', async () => {
    expect(await verifyApiToken(`Bearer ${suspendedToken}`)).toBeNull();
  });
});

describe('reconcileAdminRole', () => {
  it('promotes an allowlisted email', async () => {
    const u = await db.user.create({ data: { email: `boss-${stamp}@t.dev`, passwordHash: 'x' } });
    process.env.ADMIN_EMAILS = `boss-${stamp}@t.dev`;
    await reconcileAdminRole(u);
    const after = await db.user.findUnique({ where: { id: u.id } });
    expect(after?.role).toBe('admin');
  });
  it('leaves a non-allowlisted user as user', async () => {
    const u = await db.user.create({ data: { email: `plain-${stamp}@t.dev`, passwordHash: 'x' } });
    process.env.ADMIN_EMAILS = `someone-else@t.dev`;
    await reconcileAdminRole(u);
    const after = await db.user.findUnique({ where: { id: u.id } });
    expect(after?.role).toBe('user');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/integration/auth-status.test.ts`
Expected: FAIL — `verifyApiToken` still returns the suspended user (rejection assertion fails).

- [ ] **Step 3: Reject suspended users in `verifyApiToken`**

In `src/lib/auth/tokens.ts`, replace the final `return record.user;` (line ~47) with:

```ts
  if (record.user.status === 'suspended') return null;
  return record.user;
```

- [ ] **Step 4: Drop suspended users in `getCurrentUser`**

Replace the body of `src/lib/auth/current-user.ts` with:

```ts
import 'server-only';
import { cache } from 'react';
import { db } from '@/lib/db';
import { getSessionUserId } from './session';
import { activeUserOrNull } from './admin-policy';

export const getCurrentUser = cache(async () => {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, createdAt: true, role: true, status: true },
  });
  return activeUserOrNull(user);
});

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
```

- [ ] **Step 5: Wire login/signup**

In `src/lib/auth/actions.ts`:

Add the import near the top:

```ts
import { reconcileAdminRole } from './admin';
```

In `loginAction`, after the failed-credentials check and before `await createSession(user.id);`, insert:

```ts
  if (user.status === 'suspended') return { error: 'This account has been suspended.' };
```

Then change the success tail of `loginAction` to reconcile before redirecting:

```ts
  await createSession(user.id);
  await reconcileAdminRole(user);
  redirect(safeRelativePath(formData.get('next')) ?? '/app');
```

In `signupAction`, change the tail to:

```ts
  await createSession(user.id);
  await reconcileAdminRole(user);
  redirect(safeRelativePath(formData.get('next')) ?? '/app');
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run tests/integration/auth-status.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Full typecheck + suite + commit**

Run: `pnpm exec tsc --noEmit` → No errors.
Run: `pnpm test` → all green (existing + new).

```bash
git add src/lib/auth/current-user.ts src/lib/auth/tokens.ts src/lib/auth/actions.ts tests/integration/auth-status.test.ts
git commit -m "feat: deny suspended accounts via session and api token; reconcile admin role on auth"
```

---

# PHASE 2 — Admin shell + system overview

### Task 4: Admin chrome + layout gate

**Files:**
- Create: `src/components/admin/AdminSidebar.tsx`
- Create: `src/components/admin/AdminChrome.tsx`
- Create: `src/app/admin/layout.tsx`

(No unit test — UI shell. Verified by tsc/build and manual nav.)

- [ ] **Step 1: AdminSidebar**

Create `src/components/admin/AdminSidebar.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Users, Building2, Plug, Brain, Tags, ArrowLeft, type LucideIcon } from 'lucide-react';

type NavItem = { label: string; href: string; icon: LucideIcon; exact?: boolean };

const ITEMS: NavItem[] = [
  { label: 'Overview', href: '/admin', icon: LayoutDashboard, exact: true },
  { label: 'Users', href: '/admin/users', icon: Users },
  { label: 'Workspaces', href: '/admin/workspaces', icon: Building2 },
  { label: 'ToolPlane', href: '/admin/servers', icon: Plug },
  { label: 'Skills Market', href: '/admin/skills', icon: Brain },
  { label: 'Categories', href: '/admin/categories', icon: Tags },
];

export function AdminSidebar() {
  const pathname = usePathname() ?? '';
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 lg:sticky lg:top-0 lg:flex lg:h-dvh dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2 px-5 py-5">
        <span className="rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">Admin</span>
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">MCP Station</span>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
        {ITEMS.map((item) => {
          const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + '/');
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                active
                  ? 'bg-zinc-200/70 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                  : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-100'
              }`}
            >
              <Icon className="size-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <Link href="/app" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
          <ArrowLeft className="size-4" /> Back to app
        </Link>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: AdminChrome**

Create `src/components/admin/AdminChrome.tsx`:

```tsx
import type { ReactNode } from 'react';
import { AdminSidebar } from './AdminSidebar';

export function AdminChrome({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <AdminSidebar />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
```

- [ ] **Step 3: Layout gate**

Create `src/app/admin/layout.tsx`:

```tsx
import { requireAdmin } from '@/lib/auth/admin';
import { AdminChrome } from '@/components/admin/AdminChrome';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return <AdminChrome>{children}</AdminChrome>;
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm exec tsc --noEmit` → No errors.

```bash
git add src/components/admin/AdminSidebar.tsx src/components/admin/AdminChrome.tsx src/app/admin/layout.tsx
git commit -m "feat: admin route group shell gated by requireAdmin"
```

---

### Task 5: System overview query

**Files:**
- Create: `src/lib/admin/overview.ts`
- Test: `tests/integration/admin-overview.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/admin-overview.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/lib/db';
import { getSystemOverview } from '@/lib/admin/overview';

const stamp = Date.now();

beforeAll(async () => {
  const u = await db.user.create({ data: { email: `ov-${stamp}@t.dev`, passwordHash: 'x' } });
  const ws = await db.workspace.create({
    data: { slug: `ov-${stamp}`, name: 'OV', ownerId: u.id, members: { create: { userId: u.id, role: 'owner' } } },
  });
  await db.requestLog.create({
    data: { workspaceId: ws.id, method: 'POST', path: '/x', statusCode: 200, durationMs: 10 },
  });
  await db.requestLog.create({
    data: { workspaceId: ws.id, method: 'POST', path: '/x', statusCode: 500, durationMs: 20 },
  });
});

describe('getSystemOverview', () => {
  it('returns counts and 24h request aggregates', async () => {
    const o = await getSystemOverview();
    expect(o.counts.users).toBeGreaterThan(0);
    expect(o.counts.workspaces).toBeGreaterThan(0);
    expect(o.requests.total).toBeGreaterThanOrEqual(2);
    expect(o.requests.errors).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(o.scraper)).toBe(true);
    expect(Array.isArray(o.recentUsers)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/integration/admin-overview.test.ts`
Expected: FAIL — cannot find `@/lib/admin/overview`.

- [ ] **Step 3: Implement the query**

Create `src/lib/admin/overview.ts`:

```ts
import 'server-only';
import { db } from '@/lib/db';

export async function getSystemOverview() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    users, admins, suspended, newUsers7d,
    workspaces, agents, toolkits, installedSkills, providers,
    servers, skills, clients,
    deploymentGroups, logs, scraper, recentUsers,
  ] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { role: 'admin' } }),
    db.user.count({ where: { status: 'suspended' } }),
    db.user.count({ where: { createdAt: { gte: since7d } } }),
    db.workspace.count(),
    db.agent.count(),
    db.toolkit.count(),
    db.installedSkill.count(),
    db.modelProvider.count(),
    db.server.count(),
    db.skill.count(),
    db.client.count(),
    db.deployment.groupBy({ by: ['status'], _count: { _all: true } }),
    db.requestLog.findMany({
      where: { createdAt: { gte: since24h } },
      select: { statusCode: true, durationMs: true },
    }),
    db.scrapeCheckpoint.findMany({ orderBy: { updatedAt: 'desc' } }),
    db.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, email: true, name: true, role: true, status: true, createdAt: true },
    }),
  ]);

  const total = logs.length;
  const errors = logs.filter((l) => l.statusCode >= 400).length;
  const avgMs = total === 0 ? 0 : Math.round(logs.reduce((a, l) => a + l.durationMs, 0) / total);
  const sortedMs = logs.map((l) => l.durationMs).sort((a, b) => a - b);
  const p95Ms = total === 0 ? 0 : sortedMs[Math.min(total - 1, Math.ceil(total * 0.95) - 1)];

  const deployments: Record<string, number> = {};
  for (const g of deploymentGroups) deployments[g.status] = g._count._all;

  return {
    counts: {
      users, admins, suspended, newUsers7d,
      workspaces, agents, toolkits, installedSkills, providers,
      servers, skills, clients, deployments,
    },
    requests: { total, errors, avgMs, p95Ms },
    scraper,
    recentUsers,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/integration/admin-overview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin/overview.ts tests/integration/admin-overview.test.ts
git commit -m "feat: system overview aggregation query"
```

---

### Task 6: Overview page

**Files:**
- Create: `src/app/admin/page.tsx`

(No unit test — RSC page over the tested query.)

- [ ] **Step 1: Implement the page**

Create `src/app/admin/page.tsx`:

```tsx
import { requireAdmin } from '@/lib/auth/admin';
import { getSystemOverview } from '@/lib/admin/overview';

export const dynamic = 'force-dynamic';

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</p>
    </div>
  );
}

export default async function AdminOverviewPage() {
  await requireAdmin();
  const o = await getSystemOverview();
  const deployTotal = Object.values(o.counts.deployments).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">System overview</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Users" value={o.counts.users} />
        <Stat label="Admins" value={o.counts.admins} />
        <Stat label="Suspended" value={o.counts.suspended} />
        <Stat label="New (7d)" value={o.counts.newUsers7d} />
        <Stat label="Workspaces" value={o.counts.workspaces} />
        <Stat label="Deployments" value={deployTotal} />
        <Stat label="Agents" value={o.counts.agents} />
        <Stat label="Toolkits" value={o.counts.toolkits} />
        <Stat label="Directory servers" value={o.counts.servers} />
        <Stat label="Directory skills" value={o.counts.skills} />
        <Stat label="Requests (24h)" value={o.requests.total} />
        <Stat label="Errors (24h)" value={o.requests.errors} />
        <Stat label="p95 ms (24h)" value={o.requests.p95Ms} />
        <Stat label="Installed skills" value={o.counts.installedSkills} />
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Recent signups</h2>
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {o.recentUsers.map((u) => (
            <li key={u.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="text-zinc-700 dark:text-zinc-300">{u.name ?? u.email}</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {u.role === 'admin' ? 'admin · ' : ''}{u.status === 'suspended' ? 'suspended · ' : ''}
                {new Date(u.createdAt).toLocaleDateString('en-US')}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Scraper jobs</h2>
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {o.scraper.length === 0 ? (
            <li className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">No scraper runs recorded.</li>
          ) : o.scraper.map((s) => (
            <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="font-mono text-zinc-700 dark:text-zinc-300">{s.job}</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {s.doneCount} done · {new Date(s.updatedAt).toLocaleString('en-US')}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm exec tsc --noEmit` → No errors.

```bash
git add src/app/admin/page.tsx
git commit -m "feat: admin system overview page"
```

---

### Task 7: Optional Admin entry in the console

**Files:**
- Modify: `src/app/app/[workspace]/layout.tsx`
- Modify: `src/components/dashboard/DashboardChrome.tsx`
- Modify: `src/components/dashboard/DashboardSidebar.tsx`

- [ ] **Step 1: Thread `isAdmin` from the layout**

In `src/app/app/[workspace]/layout.tsx`, pass `isAdmin` to the chrome by changing the `<DashboardChrome …>` opening tag to include:

```tsx
      isAdmin={user.role === 'admin'}
```

- [ ] **Step 2: Accept and forward it in DashboardChrome**

In `src/components/dashboard/DashboardChrome.tsx`, add `isAdmin` to the prop type and destructuring (default `false`), and pass it into `<DashboardSidebar … />`:

```tsx
  isAdmin = false,
```
add to the type block:
```tsx
  isAdmin?: boolean;
```
and on the `<DashboardSidebar` element add the prop:
```tsx
        isAdmin={isAdmin}
```

- [ ] **Step 3: Render the link in DashboardSidebar**

In `src/components/dashboard/DashboardSidebar.tsx`:

Add `Shield` to the lucide import list. Add `isAdmin` to the props type (`isAdmin?: boolean;`) and destructuring (`isAdmin = false,`). Then in the footer `<div className="space-y-2 border-t …">`, immediately after the `Sell Skills` `<Link>`, add:

```tsx
        {isAdmin ? (
          <Link
            href="/admin"
            onClick={onClose}
            className="flex items-center justify-center gap-2 rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            <Shield className="size-4" />
            Admin console
          </Link>
        ) : null}
```

- [ ] **Step 4: Typecheck + build + commit**

Run: `pnpm exec tsc --noEmit` → No errors.
Run: `pnpm build` → Compiled successfully.

```bash
git add src/app/app/[workspace]/layout.tsx src/components/dashboard/DashboardChrome.tsx src/components/dashboard/DashboardSidebar.tsx
git commit -m "feat: show admin console link in console for admins"
```

---

# PHASE 3 — Users & workspaces management

### Task 8: Shared workspace teardown helper

**Files:**
- Create: `src/lib/workspace/teardown.ts`
- Modify: `src/lib/workspace/actions.ts`
- Test: `tests/integration/workspace-teardown.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/workspace-teardown.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/lib/db';
import { workspaceDeploymentIds } from '@/lib/workspace/teardown';

const stamp = Date.now();
let wsId = '';
let depId = '';

beforeAll(async () => {
  const u = await db.user.create({ data: { email: `td-${stamp}@t.dev`, passwordHash: 'x' } });
  const ws = await db.workspace.create({
    data: { slug: `td-${stamp}`, name: 'TD', ownerId: u.id, members: { create: { userId: u.id, role: 'owner' } } },
  });
  wsId = ws.id;
  const dep = await db.deployment.create({ data: { workspaceId: ws.id, source: 'npm', sourceRef: 'x', status: 'stopped' } });
  depId = dep.id;
});

describe('workspaceDeploymentIds', () => {
  it('returns the ids of the workspace deployments', async () => {
    expect(await workspaceDeploymentIds(wsId)).toEqual([depId]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/integration/workspace-teardown.test.ts`
Expected: FAIL — cannot find `@/lib/workspace/teardown`.

- [ ] **Step 3: Implement the helper**

Create `src/lib/workspace/teardown.ts`:

```ts
import 'server-only';
import { db } from '@/lib/db';
import { killMany } from '@/lib/process/supervisor';

export async function workspaceDeploymentIds(workspaceId: string): Promise<string[]> {
  const rows = await db.deployment.findMany({ where: { workspaceId }, select: { id: true } });
  return rows.map((d) => d.id);
}

// Kill any running MCP child processes for a workspace before it is deleted,
// so no orphaned processes are leaked.
export async function killWorkspaceProcesses(workspaceId: string): Promise<void> {
  killMany(await workspaceDeploymentIds(workspaceId));
}
```

- [ ] **Step 4: Refactor the owner delete to reuse it**

In `src/lib/workspace/actions.ts`:

Add to the imports from supervisor — remove `killMany` from that import if it's now only used here (keep `startProcess, stopProcess, restartProcess, killProcess` as still used; check usages with `grep -n killMany src/lib/workspace/actions.ts`). Add:

```ts
import { killWorkspaceProcesses } from '@/lib/workspace/teardown';
```

Replace the teardown block inside `deleteWorkspaceAction` (the `const deployments = …findMany…; killMany(…)` lines) with:

```ts
  await killWorkspaceProcesses(ctx.ws.id);
```

- [ ] **Step 5: Run the test + typecheck**

Run: `pnpm vitest run tests/integration/workspace-teardown.test.ts` → PASS.
Run: `pnpm exec tsc --noEmit` → No errors (if `killMany` is now unused in actions.ts, remove it from the import to satisfy lint).

- [ ] **Step 6: Commit**

```bash
git add src/lib/workspace/teardown.ts src/lib/workspace/actions.ts tests/integration/workspace-teardown.test.ts
git commit -m "refactor: extract killWorkspaceProcesses teardown helper"
```

---

### Task 9: Admin user queries + pure mutations

**Files:**
- Create: `src/lib/admin/users.ts`
- Test: `tests/integration/admin-users.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/admin-users.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/lib/db';
import { listUsers, setUserRole, setUserStatus, deleteManagedUser } from '@/lib/admin/users';

const stamp = Date.now();
let adminId = '';
let targetId = '';

beforeAll(async () => {
  const admin = await db.user.create({ data: { email: `au-admin-${stamp}@t.dev`, passwordHash: 'x', role: 'admin' } });
  const target = await db.user.create({ data: { email: `au-tgt-${stamp}@t.dev`, passwordHash: 'x' } });
  adminId = admin.id;
  targetId = target.id;
});

describe('admin user mutations', () => {
  it('promotes and demotes a user', async () => {
    await setUserRole(adminId, targetId, 'admin');
    expect((await db.user.findUnique({ where: { id: targetId } }))?.role).toBe('admin');
    await setUserRole(adminId, targetId, 'user');
    expect((await db.user.findUnique({ where: { id: targetId } }))?.role).toBe('user');
  });

  it('suspends and reactivates a user', async () => {
    await setUserStatus(adminId, targetId, 'suspended');
    expect((await db.user.findUnique({ where: { id: targetId } }))?.status).toBe('suspended');
    await setUserStatus(adminId, targetId, 'active');
  });

  it('refuses to act on self', async () => {
    await expect(setUserRole(adminId, adminId, 'user')).rejects.toThrow(/yourself/i);
    await expect(setUserStatus(adminId, adminId, 'suspended')).rejects.toThrow(/yourself/i);
    await expect(deleteManagedUser(adminId, adminId)).rejects.toThrow(/yourself/i);
  });

  it('lists users with counts and search', async () => {
    const res = await listUsers({ page: 1, q: `au-tgt-${stamp}` });
    expect(res.items.some((u) => u.id === targetId)).toBe(true);
    expect(res.items[0]).toHaveProperty('_count');
  });

  it('deletes a managed user', async () => {
    const victim = await db.user.create({ data: { email: `au-del-${stamp}@t.dev`, passwordHash: 'x' } });
    await deleteManagedUser(adminId, victim.id);
    expect(await db.user.findUnique({ where: { id: victim.id } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/integration/admin-users.test.ts`
Expected: FAIL — cannot find `@/lib/admin/users`.

- [ ] **Step 3: Implement queries + mutations**

Create `src/lib/admin/users.ts`:

```ts
import 'server-only';
import { db } from '@/lib/db';
import { killWorkspaceProcesses } from '@/lib/workspace/teardown';

const PAGE_SIZE = 25;

export async function listUsers({ page = 1, q = '' }: { page?: number; q?: string }) {
  const where = q
    ? { OR: [{ email: { contains: q, mode: 'insensitive' as const } }, { name: { contains: q, mode: 'insensitive' as const } }] }
    : {};
  const skip = (Math.max(1, page) - 1) * PAGE_SIZE;
  const [items, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: PAGE_SIZE,
      select: {
        id: true, email: true, name: true, role: true, status: true, createdAt: true,
        _count: { select: { ownedWorkspaces: true, memberships: true, apiTokens: true } },
      },
    }),
    db.user.count({ where }),
  ]);
  return { items, total, page: Math.max(1, page), pageSize: PAGE_SIZE };
}

export async function getUserDetail(id: string) {
  return db.user.findUnique({
    where: { id },
    select: {
      id: true, email: true, name: true, role: true, status: true, createdAt: true,
      ownedWorkspaces: { select: { id: true, slug: true, name: true } },
      memberships: { select: { role: true, workspace: { select: { id: true, slug: true, name: true } } } },
    },
  });
}

function refuseSelf(actingUserId: string, userId: string) {
  if (actingUserId === userId) throw new Error("You can't change yourself.");
}

export async function setUserRole(actingUserId: string, userId: string, role: 'user' | 'admin') {
  refuseSelf(actingUserId, userId);
  await db.user.update({ where: { id: userId }, data: { role } });
}

export async function setUserStatus(actingUserId: string, userId: string, status: 'active' | 'suspended') {
  refuseSelf(actingUserId, userId);
  await db.user.update({ where: { id: userId }, data: { status } });
}

export async function deleteManagedUser(actingUserId: string, userId: string) {
  refuseSelf(actingUserId, userId);
  const workspaces = await db.workspace.findMany({ where: { ownerId: userId }, select: { id: true } });
  for (const ws of workspaces) await killWorkspaceProcesses(ws.id);
  await db.user.delete({ where: { id: userId } });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/integration/admin-users.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin/users.ts tests/integration/admin-users.test.ts
git commit -m "feat: admin user queries and self-guarded mutations"
```

---

### Task 10: Admin user server actions

**Files:**
- Create: `src/lib/admin/user-actions.ts`

(No unit test — thin `requireAdmin` wrappers over Task 9.)

- [ ] **Step 1: Implement the action wrappers**

Create `src/lib/admin/user-actions.ts`:

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/admin';
import { setUserRole, setUserStatus, deleteManagedUser } from '@/lib/admin/users';

export type AdminActionState = { error?: string };

export async function setUserRoleAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const userId = String(formData.get('userId') ?? '');
  const role = String(formData.get('role') ?? '') === 'admin' ? 'admin' : 'user';
  try {
    await setUserRole(admin.id, userId, role);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed.' };
  }
  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${userId}`);
  return {};
}

export async function setUserStatusAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const userId = String(formData.get('userId') ?? '');
  const status = String(formData.get('status') ?? '') === 'suspended' ? 'suspended' : 'active';
  try {
    await setUserStatus(admin.id, userId, status);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed.' };
  }
  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${userId}`);
  return {};
}

export async function deleteUserAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const userId = String(formData.get('userId') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  const email = String(formData.get('email') ?? '');
  if (confirm !== email) return { error: 'Type the email to confirm deletion.' };
  try {
    await deleteManagedUser(admin.id, userId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed.' };
  }
  revalidatePath('/admin/users');
  return {};
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm exec tsc --noEmit` → No errors.

```bash
git add src/lib/admin/user-actions.ts
git commit -m "feat: admin user server actions"
```

---

### Task 11: ConfirmDialog + Users pages

**Files:**
- Create: `src/components/admin/ConfirmDialog.tsx`
- Create: `src/app/admin/users/page.tsx`
- Create: `src/app/admin/users/[id]/page.tsx`

- [ ] **Step 1: ConfirmDialog (typed confirmation)**

Create `src/components/admin/ConfirmDialog.tsx`:

```tsx
'use client';

import { useActionState, useState } from 'react';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import type { AdminActionState } from '@/lib/admin/user-actions';

// A two-step destructive button. Reveals a form on click; the form posts to a
// useActionState action. When `confirmWord` is set, the user must type it.
export function ConfirmDialog({
  label,
  prompt,
  action,
  hidden,
  confirmWord,
  pendingLabel,
}: {
  label: string;
  prompt: string;
  action: (prev: AdminActionState, fd: FormData) => Promise<AdminActionState>;
  hidden: Record<string, string>;
  confirmWord?: string;
  pendingLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<AdminActionState, FormData>(action, {});

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-8 items-center rounded-md border border-red-200 px-2.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-950/30"
      >
        {label}
      </button>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <span className="text-xs text-zinc-600 dark:text-zinc-300">{prompt}</span>
      {confirmWord ? (
        <input
          name="confirm"
          placeholder={confirmWord}
          className="h-8 rounded-md border border-zinc-200 px-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        />
      ) : null}
      <SubmitButton
        error={state.error}
        flash={false}
        pendingLabel={pendingLabel ?? 'Working…'}
        className="inline-flex h-8 items-center rounded-md bg-red-600 px-2.5 text-xs font-medium text-white hover:bg-red-700"
      >
        Confirm
      </SubmitButton>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        Cancel
      </button>
      {state.error ? <span className="text-xs text-red-600" role="alert">{state.error}</span> : null}
    </form>
  );
}
```

- [ ] **Step 2: Users list page**

Create `src/app/admin/users/page.tsx`:

```tsx
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/admin';
import { listUsers } from '@/lib/admin/users';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requireAdmin();
  const { q = '', page = '1' } = await searchParams;
  const { items, total, pageSize } = await listUsers({ page: Number(page) || 1, q });

  return (
    <div className="space-y-4 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Users <span className="text-base font-normal text-zinc-500">({total})</span></h1>
      <form className="flex gap-2">
        <input name="q" defaultValue={q} placeholder="Search email or name…" className="h-9 w-72 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        <button className="h-9 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700">Search</button>
      </form>
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {items.map((u) => (
          <li key={u.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <Link href={`/admin/users/${u.id}`} className="min-w-0">
              <span className="block truncate text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100">{u.name ?? u.email}</span>
              <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{u.email} · {u._count.ownedWorkspaces} ws · {u._count.apiTokens} tokens</span>
            </Link>
            <div className="flex shrink-0 items-center gap-1.5">
              {u.role === 'admin' ? <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-700 dark:bg-red-500/15 dark:text-red-300">admin</span> : null}
              {u.status === 'suspended' ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">suspended</span> : null}
            </div>
          </li>
        ))}
      </ul>
      <Pagination total={total} page={Number(page) || 1} pageSize={pageSize} q={q} />
    </div>
  );
}

function Pagination({ total, page, pageSize, q }: { total: number; page: number; pageSize: number; q: string }) {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return null;
  const qs = (p: number) => `?q=${encodeURIComponent(q)}&page=${p}`;
  return (
    <div className="flex items-center gap-2 text-sm">
      {page > 1 ? <Link href={qs(page - 1)} className="rounded-md border border-zinc-200 px-3 py-1 dark:border-zinc-700">Prev</Link> : null}
      <span className="text-zinc-500">Page {page} / {pages}</span>
      {page < pages ? <Link href={qs(page + 1)} className="rounded-md border border-zinc-200 px-3 py-1 dark:border-zinc-700">Next</Link> : null}
    </div>
  );
}
```

- [ ] **Step 3: User detail page**

Create `src/app/admin/users/[id]/page.tsx`:

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/admin';
import { getUserDetail } from '@/lib/admin/users';
import { setUserRoleAction, setUserStatusAction, deleteUserAction } from '@/lib/admin/user-actions';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';

export const dynamic = 'force-dynamic';

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  const { id } = await params;
  const u = await getUserDetail(id);
  if (!u) notFound();
  const isSelf = admin.id === u.id;

  return (
    <div className="max-w-2xl space-y-6 px-8 py-6">
      <Link href="/admin/users" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">← Users</Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{u.name ?? u.email}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{u.email} · joined {new Date(u.createdAt).toLocaleDateString('en-US')}</p>
      </div>

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Access</h2>
        {isSelf ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">You can’t change your own role or status.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <ConfirmDialog
              label={u.role === 'admin' ? 'Demote to user' : 'Promote to admin'}
              prompt={u.role === 'admin' ? 'Remove admin?' : 'Grant admin?'}
              action={setUserRoleAction}
              hidden={{ userId: u.id, role: u.role === 'admin' ? 'user' : 'admin' }}
              pendingLabel="Saving…"
            />
            <ConfirmDialog
              label={u.status === 'suspended' ? 'Reactivate' : 'Suspend'}
              prompt={u.status === 'suspended' ? 'Reactivate this account?' : 'Suspend this account?'}
              action={setUserStatusAction}
              hidden={{ userId: u.id, status: u.status === 'suspended' ? 'active' : 'suspended' }}
              pendingLabel="Saving…"
            />
          </div>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Owned workspaces</h2>
        <ul className="space-y-1 text-sm">
          {u.ownedWorkspaces.map((w) => (
            <li key={w.id}><Link href={`/admin/workspaces/${w.id}`} className="text-zinc-700 hover:underline dark:text-zinc-300">{w.name}</Link> <span className="text-zinc-400">/{w.slug}</span></li>
          ))}
          {u.ownedWorkspaces.length === 0 ? <li className="text-zinc-500">None</li> : null}
        </ul>
      </section>

      {!isSelf ? (
        <section className="rounded-lg border border-red-200 p-4 dark:border-red-500/30">
          <h2 className="mb-1 text-sm font-semibold text-red-700 dark:text-red-400">Danger zone</h2>
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">Deleting cascades to all owned workspaces, deployments, and agents.</p>
          <ConfirmDialog
            label="Delete user"
            prompt={`Type ${u.email} to confirm:`}
            action={deleteUserAction}
            hidden={{ userId: u.id, email: u.email }}
            confirmWord={u.email}
            pendingLabel="Deleting…"
          />
        </section>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + build + commit**

Run: `pnpm exec tsc --noEmit` → No errors.
Run: `pnpm build` → Compiled successfully.

```bash
git add src/components/admin/ConfirmDialog.tsx src/app/admin/users
git commit -m "feat: admin users list and detail pages"
```

---

### Task 12: Admin workspace queries + delete action

**Files:**
- Create: `src/lib/admin/workspaces.ts`
- Create: `src/lib/admin/workspace-actions.ts`
- Test: `tests/integration/admin-workspaces.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/admin-workspaces.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/lib/db';
import { listWorkspaces, deleteManagedWorkspace } from '@/lib/admin/workspaces';

const stamp = Date.now();
let wsId = '';

beforeAll(async () => {
  const u = await db.user.create({ data: { email: `aw-${stamp}@t.dev`, passwordHash: 'x' } });
  const ws = await db.workspace.create({
    data: { slug: `aw-${stamp}`, name: 'AW', ownerId: u.id, members: { create: { userId: u.id, role: 'owner' } } },
  });
  wsId = ws.id;
});

describe('admin workspaces', () => {
  it('lists workspaces with owner + counts', async () => {
    const res = await listWorkspaces({ page: 1, q: `aw-${stamp}` });
    const row = res.items.find((w) => w.id === wsId);
    expect(row?.owner.email).toBe(`aw-${stamp}@t.dev`);
    expect(row?._count.members).toBe(1);
  });
  it('deletes a workspace', async () => {
    await deleteManagedWorkspace(wsId);
    expect(await db.workspace.findUnique({ where: { id: wsId } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/integration/admin-workspaces.test.ts`
Expected: FAIL — cannot find `@/lib/admin/workspaces`.

- [ ] **Step 3: Implement queries + delete**

Create `src/lib/admin/workspaces.ts`:

```ts
import 'server-only';
import { db } from '@/lib/db';
import { killWorkspaceProcesses } from '@/lib/workspace/teardown';

const PAGE_SIZE = 25;

export async function listWorkspaces({ page = 1, q = '' }: { page?: number; q?: string }) {
  const where = q
    ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { slug: { contains: q, mode: 'insensitive' as const } }] }
    : {};
  const skip = (Math.max(1, page) - 1) * PAGE_SIZE;
  const [items, total] = await Promise.all([
    db.workspace.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: PAGE_SIZE,
      select: {
        id: true, slug: true, name: true, createdAt: true,
        owner: { select: { id: true, email: true } },
        _count: { select: { members: true, deployments: true, agents: true } },
      },
    }),
    db.workspace.count({ where }),
  ]);
  return { items, total, page: Math.max(1, page), pageSize: PAGE_SIZE };
}

export async function getWorkspaceDetail(id: string) {
  return db.workspace.findUnique({
    where: { id },
    select: {
      id: true, slug: true, name: true, createdAt: true,
      owner: { select: { id: true, email: true } },
      members: { select: { role: true, user: { select: { id: true, email: true } } } },
      deployments: { select: { id: true, name: true, source: true, status: true } },
    },
  });
}

export async function deleteManagedWorkspace(workspaceId: string) {
  await killWorkspaceProcesses(workspaceId);
  await db.workspace.delete({ where: { id: workspaceId } });
}
```

- [ ] **Step 4: Run the test + implement the action**

Run: `pnpm vitest run tests/integration/admin-workspaces.test.ts` → PASS.

Create `src/lib/admin/workspace-actions.ts`:

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/admin';
import { deleteManagedWorkspace } from '@/lib/admin/workspaces';
import type { AdminActionState } from '@/lib/admin/user-actions';

export async function deleteWorkspaceAdminAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const workspaceId = String(formData.get('workspaceId') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  const slug = String(formData.get('slug') ?? '');
  if (confirm !== slug) return { error: 'Type the slug to confirm.' };
  await deleteManagedWorkspace(workspaceId);
  revalidatePath('/admin/workspaces');
  return {};
}
```

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm exec tsc --noEmit` → No errors.

```bash
git add src/lib/admin/workspaces.ts src/lib/admin/workspace-actions.ts tests/integration/admin-workspaces.test.ts
git commit -m "feat: admin workspace queries and delete action"
```

---

### Task 13: Workspaces pages

**Files:**
- Create: `src/app/admin/workspaces/page.tsx`
- Create: `src/app/admin/workspaces/[id]/page.tsx`

- [ ] **Step 1: List page**

Create `src/app/admin/workspaces/page.tsx`:

```tsx
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/admin';
import { listWorkspaces } from '@/lib/admin/workspaces';

export const dynamic = 'force-dynamic';

export default async function AdminWorkspacesPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requireAdmin();
  const { q = '', page = '1' } = await searchParams;
  const { items, total } = await listWorkspaces({ page: Number(page) || 1, q });

  return (
    <div className="space-y-4 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Workspaces <span className="text-base font-normal text-zinc-500">({total})</span></h1>
      <form className="flex gap-2">
        <input name="q" defaultValue={q} placeholder="Search name or slug…" className="h-9 w-72 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        <button className="h-9 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700">Search</button>
      </form>
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {items.map((w) => (
          <li key={w.id} className="flex items-center justify-between px-4 py-2.5">
            <Link href={`/admin/workspaces/${w.id}`} className="min-w-0">
              <span className="block truncate text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100">{w.name} <span className="text-zinc-400">/{w.slug}</span></span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{w.owner.email} · {w._count.members} members · {w._count.deployments} deployments</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Detail page with admin delete**

Create `src/app/admin/workspaces/[id]/page.tsx`:

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/admin';
import { getWorkspaceDetail } from '@/lib/admin/workspaces';
import { deleteWorkspaceAdminAction } from '@/lib/admin/workspace-actions';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';

export const dynamic = 'force-dynamic';

export default async function AdminWorkspaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const w = await getWorkspaceDetail(id);
  if (!w) notFound();

  return (
    <div className="max-w-2xl space-y-6 px-8 py-6">
      <Link href="/admin/workspaces" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">← Workspaces</Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{w.name} <span className="text-base font-normal text-zinc-400">/{w.slug}</span></h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">owner {w.owner.email} · created {new Date(w.createdAt).toLocaleDateString('en-US')}</p>
      </div>

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Members</h2>
        <ul className="space-y-1 text-sm">
          {w.members.map((m) => <li key={m.user.id} className="text-zinc-700 dark:text-zinc-300">{m.user.email} <span className="text-zinc-400">· {m.role}</span></li>)}
        </ul>
      </section>

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Deployments ({w.deployments.length})</h2>
        <ul className="space-y-1 text-sm">
          {w.deployments.map((d) => <li key={d.id} className="text-zinc-700 dark:text-zinc-300">{d.name ?? d.source ?? d.id} <span className="text-zinc-400">· {d.status}</span></li>)}
          {w.deployments.length === 0 ? <li className="text-zinc-500">None</li> : null}
        </ul>
      </section>

      <section className="rounded-lg border border-red-200 p-4 dark:border-red-500/30">
        <h2 className="mb-1 text-sm font-semibold text-red-700 dark:text-red-400">Danger zone</h2>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">Stops all MCP processes and deletes the workspace and everything in it.</p>
        <ConfirmDialog
          label="Delete workspace"
          prompt={`Type ${w.slug} to confirm:`}
          action={deleteWorkspaceAdminAction}
          hidden={{ workspaceId: w.id, slug: w.slug }}
          confirmWord={w.slug}
          pendingLabel="Deleting…"
        />
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + build + commit**

Run: `pnpm exec tsc --noEmit` → No errors. Run: `pnpm build` → Compiled successfully.

```bash
git add src/app/admin/workspaces
git commit -m "feat: admin workspaces list and detail pages"
```

---

# PHASE 4 — MCP & Skills market management

### Task 14: Categories (queries + actions + page)

**Files:**
- Create: `src/lib/admin/categories.ts`
- Create: `src/lib/admin/category-actions.ts`
- Create: `src/app/admin/categories/page.tsx`
- Test: `tests/integration/admin-categories.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/admin-categories.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/db';
import { listCategories, createCategory, deleteCategory } from '@/lib/admin/categories';

const stamp = Date.now();

describe('admin categories', () => {
  it('creates, lists, and deletes an empty category', async () => {
    const c = await createCategory(`cat-${stamp}`, `Cat ${stamp}`);
    const list = await listCategories();
    expect(list.some((x) => x.id === c.id)).toBe(true);
    await deleteCategory(c.id);
    expect(await db.category.findUnique({ where: { id: c.id } })).toBeNull();
  });

  it('refuses to delete a non-empty category', async () => {
    const c = await createCategory(`catx-${stamp}`, `CatX ${stamp}`);
    await db.skill.create({ data: { slug: `cs-${stamp}`, name: 'cs', categories: { connect: { id: c.id } } } });
    await expect(deleteCategory(c.id)).rejects.toThrow(/not empty/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/integration/admin-categories.test.ts`
Expected: FAIL — cannot find `@/lib/admin/categories`.

- [ ] **Step 3: Implement queries + mutations**

Create `src/lib/admin/categories.ts`:

```ts
import 'server-only';
import { db } from '@/lib/db';

export function listCategories() {
  return db.category.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, slug: true, name: true, _count: { select: { servers: true, skills: true, clients: true } } },
  });
}

export async function createCategory(slug: string, name: string) {
  return db.category.create({ data: { slug, name } });
}

export async function deleteCategory(id: string) {
  const c = await db.category.findUnique({
    where: { id },
    select: { _count: { select: { servers: true, skills: true, clients: true } } },
  });
  if (!c) throw new Error('Category not found.');
  if (c._count.servers + c._count.skills + c._count.clients > 0) throw new Error('Category is not empty.');
  await db.category.delete({ where: { id } });
}
```

- [ ] **Step 4: Run the test + implement actions**

Run: `pnpm vitest run tests/integration/admin-categories.test.ts` → PASS.

Create `src/lib/admin/category-actions.ts`:

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/admin';
import { createCategory, deleteCategory } from '@/lib/admin/categories';
import type { AdminActionState } from '@/lib/admin/user-actions';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export async function createCategoryAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim().toLowerCase();
  if (!name || !SLUG_RE.test(slug)) return { error: 'Provide a name and a valid slug (a-z0-9-).' };
  try {
    await createCategory(slug, name);
  } catch {
    return { error: 'A category with that slug already exists.' };
  }
  revalidatePath('/admin/categories');
  return {};
}

export async function deleteCategoryAction(_prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  await requireAdmin();
  try {
    await deleteCategory(String(formData.get('categoryId') ?? ''));
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed.' };
  }
  revalidatePath('/admin/categories');
  return {};
}
```

- [ ] **Step 5: Categories page**

Create `src/app/admin/categories/page.tsx`:

```tsx
import { requireAdmin } from '@/lib/auth/admin';
import { listCategories } from '@/lib/admin/categories';
import { CategoriesPanel } from '@/components/admin/CategoriesPanel';

export const dynamic = 'force-dynamic';

export default async function AdminCategoriesPage() {
  await requireAdmin();
  const categories = await listCategories();
  return (
    <div className="space-y-4 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Categories</h1>
      <CategoriesPanel categories={categories} />
    </div>
  );
}
```

Create `src/components/admin/CategoriesPanel.tsx`:

```tsx
'use client';

import { useActionState } from 'react';
import { createCategoryAction, deleteCategoryAction } from '@/lib/admin/category-actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import type { AdminActionState } from '@/lib/admin/user-actions';

type Row = { id: string; slug: string; name: string; _count: { servers: number; skills: number; clients: number } };

export function CategoriesPanel({ categories }: { categories: Row[] }) {
  const [state, action] = useActionState<AdminActionState, FormData>(createCategoryAction, {});
  const [delState, delAction] = useActionState<AdminActionState, FormData>(deleteCategoryAction, {});
  const input = 'h-9 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900';

  return (
    <>
      <form action={action} className="flex flex-wrap items-end gap-2">
        <input name="name" placeholder="Name" className={input} />
        <input name="slug" placeholder="slug" className={`${input} font-mono`} />
        <SubmitButton error={state.error} pendingLabel="Adding…" savedLabel="Added" className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Add</SubmitButton>
        {state.error ? <span className="text-sm text-red-600" role="alert">{state.error}</span> : null}
      </form>
      {delState.error ? <p className="text-sm text-red-600" role="alert">{delState.error}</p> : null}
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {categories.map((c) => (
          <li key={c.id} className="flex items-center justify-between px-4 py-2 text-sm">
            <span className="text-zinc-700 dark:text-zinc-300">{c.name} <span className="font-mono text-xs text-zinc-400">/{c.slug}</span> <span className="text-xs text-zinc-400">· {c._count.servers + c._count.skills + c._count.clients} items</span></span>
            <form action={delAction}>
              <input type="hidden" name="categoryId" value={c.id} />
              <button className="text-xs text-red-600 hover:underline">Delete</button>
            </form>
          </li>
        ))}
      </ul>
    </>
  );
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm exec tsc --noEmit` → No errors.

```bash
git add src/lib/admin/categories.ts src/lib/admin/category-actions.ts src/app/admin/categories src/components/admin/CategoriesPanel.tsx tests/integration/admin-categories.test.ts
git commit -m "feat: admin categories management"
```

---

### Task 15: Directory server market — queries + mutations

**Files:**
- Create: `src/lib/admin/market.ts`
- Create: `src/lib/admin/market-actions.ts`
- Test: `tests/integration/admin-market.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/admin-market.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/db';
import {
  createDirectoryServer, updateDirectoryServer, deleteDirectoryServer,
  createDirectorySkill, deleteDirectorySkill,
} from '@/lib/admin/market';

const stamp = Date.now();

describe('directory server mutations', () => {
  it('creates a curated server', async () => {
    const s = await createDirectoryServer({ slug: `ms-${stamp}`, name: 'MS', author: null, description: null, iconUrl: null, stars: 5, isOfficial: false, isFeatured: true, categoryIds: [] });
    expect(s.curated).toBe(true);
    expect(s.isFeatured).toBe(true);
  });
  it('update keeps curated true', async () => {
    const s = await db.server.findUnique({ where: { slug: `ms-${stamp}` } });
    const upd = await updateDirectoryServer(s!.id, { name: 'MS2', author: null, description: null, iconUrl: null, stars: 9, isOfficial: true, isFeatured: false, categoryIds: [] });
    expect(upd.name).toBe('MS2');
    expect(upd.curated).toBe(true);
  });
  it('refuses to delete a server with deployments', async () => {
    const s = await db.server.create({ data: { slug: `msd-${stamp}`, name: 'MSD', curated: true } });
    const u = await db.user.create({ data: { email: `msd-${stamp}@t.dev`, passwordHash: 'x' } });
    const ws = await db.workspace.create({ data: { slug: `msd-${stamp}`, name: 'w', ownerId: u.id } });
    await db.deployment.create({ data: { workspaceId: ws.id, serverId: s.id, status: 'stopped' } });
    await expect(deleteDirectoryServer(s.id)).rejects.toThrow(/deployment/i);
  });
  it('deletes a server with no deployments', async () => {
    const s = await db.server.create({ data: { slug: `msok-${stamp}`, name: 'OK', curated: true } });
    await deleteDirectoryServer(s.id);
    expect(await db.server.findUnique({ where: { id: s.id } })).toBeNull();
  });
});

describe('directory skill mutations', () => {
  it('creates curated and refuses delete with installs', async () => {
    const sk = await createDirectorySkill({ slug: `mk-${stamp}`, name: 'MK', author: null, description: null, iconUrl: null, score: 3, categoryIds: [] });
    expect(sk.curated).toBe(true);
    const u = await db.user.create({ data: { email: `mk-${stamp}@t.dev`, passwordHash: 'x' } });
    const ws = await db.workspace.create({ data: { slug: `mk-${stamp}`, name: 'w', ownerId: u.id } });
    await db.installedSkill.create({ data: { workspaceId: ws.id, skillId: sk.id } });
    await expect(deleteDirectorySkill(sk.id)).rejects.toThrow(/install/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/integration/admin-market.test.ts`
Expected: FAIL — cannot find `@/lib/admin/market`.

- [ ] **Step 3: Implement the market module**

Create `src/lib/admin/market.ts`:

```ts
import 'server-only';
import { db } from '@/lib/db';

const PAGE_SIZE = 25;

export type ServerInput = {
  slug: string; name: string; author: string | null; description: string | null;
  iconUrl: string | null; stars: number; isOfficial: boolean; isFeatured: boolean; categoryIds: string[];
};

export type SkillInput = {
  slug: string; name: string; author: string | null; description: string | null;
  iconUrl: string | null; score: number; categoryIds: string[];
};

// ---- Servers ----

export async function listDirectoryServers({ page = 1, q = '' }: { page?: number; q?: string }) {
  const where = q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { slug: { contains: q, mode: 'insensitive' as const } }] } : {};
  const skip = (Math.max(1, page) - 1) * PAGE_SIZE;
  const [items, total] = await Promise.all([
    db.server.findMany({
      where, orderBy: { updatedAt: 'desc' }, skip, take: PAGE_SIZE,
      select: { id: true, slug: true, name: true, stars: true, isOfficial: true, isFeatured: true, curated: true, _count: { select: { deployments: true } } },
    }),
    db.server.count({ where }),
  ]);
  return { items, total, page: Math.max(1, page), pageSize: PAGE_SIZE };
}

export function getDirectoryServer(id: string) {
  return db.server.findUnique({ where: { id }, include: { categories: { select: { id: true } }, _count: { select: { deployments: true } } } });
}

export function createDirectoryServer(input: ServerInput) {
  const { categoryIds, ...rest } = input;
  return db.server.create({ data: { ...rest, curated: true, categories: { connect: categoryIds.map((id) => ({ id })) } } });
}

export function updateDirectoryServer(id: string, input: Omit<ServerInput, 'slug'>) {
  const { categoryIds, ...rest } = input;
  return db.server.update({ where: { id }, data: { ...rest, curated: true, categories: { set: categoryIds.map((cid) => ({ id: cid })) } } });
}

export async function deleteDirectoryServer(id: string) {
  const s = await db.server.findUnique({ where: { id }, select: { _count: { select: { deployments: true } } } });
  if (!s) throw new Error('Server not found.');
  if (s._count.deployments > 0) throw new Error(`Refused: ${s._count.deployments} live deployment(s) reference this server.`);
  await db.server.delete({ where: { id } });
}

// ---- Skills ----

export async function listDirectorySkills({ page = 1, q = '' }: { page?: number; q?: string }) {
  const where = q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { slug: { contains: q, mode: 'insensitive' as const } }] } : {};
  const skip = (Math.max(1, page) - 1) * PAGE_SIZE;
  const [items, total] = await Promise.all([
    db.skill.findMany({
      where, orderBy: { updatedAt: 'desc' }, skip, take: PAGE_SIZE,
      select: { id: true, slug: true, name: true, score: true, curated: true, _count: { select: { installs: true } } },
    }),
    db.skill.count({ where }),
  ]);
  return { items, total, page: Math.max(1, page), pageSize: PAGE_SIZE };
}

export function getDirectorySkill(id: string) {
  return db.skill.findUnique({ where: { id }, include: { categories: { select: { id: true } }, _count: { select: { installs: true } } } });
}

export function createDirectorySkill(input: SkillInput) {
  const { categoryIds, ...rest } = input;
  return db.skill.create({ data: { ...rest, curated: true, categories: { connect: categoryIds.map((id) => ({ id })) } } });
}

export function updateDirectorySkill(id: string, input: Omit<SkillInput, 'slug'>) {
  const { categoryIds, ...rest } = input;
  return db.skill.update({ where: { id }, data: { ...rest, curated: true, categories: { set: categoryIds.map((cid) => ({ id: cid })) } } });
}

export async function deleteDirectorySkill(id: string) {
  const s = await db.skill.findUnique({ where: { id }, select: { _count: { select: { installs: true } } } });
  if (!s) throw new Error('Skill not found.');
  if (s._count.installs > 0) throw new Error(`Refused: ${s._count.installs} workspace install(s) reference this skill.`);
  await db.skill.delete({ where: { id } });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/integration/admin-market.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Implement the action wrappers**

Create `src/lib/admin/market-actions.ts`:

```ts
'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/admin';
import {
  createDirectoryServer, updateDirectoryServer, deleteDirectoryServer,
  createDirectorySkill, updateDirectorySkill, deleteDirectorySkill,
} from '@/lib/admin/market';
import type { AdminActionState } from '@/lib/admin/user-actions';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const nul = (v: string) => (v === '' ? null : v);
const num = (v: string) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };
const ids = (fd: FormData) => fd.getAll('categoryIds').map((v) => String(v));

export async function createServerAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const slug = str(fd, 'slug').toLowerCase();
  const name = str(fd, 'name');
  if (!name || !SLUG_RE.test(slug)) return { error: 'Name and a valid slug are required.' };
  try {
    await createDirectoryServer({
      slug, name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
      iconUrl: nul(str(fd, 'iconUrl')), stars: num(str(fd, 'stars')),
      isOfficial: fd.get('isOfficial') === 'on', isFeatured: fd.get('isFeatured') === 'on', categoryIds: ids(fd),
    });
  } catch {
    return { error: 'A server with that slug already exists.' };
  }
  revalidatePath('/admin/servers');
  redirect('/admin/servers');
}

export async function updateServerAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const id = str(fd, 'id');
  const name = str(fd, 'name');
  if (!name) return { error: 'Name is required.' };
  await updateDirectoryServer(id, {
    name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
    iconUrl: nul(str(fd, 'iconUrl')), stars: num(str(fd, 'stars')),
    isOfficial: fd.get('isOfficial') === 'on', isFeatured: fd.get('isFeatured') === 'on', categoryIds: ids(fd),
  });
  revalidatePath('/admin/servers');
  revalidatePath(`/admin/servers/${id}/edit`);
  return {};
}

export async function deleteServerAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  try {
    await deleteDirectoryServer(str(fd, 'id'));
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed.' };
  }
  revalidatePath('/admin/servers');
  redirect('/admin/servers');
}

export async function createSkillAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const slug = str(fd, 'slug').toLowerCase();
  const name = str(fd, 'name');
  if (!name || !SLUG_RE.test(slug)) return { error: 'Name and a valid slug are required.' };
  try {
    await createDirectorySkill({
      slug, name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
      iconUrl: nul(str(fd, 'iconUrl')), score: num(str(fd, 'score')), categoryIds: ids(fd),
    });
  } catch {
    return { error: 'A skill with that slug already exists.' };
  }
  revalidatePath('/admin/skills');
  redirect('/admin/skills');
}

export async function updateSkillAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  const id = str(fd, 'id');
  const name = str(fd, 'name');
  if (!name) return { error: 'Name is required.' };
  await updateDirectorySkill(id, {
    name, author: nul(str(fd, 'author')), description: nul(str(fd, 'description')),
    iconUrl: nul(str(fd, 'iconUrl')), score: num(str(fd, 'score')), categoryIds: ids(fd),
  });
  revalidatePath('/admin/skills');
  revalidatePath(`/admin/skills/${id}/edit`);
  return {};
}

export async function deleteSkillAction(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  await requireAdmin();
  try {
    await deleteDirectorySkill(str(fd, 'id'));
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed.' };
  }
  revalidatePath('/admin/skills');
  redirect('/admin/skills');
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm exec tsc --noEmit` → No errors.

```bash
git add src/lib/admin/market.ts src/lib/admin/market-actions.ts tests/integration/admin-market.test.ts
git commit -m "feat: directory server/skill market queries, mutations, and actions"
```

---

### Task 16: MCP market pages + ServerForm

**Files:**
- Create: `src/components/admin/ServerForm.tsx`
- Create: `src/app/admin/servers/page.tsx`
- Create: `src/app/admin/servers/new/page.tsx`
- Create: `src/app/admin/servers/[id]/edit/page.tsx`

- [ ] **Step 1: ServerForm**

Create `src/components/admin/ServerForm.tsx`:

```tsx
'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import type { AdminActionState } from '@/lib/admin/user-actions';

type Category = { id: string; name: string };
type Initial = {
  id?: string; slug?: string; name?: string; author?: string | null; description?: string | null;
  iconUrl?: string | null; stars?: number; isOfficial?: boolean; isFeatured?: boolean; categoryIds?: string[];
};

export function ServerForm({
  action, initial, categories, submitLabel,
}: {
  action: (prev: AdminActionState, fd: FormData) => Promise<AdminActionState>;
  initial: Initial;
  categories: Category[];
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<AdminActionState, FormData>(action, {});
  const input = 'h-9 w-full rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900';
  const lbl = 'block space-y-1 text-sm font-medium text-zinc-700 dark:text-zinc-300';
  const sel = new Set(initial.categoryIds ?? []);

  return (
    <form action={formAction} className="max-w-xl space-y-4">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <label className={lbl}>Name<input name="name" defaultValue={initial.name ?? ''} required className={input} /></label>
      {initial.id ? (
        <p className="text-xs text-zinc-500">Slug: <span className="font-mono">{initial.slug}</span> (immutable)</p>
      ) : (
        <label className={lbl}>Slug<input name="slug" required placeholder="my-server" className={`${input} font-mono`} /></label>
      )}
      <label className={lbl}>Author<input name="author" defaultValue={initial.author ?? ''} className={input} /></label>
      <label className={lbl}>Description<textarea name="description" defaultValue={initial.description ?? ''} rows={3} className="w-full rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" /></label>
      <label className={lbl}>Icon URL<input name="iconUrl" defaultValue={initial.iconUrl ?? ''} className={input} /></label>
      <label className={lbl}>Stars<input name="stars" type="number" defaultValue={initial.stars ?? 0} className={input} /></label>
      <div className="flex gap-4 text-sm text-zinc-700 dark:text-zinc-300">
        <label className="flex items-center gap-2"><input type="checkbox" name="isOfficial" defaultChecked={initial.isOfficial} className="size-4" /> Official</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="isFeatured" defaultChecked={initial.isFeatured} className="size-4" /> Featured</label>
      </div>
      <fieldset className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-xs font-semibold uppercase text-zinc-500">Categories</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {categories.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input type="checkbox" name="categoryIds" value={c.id} defaultChecked={sel.has(c.id)} className="size-4" /> {c.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center gap-3">
        <SubmitButton error={state.error} className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">{submitLabel}</SubmitButton>
        {state.error ? <span className="text-sm text-red-600" role="alert">{state.error}</span> : null}
      </div>
    </form>
  );
}
```

- [ ] **Step 2: List page (with feature/official quick toggles shown as badges; edit via row link)**

Create `src/app/admin/servers/page.tsx`:

```tsx
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/admin';
import { listDirectoryServers } from '@/lib/admin/market';

export const dynamic = 'force-dynamic';

export default async function AdminServersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requireAdmin();
  const { q = '', page = '1' } = await searchParams;
  const { items, total } = await listDirectoryServers({ page: Number(page) || 1, q });

  return (
    <div className="space-y-4 px-8 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">ToolPlane <span className="text-base font-normal text-zinc-500">({total})</span></h1>
        <Link href="/admin/servers/new" className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Add server</Link>
      </div>
      <form className="flex gap-2"><input name="q" defaultValue={q} placeholder="Search…" className="h-9 w-72 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" /><button className="h-9 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700">Search</button></form>
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {items.map((s) => (
          <li key={s.id} className="flex items-center justify-between px-4 py-2.5">
            <Link href={`/admin/servers/${s.id}/edit`} className="min-w-0">
              <span className="block truncate text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100">{s.name} <span className="font-mono text-xs text-zinc-400">/{s.slug}</span></span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{s.stars}★ · {s._count.deployments} deployments</span>
            </Link>
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase">
              {s.curated ? <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">curated</span> : null}
              {s.isOfficial ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">official</span> : null}
              {s.isFeatured ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">featured</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: New page**

Create `src/app/admin/servers/new/page.tsx`:

```tsx
import { requireAdmin } from '@/lib/auth/admin';
import { listCategories } from '@/lib/admin/categories';
import { createServerAction } from '@/lib/admin/market-actions';
import { ServerForm } from '@/components/admin/ServerForm';

export const dynamic = 'force-dynamic';

export default async function NewServerPage() {
  await requireAdmin();
  const categories = await listCategories();
  return (
    <div className="space-y-4 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Add server</h1>
      <ServerForm action={createServerAction} initial={{}} categories={categories} submitLabel="Create" />
    </div>
  );
}
```

- [ ] **Step 4: Edit page (with delete)**

Create `src/app/admin/servers/[id]/edit/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/admin';
import { getDirectoryServer, listDirectoryServers } from '@/lib/admin/market';
import { listCategories } from '@/lib/admin/categories';
import { updateServerAction, deleteServerAction } from '@/lib/admin/market-actions';
import { ServerForm } from '@/components/admin/ServerForm';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';

export const dynamic = 'force-dynamic';

export default async function EditServerPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const [server, categories] = await Promise.all([getDirectoryServer(id), listCategories()]);
  if (!server) notFound();
  void listDirectoryServers;

  return (
    <div className="space-y-6 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Edit {server.name}</h1>
      <ServerForm
        action={updateServerAction}
        initial={{
          id: server.id, slug: server.slug, name: server.name, author: server.author, description: server.description,
          iconUrl: server.iconUrl, stars: server.stars, isOfficial: server.isOfficial, isFeatured: server.isFeatured,
          categoryIds: server.categories.map((c) => c.id),
        }}
        categories={categories}
        submitLabel="Save changes"
      />
      <section className="rounded-lg border border-red-200 p-4 dark:border-red-500/30">
        <h2 className="mb-1 text-sm font-semibold text-red-700 dark:text-red-400">Delete</h2>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">Refused while any deployment references this server ({server._count.deployments} now).</p>
        <ConfirmDialog label="Delete server" prompt="Delete this directory entry?" action={deleteServerAction} hidden={{ id: server.id }} pendingLabel="Deleting…" />
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck + build + commit**

Run: `pnpm exec tsc --noEmit` → No errors. Run: `pnpm build` → Compiled successfully.

```bash
git add src/components/admin/ServerForm.tsx src/app/admin/servers
git commit -m "feat: admin MCP market pages"
```

---

### Task 17: Skills market pages + SkillForm

**Files:**
- Create: `src/components/admin/SkillForm.tsx`
- Create: `src/app/admin/skills/page.tsx`
- Create: `src/app/admin/skills/new/page.tsx`
- Create: `src/app/admin/skills/[id]/edit/page.tsx`

- [ ] **Step 1: SkillForm**

Create `src/components/admin/SkillForm.tsx`:

```tsx
'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import type { AdminActionState } from '@/lib/admin/user-actions';

type Category = { id: string; name: string };
type Initial = {
  id?: string; slug?: string; name?: string; author?: string | null; description?: string | null;
  iconUrl?: string | null; score?: number; categoryIds?: string[];
};

export function SkillForm({
  action, initial, categories, submitLabel,
}: {
  action: (prev: AdminActionState, fd: FormData) => Promise<AdminActionState>;
  initial: Initial;
  categories: Category[];
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<AdminActionState, FormData>(action, {});
  const input = 'h-9 w-full rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900';
  const lbl = 'block space-y-1 text-sm font-medium text-zinc-700 dark:text-zinc-300';
  const sel = new Set(initial.categoryIds ?? []);

  return (
    <form action={formAction} className="max-w-xl space-y-4">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <label className={lbl}>Name<input name="name" defaultValue={initial.name ?? ''} required className={input} /></label>
      {initial.id ? (
        <p className="text-xs text-zinc-500">Slug: <span className="font-mono">{initial.slug}</span> (immutable)</p>
      ) : (
        <label className={lbl}>Slug<input name="slug" required placeholder="my-skill" className={`${input} font-mono`} /></label>
      )}
      <label className={lbl}>Author<input name="author" defaultValue={initial.author ?? ''} className={input} /></label>
      <label className={lbl}>Description<textarea name="description" defaultValue={initial.description ?? ''} rows={3} className="w-full rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" /></label>
      <label className={lbl}>Icon URL<input name="iconUrl" defaultValue={initial.iconUrl ?? ''} className={input} /></label>
      <label className={lbl}>Score<input name="score" type="number" defaultValue={initial.score ?? 0} className={input} /></label>
      <fieldset className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-xs font-semibold uppercase text-zinc-500">Categories</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {categories.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input type="checkbox" name="categoryIds" value={c.id} defaultChecked={sel.has(c.id)} className="size-4" /> {c.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center gap-3">
        <SubmitButton error={state.error} className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">{submitLabel}</SubmitButton>
        {state.error ? <span className="text-sm text-red-600" role="alert">{state.error}</span> : null}
      </div>
    </form>
  );
}
```

- [ ] **Step 2: List, New, Edit pages**

Create `src/app/admin/skills/page.tsx`:

```tsx
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/admin';
import { listDirectorySkills } from '@/lib/admin/market';

export const dynamic = 'force-dynamic';

export default async function AdminSkillsPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requireAdmin();
  const { q = '', page = '1' } = await searchParams;
  const { items, total } = await listDirectorySkills({ page: Number(page) || 1, q });

  return (
    <div className="space-y-4 px-8 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Skills Market <span className="text-base font-normal text-zinc-500">({total})</span></h1>
        <Link href="/admin/skills/new" className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Add skill</Link>
      </div>
      <form className="flex gap-2"><input name="q" defaultValue={q} placeholder="Search…" className="h-9 w-72 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" /><button className="h-9 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700">Search</button></form>
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {items.map((s) => (
          <li key={s.id} className="flex items-center justify-between px-4 py-2.5">
            <Link href={`/admin/skills/${s.id}/edit`} className="min-w-0">
              <span className="block truncate text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100">{s.name} <span className="font-mono text-xs text-zinc-400">/{s.slug}</span></span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">score {s.score} · {s._count.installs} installs</span>
            </Link>
            {s.curated ? <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">curated</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

Create `src/app/admin/skills/new/page.tsx`:

```tsx
import { requireAdmin } from '@/lib/auth/admin';
import { listCategories } from '@/lib/admin/categories';
import { createSkillAction } from '@/lib/admin/market-actions';
import { SkillForm } from '@/components/admin/SkillForm';

export const dynamic = 'force-dynamic';

export default async function NewSkillPage() {
  await requireAdmin();
  const categories = await listCategories();
  return (
    <div className="space-y-4 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Add skill</h1>
      <SkillForm action={createSkillAction} initial={{}} categories={categories} submitLabel="Create" />
    </div>
  );
}
```

Create `src/app/admin/skills/[id]/edit/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/admin';
import { getDirectorySkill } from '@/lib/admin/market';
import { listCategories } from '@/lib/admin/categories';
import { updateSkillAction, deleteSkillAction } from '@/lib/admin/market-actions';
import { SkillForm } from '@/components/admin/SkillForm';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';

export const dynamic = 'force-dynamic';

export default async function EditSkillPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const [skill, categories] = await Promise.all([getDirectorySkill(id), listCategories()]);
  if (!skill) notFound();

  return (
    <div className="space-y-6 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Edit {skill.name}</h1>
      <SkillForm
        action={updateSkillAction}
        initial={{
          id: skill.id, slug: skill.slug, name: skill.name, author: skill.author, description: skill.description,
          iconUrl: skill.iconUrl, score: skill.score, categoryIds: skill.categories.map((c) => c.id),
        }}
        categories={categories}
        submitLabel="Save changes"
      />
      <section className="rounded-lg border border-red-200 p-4 dark:border-red-500/30">
        <h2 className="mb-1 text-sm font-semibold text-red-700 dark:text-red-400">Delete</h2>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">Refused while any workspace has this skill installed ({skill._count.installs} now).</p>
        <ConfirmDialog label="Delete skill" prompt="Delete this directory entry?" action={deleteSkillAction} hidden={{ id: skill.id }} pendingLabel="Deleting…" />
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + build + commit**

Run: `pnpm exec tsc --noEmit` → No errors. Run: `pnpm build` → Compiled successfully.

```bash
git add src/components/admin/SkillForm.tsx src/app/admin/skills
git commit -m "feat: admin skills market pages"
```

---

### Task 18: Scraper curated guard

**Files:**
- Modify: `scraper/ingest.ts`
- Test: `tests/integration/ingest-curated.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/ingest-curated.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/db';
import { upsertServer, upsertSkill } from '@/../scraper/ingest';

const stamp = Date.now();
const card = (slug: string, name: string) => ({ slug, name, author: null, description: null, iconUrl: null, category: null, stars: 7 });

describe('scraper respects curated rows', () => {
  it('does not overwrite a curated server', async () => {
    await db.server.create({ data: { slug: `cur-${stamp}`, name: 'Admin Name', curated: true, stars: 1 } });
    await upsertServer(card(`cur-${stamp}`, 'Scraped Name'));
    const row = await db.server.findUnique({ where: { slug: `cur-${stamp}` } });
    expect(row?.name).toBe('Admin Name');
    expect(row?.stars).toBe(1);
  });

  it('updates a non-curated server', async () => {
    await db.server.create({ data: { slug: `nc-${stamp}`, name: 'Old', curated: false, stars: 1 } });
    await upsertServer(card(`nc-${stamp}`, 'New'));
    const row = await db.server.findUnique({ where: { slug: `nc-${stamp}` } });
    expect(row?.name).toBe('New');
  });

  it('creates a new scraped slug', async () => {
    await upsertServer(card(`fresh-${stamp}`, 'Fresh'));
    expect(await db.server.findUnique({ where: { slug: `fresh-${stamp}` } })).not.toBeNull();
  });

  it('does not overwrite a curated skill', async () => {
    await db.skill.create({ data: { slug: `curs-${stamp}`, name: 'Admin Skill', curated: true, score: 2 } });
    await upsertSkill(card(`curs-${stamp}`, 'Scraped Skill'));
    const row = await db.skill.findUnique({ where: { slug: `curs-${stamp}` } });
    expect(row?.name).toBe('Admin Skill');
  });
});
```

(Note the import path `@/../scraper/ingest` — `@` aliases `src`; `..` steps to the repo root so `scraper/` resolves. The existing `tests/integration/ingest.test.ts` imports the same module; match whatever import specifier it uses.)

- [ ] **Step 2: Confirm the existing import style**

Run: `pnpm vitest run tests/integration/ingest.test.ts` and open `tests/integration/ingest.test.ts` to copy its exact `import … from '…/scraper/ingest'` specifier into the new test (replace the `@/../scraper/ingest` guess if it differs).

- [ ] **Step 3: Run the new test to verify it fails**

Run: `pnpm vitest run tests/integration/ingest-curated.test.ts`
Expected: FAIL — the curated server's name becomes 'Scraped Name'.

- [ ] **Step 4: Add the guard**

In `scraper/ingest.ts`, at the top of `upsertServer`, before `const categories = …`:

```ts
  const existingServer = await db.server.findUnique({ where: { slug: card.slug }, select: { curated: true } });
  if (existingServer?.curated) return;
```

At the top of `upsertSkill`, before the `db.skill.upsert`:

```ts
  const existingSkill = await db.skill.findUnique({ where: { slug: card.slug }, select: { curated: true } });
  if (existingSkill?.curated) return;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/integration/ingest-curated.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add scraper/ingest.ts tests/integration/ingest-curated.test.ts
git commit -m "feat: scraper skips curated directory rows"
```

---

# PHASE 5 — Public Skills market + one-click add

### Task 19: Public install action

**Files:**
- Create: `src/lib/skills/install.ts` (pure helper, no `next` imports — keeps the test clean)
- Create: `src/lib/skills/public-install.ts` (`'use server'` wrapper)
- Test: `tests/integration/public-install.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/public-install.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/lib/db';
import { upsertInstalledSkill } from '@/lib/skills/install';

const stamp = Date.now();
let wsId = '';
let skillId = '';

beforeAll(async () => {
  const u = await db.user.create({ data: { email: `pi-${stamp}@t.dev`, passwordHash: 'x' } });
  const ws = await db.workspace.create({ data: { slug: `pi-${stamp}`, name: 'PI', ownerId: u.id, members: { create: { userId: u.id, role: 'owner' } } } });
  wsId = ws.id;
  const sk = await db.skill.create({ data: { slug: `pi-skill-${stamp}`, name: 'PI Skill' } });
  skillId = sk.id;
});

describe('upsertInstalledSkill', () => {
  it('installs and is idempotent', async () => {
    const a = await upsertInstalledSkill(wsId, skillId);
    const b = await upsertInstalledSkill(wsId, skillId);
    expect(a.id).toBe(b.id);
    expect(await db.installedSkill.count({ where: { workspaceId: wsId, skillId } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/integration/public-install.test.ts`
Expected: FAIL — cannot find `@/lib/skills/install`.

- [ ] **Step 3: Implement the pure helper**

Create `src/lib/skills/install.ts` (no `'use server'`, no `next` imports — importable from the test):

```ts
import 'server-only';
import { db } from '@/lib/db';

// Idempotent on (workspace, skill). Shared by the public one-click add action.
export async function upsertInstalledSkill(workspaceId: string, skillId: string) {
  return db.installedSkill.upsert({
    where: { workspaceId_skillId: { workspaceId, skillId } },
    update: {},
    create: { workspaceId, skillId },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/integration/public-install.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the server action**

Create `src/lib/skills/public-install.ts`:

```ts
'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getOrCreateDefaultWorkspace } from '@/lib/workspace/queries';
import { upsertInstalledSkill } from '@/lib/skills/install';

// Public-site one-click: install a directory skill into the caller's default
// workspace, then open it in the console.
export async function addSkillToWorkspaceAction(formData: FormData) {
  const user = await getCurrentUser();
  const skillId = String(formData.get('skillId') ?? '');
  const slug = String(formData.get('slug') ?? '');
  if (!user) redirect(`/app/login?next=${encodeURIComponent(`/tools/skills/${slug}`)}`);
  if (!skillId) return;
  const ws = await getOrCreateDefaultWorkspace(user.id, user.email);
  const install = await upsertInstalledSkill(ws.id, skillId);
  revalidatePath(`/app/${ws.slug}/skills`);
  redirect(`/app/${ws.slug}/skills/${install.id}`);
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm exec tsc --noEmit` → No errors.

```bash
git add src/lib/skills/install.ts src/lib/skills/public-install.ts tests/integration/public-install.test.ts
git commit -m "feat: public one-click add-skill-to-workspace action"
```

---

### Task 20: Public skill detail CTA

**Files:**
- Modify: `src/app/(site)/tools/skills/[slug]/page.tsx`

(No unit test — RSC page; logic covered by Task 19.)

- [ ] **Step 1: Read the current page to find the install/CTA section**

Run: `sed -n '1,120p' "src/app/(site)/tools/skills/[slug]/page.tsx"` — locate where it already shows the "open dashboard / download" block and whether it fetches `getCurrentUser` and the skill (`id`, `slug`). The skill query must return `id`; if the page's `getSkill` doesn't select `id`, use the existing returned object (slug detail pages fetch the full row, which includes `id`).

- [ ] **Step 2: Add the CTA**

Ensure these imports exist at the top of the file (add any missing):

```tsx
import { getCurrentUser } from '@/lib/auth/current-user';
import { addSkillToWorkspaceAction } from '@/lib/skills/public-install';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
```

In the component body, after the skill is fetched (call it `skill`), fetch the user:

```tsx
  const user = await getCurrentUser();
```

Add this CTA card in the sidebar/aside area (place it near the existing "open dashboard"/download block; if there is an `<aside>` like the server page, put it as the first card):

```tsx
        <div className="rounded-lg border border-border bg-card p-4">
          {!user ? (
            <Link
              href={`/app/login?next=${encodeURIComponent(`/tools/skills/${skill.slug}`)}`}
              className="flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Sign in to add
            </Link>
          ) : (
            <form action={addSkillToWorkspaceAction}>
              <input type="hidden" name="skillId" value={skill.id} />
              <input type="hidden" name="slug" value={skill.slug} />
              <SubmitButton
                pendingLabel="Adding…"
                className="flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Add to my workspace
              </SubmitButton>
            </form>
          )}
          <p className="mt-2 text-center text-xs text-muted-foreground">One-click install</p>
        </div>
```

If the file doesn't already `import Link from 'next/link'`, add it.

- [ ] **Step 3: Typecheck + build + commit**

Run: `pnpm exec tsc --noEmit` → No errors. Run: `pnpm build` → Compiled successfully.

```bash
git add "src/app/(site)/tools/skills/[slug]/page.tsx"
git commit -m "feat: one-click add-to-workspace on public skill detail"
```

---

### Task 21: Final full verification

**Files:** none (verification only)

- [ ] **Step 1: Full suite + typecheck + build**

Run: `pnpm exec tsc --noEmit` → No errors.
Run: `pnpm test` → all green.
Run: `pnpm build` → Compiled successfully.

- [ ] **Step 2: Manual smoke (requires `pnpm dev` + `.env` with `ADMIN_EMAILS=<your email>` + a migrated DB)**

1. Sign up / log in as the allowlisted email → an "Admin console" link appears in the console sidebar; `/admin` loads the overview.
2. Log in as a non-allowlisted account → visiting `/admin` redirects to `/`.
3. In `/admin/users`, suspend a second test account → that account's next request logs it out and its API token returns 401-equivalent (null). Reactivate restores it.
4. In `/admin/servers`, create an entry, edit it (now `curated`), run `pnpm tsx scraper/scrape-servers.ts` (or the relevant scraper) → the edit survives; a new scraped slug still appears.
5. Try deleting a directory server with a deployment / a skill with an install → refused with a message; delete one with none → succeeds.
6. On `/tools/skills/<slug>` while logged in, click **Add to my workspace** → the skill opens in the console; clicking again is idempotent.

- [ ] **Step 3: Hand off to finishing-a-development-branch**

Use `superpowers:finishing-a-development-branch` to verify tests and choose merge/PR.

---

## Self-review (performed against the spec)

**Spec coverage:**
- Decision 1 (role + ADMIN_EMAILS bootstrap) → Tasks 1, 2, 3. ✅
- Decision 2 (skills market: admin-managed + public add) → Tasks 17 (admin) + 19/20 (public). ✅
- Decision 3 (all subsystems) → Phases 1–5 cover foundation, overview, users/workspaces, market, public add. ✅
- Decision 4 (view + role + suspend + delete) → Tasks 9/10/11. ✅
- Decision 5 (curated guard) → Tasks 1 (field) + 18 (scraper). ✅
- Decision 6 (Prisma enums) → Task 1. ✅
- Suspension via both session + token → Task 3 (`getCurrentUser` + `verifyApiToken`). ✅
- Self-protection (no demote/suspend/delete self) → Task 9 `refuseSelf` + tests. ✅
- Directory delete refuses on dependents → Task 15 (`deleteDirectoryServer`/`deleteDirectorySkill`) + tests. ✅
- Shared teardown (no orphan processes) → Task 8, reused in Tasks 9 & 12. ✅
- Admin shell + overview + console entry → Tasks 4, 5, 6, 7. ✅
- Categories CRUD to back the forms → Task 14. ✅

**Type consistency:** `AdminActionState` defined once in `user-actions.ts` (Task 10) and imported everywhere; `ServerInput`/`SkillInput` defined in `market.ts` (Task 15) and consumed by `market-actions.ts`; `requireAdmin` returns the user (used for `admin.id` in Task 9 wrappers); `ConfirmDialog` action signature `(prev, fd) => Promise<AdminActionState>` matches every action passed to it.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the one "read the file first" step (Task 20 Step 1, Task 18 Step 2) is to confirm an exact import specifier / existing markup, with the concrete edit given immediately after.

**Known follow-up risks (acceptable, not blockers):** Task 18's scraper import specifier and Task 20's exact insertion point are confirmed against the live files during execution (steps call this out explicitly). `'use server'` modules export only async functions (verified for `public-install.ts`).
