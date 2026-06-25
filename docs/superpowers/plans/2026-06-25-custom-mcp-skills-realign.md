# Custom MCP Realign + Custom Skills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make custom MCP match the real app.mcpmarket.com (4 real sources npm/PyPI/GitHub/Docker, "Add custom" on the browse page, env on the inspector Variables tab) and add full custom Skills (Create new / GitHub import / folder upload, draft→publish, frontmatter attributes, an editor), authored content usable by agents.

**Architecture:** Reuse the existing stdio↔HTTP bridge unchanged — every MCP source reduces to "spawn a command that speaks MCP over stdio" (`npx`/`uvx`/`npx <git-url>`/`docker run`). Custom skills become workspace-owned `InstalledSkill` rows with `skillId` nullable + authored `content`, so agent/toolkit binding and download reuse existing wiring.

**Tech Stack:** Next.js 16 (App Router, server actions), Prisma 7 + pg, Vitest 4, zod 4, **pnpm** (npm crashes here).

**Spec:** `docs/superpowers/specs/2026-06-25-custom-mcp-skills-realign-design.md`

**Conventions (every task):** use `pnpm` for all commands; type-check with `pnpm exec tsc --noEmit`; commit messages have **no** `Co-Authored-By`/attribution trailer. The editor LSP shows STALE Prisma false positives — the CLI `pnpm exec tsc --noEmit` is authoritative. After any Prisma migration, restart the dev server if running. Postgres runs via `docker compose up -d` (port 5433).

**Branch:** continue on `feat/custom-mcp-install`.

---

# PHASE A — Custom MCP realign to the real site

### Task A1: `spawn-spec.ts` — four real sources + startCommand

**Files:**
- Modify: `src/lib/process/spawn-spec.ts`
- Modify: `tests/unit/spawn-spec.test.ts`

- [ ] **Step 1: Replace the test file** `tests/unit/spawn-spec.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSpawnSpec, resolveSpawnSpec } from '@/lib/process/spawn-spec';

describe('buildSpawnSpec', () => {
  it('npm → npx -y', () => {
    expect(buildSpawnSpec('npm', 'mcp-server-fetch')).toEqual({ command: 'npx', args: ['-y', 'mcp-server-fetch'] });
  });
  it('pypi → uvx', () => {
    expect(buildSpawnSpec('pypi', 'mcp-server-fetch')).toEqual({ command: 'uvx', args: ['mcp-server-fetch'] });
  });
  it('github → npx -y <url>', () => {
    expect(buildSpawnSpec('github', 'https://github.com/org/repo')).toEqual({
      command: 'npx',
      args: ['-y', 'https://github.com/org/repo'],
    });
  });
  it('docker → docker run -i --rm <image> <startCommand…>', () => {
    expect(buildSpawnSpec('docker', 'mcp/slack', 'node dist/index.js')).toEqual({
      command: 'docker',
      args: ['run', '-i', '--rm', 'mcp/slack', 'node', 'dist/index.js'],
    });
  });
  it('docker without start command', () => {
    expect(buildSpawnSpec('docker', 'mcp/slack')).toEqual({ command: 'docker', args: ['run', '-i', '--rm', 'mcp/slack'] });
  });
  it('throws on unsupported source', () => {
    expect(() => buildSpawnSpec('brew', 'x')).toThrow(/Unsupported MCP source/);
  });
});

describe('resolveSpawnSpec', () => {
  it('builtin for catalog', () => {
    expect(
      resolveSpawnSpec({ serverId: 's1', server: { name: 'Stripe' }, name: null, source: null, sourceRef: null, installCfg: null }),
    ).toEqual({ kind: 'builtin', name: 'Stripe' });
  });
  it('bridge for custom docker with env + startCommand', () => {
    expect(
      resolveSpawnSpec({
        serverId: null,
        server: null,
        name: 'Slack',
        source: 'docker',
        sourceRef: 'mcp/slack',
        installCfg: { env: { TOKEN: 'x' }, startCommand: 'node app.js' },
      }),
    ).toEqual({ kind: 'bridge', name: 'Slack', command: 'docker', args: ['run', '-i', '--rm', 'mcp/slack', 'node', 'app.js'], env: { TOKEN: 'x' } });
  });
});
```

- [ ] **Step 2: Run — expect FAIL** `pnpm vitest run tests/unit/spawn-spec.test.ts` (signature mismatch / wrong output).

- [ ] **Step 3: Replace `src/lib/process/spawn-spec.ts`:**

```ts
export type SpawnSpec =
  | { kind: 'builtin'; name: string }
  | { kind: 'bridge'; name: string; command: string; args: string[]; env: Record<string, string> };

export type DeploymentForSpawn = {
  serverId: string | null;
  server: { name: string } | null;
  name: string | null;
  source: string | null;
  sourceRef: string | null;
  installCfg: unknown;
};

function splitArgs(s: string | undefined): string[] {
  return s ? s.split(/\s+/).filter(Boolean) : [];
}

export function buildSpawnSpec(
  source: string,
  ref: string,
  startCommand?: string,
): { command: string; args: string[] } {
  switch (source) {
    case 'npm':
      return { command: 'npx', args: ['-y', ref] };
    case 'github':
      return { command: 'npx', args: ['-y', ref] };
    case 'pypi':
      return { command: 'uvx', args: [ref] };
    case 'docker':
      return { command: 'docker', args: ['run', '-i', '--rm', ref, ...splitArgs(startCommand)] };
    default:
      throw new Error(`Unsupported MCP source: ${source || '(none)'}`);
  }
}

function readCfg(installCfg: unknown): { env: Record<string, string>; startCommand?: string } {
  const c = (installCfg ?? {}) as { env?: Record<string, string>; startCommand?: string };
  return { env: c.env ?? {}, startCommand: c.startCommand };
}

export function resolveSpawnSpec(d: DeploymentForSpawn): SpawnSpec {
  if (d.serverId && d.server) return { kind: 'builtin', name: d.server.name };
  const { env, startCommand } = readCfg(d.installCfg);
  const { command, args } = buildSpawnSpec(d.source ?? '', d.sourceRef ?? '', startCommand);
  return { kind: 'bridge', name: d.name ?? d.sourceRef ?? 'custom', command, args, env };
}
```

- [ ] **Step 4: Run — expect PASS** `pnpm vitest run tests/unit/spawn-spec.test.ts` (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/process/spawn-spec.ts tests/unit/spawn-spec.test.ts
git commit -m "feat: spawn-spec supports npm/pypi/github/docker + startCommand"
```

---

### Task A2: `custom-mcp.ts` — per-source validation, drop env/args

**Files:**
- Modify: `src/lib/workspace/custom-mcp.ts`
- Modify: `tests/unit/custom-mcp-validate.test.ts`

- [ ] **Step 1: Replace `tests/unit/custom-mcp-validate.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import { parseCustomMcpInput } from '@/lib/workspace/custom-mcp';

describe('parseCustomMcpInput', () => {
  it('npm package', () => {
    expect(parseCustomMcpInput({ source: 'npm', ref: '@scope/server', name: 'S' })).toEqual({
      source: 'npm', ref: '@scope/server', name: 'S', installCfg: null,
    });
  });
  it('pypi package', () => {
    expect(parseCustomMcpInput({ source: 'pypi', ref: 'mcp-server-fetch', name: 'F' }).source).toBe('pypi');
  });
  it('github url accepted', () => {
    expect(parseCustomMcpInput({ source: 'github', ref: 'https://github.com/org/repo', name: 'G' }).ref).toBe('https://github.com/org/repo');
  });
  it('docker image + startCommand stored in installCfg', () => {
    expect(parseCustomMcpInput({ source: 'docker', ref: 'mcp/slack', name: 'D', startCommand: 'node a.js' }).installCfg).toEqual({ startCommand: 'node a.js' });
  });
  it('rejects non-github url for github source', () => {
    expect(() => parseCustomMcpInput({ source: 'github', ref: 'https://evil.com/x/y', name: 'G' })).toThrow();
  });
  it('rejects bad npm name', () => {
    expect(() => parseCustomMcpInput({ source: 'npm', ref: 'Bad Name!', name: 'S' })).toThrow();
  });
  it('rejects empty name', () => {
    expect(() => parseCustomMcpInput({ source: 'npm', ref: 'x', name: '  ' })).toThrow();
  });
  it('rejects unknown source', () => {
    expect(() => parseCustomMcpInput({ source: 'brew', ref: 'x', name: 'S' })).toThrow();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** `pnpm vitest run tests/unit/custom-mcp-validate.test.ts`.

- [ ] **Step 3: Replace `src/lib/workspace/custom-mcp.ts`:**

```ts
import { z } from 'zod';

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;
const DOCKER_IMAGE = /^[a-z0-9]+([._/-][a-z0-9]+)*(:[\w.-]+)?$/;

const schema = z
  .object({
    source: z.enum(['npm', 'pypi', 'github', 'docker']),
    ref: z.string().trim().min(1),
    name: z.string().trim().min(1, 'name is required').max(80),
    startCommand: z.string().trim().default(''),
  })
  .superRefine((v, ctx) => {
    const ok =
      v.source === 'npm' ? NPM_NAME.test(v.ref)
      : v.source === 'pypi' ? PYPI_NAME.test(v.ref)
      : v.source === 'github' ? GITHUB_URL.test(v.ref)
      : DOCKER_IMAGE.test(v.ref);
    if (!ok) ctx.addIssue({ code: 'custom', path: ['ref'], message: `invalid ${v.source} reference` });
  });

export type ParsedCustomMcp = {
  source: 'npm' | 'pypi' | 'github' | 'docker';
  ref: string;
  name: string;
  installCfg: { startCommand: string } | null;
};

export function parseCustomMcpInput(raw: unknown): ParsedCustomMcp {
  const v = schema.parse(raw);
  const installCfg = v.source === 'docker' && v.startCommand ? { startCommand: v.startCommand } : null;
  return { source: v.source, ref: v.ref, name: v.name, installCfg };
}
```

- [ ] **Step 4: Run — expect PASS** `pnpm vitest run tests/unit/custom-mcp-validate.test.ts` (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace/custom-mcp.ts tests/unit/custom-mcp-validate.test.ts
git commit -m "feat: validate custom MCP per source (npm/pypi/github/docker), drop env/args"
```

---

### Task A3: server actions — `deployCustomServerAction` reshape + `setDeploymentEnvAction`

**Files:**
- Modify: `src/lib/workspace/actions.ts`

- [ ] **Step 1: Replace the body of `deployCustomServerAction`** in `src/lib/workspace/actions.ts`. Find the existing `export async function deployCustomServerAction(formData: FormData) { ... }` and replace the whole function with:

```ts
export async function deployCustomServerAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  if (!slug) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;

  let parsed;
  try {
    parsed = parseCustomMcpInput({
      source: String(formData.get('source') ?? 'npm'),
      ref: String(formData.get('ref') ?? ''),
      name: String(formData.get('name') ?? ''),
      startCommand: String(formData.get('startCommand') ?? ''),
    });
  } catch {
    return;
  }

  const dep = await db.deployment.create({
    data: {
      workspaceId: ctx.ws.id,
      serverId: null,
      name: parsed.name,
      source: parsed.source,
      sourceRef: parsed.ref,
      installCfg: parsed.installCfg ?? undefined,
      status: 'provisioning',
    },
  });

  await startProcess(
    dep.id,
    resolveSpawnSpec({
      serverId: null,
      server: null,
      name: dep.name,
      source: dep.source,
      sourceRef: dep.sourceRef,
      installCfg: dep.installCfg,
    }),
  );

  revalidatePath(`/app/${slug}/mcp`);
}
```

- [ ] **Step 2: Add `setDeploymentEnvAction`** immediately after `deployCustomServerAction`:

```ts
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function setDeploymentEnvAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  if (!slug || !deploymentId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const dep = await db.deployment.findFirst({
    where: { id: deploymentId, workspaceId: ctx.ws.id },
    select: { id: true, installCfg: true },
  });
  if (!dep) return;

  const env: Record<string, string> = {};
  try {
    const rows = JSON.parse(String(formData.get('env') ?? '[]')) as { key: string; value: string }[];
    for (const r of rows) if (r.key && ENV_KEY.test(r.key)) env[r.key] = String(r.value ?? '');
  } catch {
    return;
  }

  const cfg = (dep.installCfg ?? {}) as Record<string, unknown>;
  await db.deployment.update({ where: { id: deploymentId }, data: { installCfg: { ...cfg, env } } });
  revalidatePath(`/app/${slug}/mcp/${deploymentId}`);
}
```

- [ ] **Step 3: Verify** `pnpm exec tsc --noEmit` (0 errors). `parseCustomMcpInput`, `resolveSpawnSpec`, `startProcess`, `db`, `revalidatePath`, `authorizedWorkspace` are all already imported in this file.

- [ ] **Step 4: Run** `pnpm test` — all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace/actions.ts
git commit -m "feat: deploy action takes source/ref/startCommand; add setDeploymentEnvAction"
```

---

### Task A4: `DeployCustomMcpDialog` — 4-source centered modal (no env/args)

**Files:**
- Create: `src/components/dashboard/DeployCustomMcpDialog.tsx`
- Delete: `src/components/dashboard/DeployCustomMcpLauncher.tsx`
- Modify: `tests/unit/deploy-custom-mcp-launcher.test.tsx` → rename to `tests/unit/deploy-custom-mcp-dialog.test.tsx`

- [ ] **Step 1: Create `src/components/dashboard/DeployCustomMcpDialog.tsx`:**

```tsx
'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, AlertTriangle } from 'lucide-react';
import { deployCustomServerAction } from '@/lib/workspace/actions';

const SOURCES = [
  { key: 'npm', label: 'npm', field: 'npm Package', placeholder: '@modelcontextprotocol/server-filesystem' },
  { key: 'pypi', label: 'PyPI', field: 'PyPI Package', placeholder: 'mcp-server-fetch' },
  { key: 'github', label: 'GitHub', field: 'GitHub Repository', placeholder: 'https://github.com/org/mcp-server' },
  { key: 'docker', label: 'Docker', field: 'Docker Image', placeholder: 'mcp/slack' },
];

const field =
  'h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';
const labelCls = 'mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500';

export function DeployCustomMcpDialog({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('npm');
  const [name, setName] = useState('');
  const current = SOURCES.find((s) => s.key === source) ?? SOURCES[0];
  const slugPreview =
    name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp-server';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
      >
        <Plus className="size-4" />
        Add custom
      </button>

      {open
        ? createPortal(
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
              <div
                className="w-full max-w-lg overflow-y-auto rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-1 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Deploy custom MCP</h2>
                  <button type="button" onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-700">
                    <X className="size-5" />
                  </button>
                </div>
                <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">Deploy a custom MCP server</p>

                <div className="mb-5 flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>MCP servers can access your data and execute arbitrary code. Only install servers from sources you trust.</span>
                </div>

                <form action={deployCustomServerAction} className="space-y-5">
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="source" value={source} />

                  <div>
                    <p className={labelCls}>Source</p>
                    <div className="flex gap-1 rounded-md border border-zinc-200 p-1 dark:border-zinc-700">
                      {SOURCES.map((s) => (
                        <button
                          key={s.key}
                          type="button"
                          onClick={() => setSource(s.key)}
                          className={`flex-1 rounded px-2 py-1.5 text-sm transition-colors ${
                            source === s.key ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label htmlFor="ref" className={labelCls}>{current.field}</label>
                    <input id="ref" name="ref" required placeholder={current.placeholder} className={`${field} font-mono`} />
                  </div>

                  {source === 'docker' ? (
                    <div>
                      <label htmlFor="startCommand" className={labelCls}>Start Command</label>
                      <input id="startCommand" name="startCommand" placeholder="node dist/index.js" className={`${field} font-mono`} />
                    </div>
                  ) : null}

                  <div>
                    <label htmlFor="name" className={labelCls}>Server Name</label>
                    <input id="name" name="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Weather API" className={field} />
                    <p className="mt-1 font-mono text-xs text-zinc-400">/{slug}/mcp/{slugPreview}</p>
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button type="button" onClick={() => setOpen(false)} className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-4 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-200">Cancel</button>
                    <button type="submit" className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900">Deploy</button>
                  </div>
                </form>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
```

- [ ] **Step 2: Delete the old launcher and its test:**

```bash
git rm src/components/dashboard/DeployCustomMcpLauncher.tsx tests/unit/deploy-custom-mcp-launcher.test.tsx
```

- [ ] **Step 3: Create `tests/unit/deploy-custom-mcp-dialog.test.tsx`:**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeployCustomMcpDialog } from '@/components/dashboard/DeployCustomMcpDialog';

vi.mock('@/lib/workspace/actions', () => ({ deployCustomServerAction: vi.fn() }));

describe('DeployCustomMcpDialog', () => {
  it('switches the package field label per source and shows Start Command only for Docker', async () => {
    render(<DeployCustomMcpDialog slug="acme" />);
    await userEvent.click(screen.getByRole('button', { name: /add custom/i }));
    expect(screen.getByText('npm Package')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'GitHub' }));
    expect(screen.getByText('GitHub Repository')).toBeInTheDocument();
    expect(screen.queryByText('Start Command')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Docker' }));
    expect(screen.getByText('Docker Image')).toBeInTheDocument();
    expect(screen.getByText('Start Command')).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run — expect PASS** `pnpm vitest run tests/unit/deploy-custom-mcp-dialog.test.tsx`.

- [ ] **Step 5: Commit** (the page wiring that imports this is Task A5/A6 — `tsc` may report the old import until then; that's expected):

```bash
git add src/components/dashboard/DeployCustomMcpDialog.tsx tests/unit/deploy-custom-mcp-dialog.test.tsx
git commit -m "feat: 4-source centered Deploy custom MCP dialog (Add custom)"
```

---

### Task A5: `/mcp` list page — remove the old custom button

**Files:**
- Modify: `src/app/app/[workspace]/mcp/page.tsx`

- [ ] **Step 1:** Remove the import of `DeployCustomMcpLauncher` and its use in the header `actions`. Replace the header `actions` block (currently a `<div className="flex items-center gap-2">` wrapping `<DeployCustomMcpLauncher .../>` and the Browse link) with just the Browse link:

```tsx
        actions={
          <Link
            href={`/app/${slug}/mcp/new`}
            className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Browse MCPs
          </Link>
        }
```

Delete the line `import { DeployCustomMcpLauncher } from '@/components/dashboard/DeployCustomMcpLauncher';`. Keep `ProvisioningRefresher` and `deploymentLabel` imports/usages.

- [ ] **Step 2: Verify** `pnpm exec tsc --noEmit` — the only remaining error (if any) should be `mcp/new/page.tsx` once it references the new dialog (fixed in A6). Confirm `mcp/page.tsx` itself is clean.

- [ ] **Step 3: Commit**

```bash
git add "src/app/app/[workspace]/mcp/page.tsx"
git commit -m "feat: move custom MCP entry off the list page (now on browse page)"
```

---

### Task A6: `/mcp/new` browse page — Featured + All MCPs (paginated) + Add custom

**Files:**
- Modify: `src/app/app/[workspace]/mcp/new/page.tsx`
- Modify: `src/lib/workspace/queries.ts` (add a paginated browse query)

- [ ] **Step 1:** Add a browse query to `src/lib/workspace/queries.ts` (append):

```ts
const BROWSE_PAGE_SIZE = 25;

export async function getBrowseServers(page: number) {
  const skip = (Math.max(1, page) - 1) * BROWSE_PAGE_SIZE;
  const [featured, total, all] = await Promise.all([
    db.server.findMany({
      where: { isFeatured: true },
      orderBy: { stars: 'desc' },
      take: 12,
      select: { id: true, name: true, description: true, iconUrl: true },
    }),
    db.server.count(),
    db.server.findMany({
      orderBy: { stars: 'desc' },
      skip,
      take: BROWSE_PAGE_SIZE,
      select: { id: true, name: true, description: true, iconUrl: true },
    }),
  ]);
  return { featured, all, total, pageSize: BROWSE_PAGE_SIZE };
}
```

- [ ] **Step 2:** Replace `src/app/app/[workspace]/mcp/new/page.tsx` with:

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getDeployments, getBrowseServers } from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { BrowseGrid } from '@/components/dashboard/BrowseGrid';
import { DeployCustomMcpDialog } from '@/components/dashboard/DeployCustomMcpDialog';
import { deployServerAction } from '@/lib/workspace/actions';

export const dynamic = 'force-dynamic';

export default async function BrowseMcpPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { workspace: slug } = await params;
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [{ featured, all, total, pageSize }, deployed] = await Promise.all([
    getBrowseServers(page),
    getDeployments(ws.id),
  ]);
  const deployedIds = new Set(deployed.map((d) => d.serverId).filter((id): id is string => id !== null));
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <DashboardHeader
        breadcrumb={[{ label: 'MCP Servers', href: `/app/${slug}/mcp` }, { label: 'Browse' }]}
      />
      <div className="space-y-8 px-8 py-6">
        <div className="flex items-center justify-end">
          <DeployCustomMcpDialog slug={slug} />
        </div>

        {featured.length > 0 ? (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Featured</h2>
            <BrowseGrid items={featured} installedIds={deployedIds} slug={slug} action={deployServerAction} idField="serverId" actionLabel="Add" installedLabel="Added" />
          </section>
        ) : null}

        <section>
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">All MCPs</h2>
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Description</th>
                  <th className="px-4 py-3 text-right font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {all.map((s) => (
                  <tr key={s.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">{s.name}</td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                      <span className="line-clamp-1">{s.description}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {deployedIds.has(s.id) ? (
                        <span className="text-xs text-zinc-400">Added</span>
                      ) : (
                        <form action={deployServerAction} className="inline">
                          <input type="hidden" name="workspace" value={slug} />
                          <input type="hidden" name="serverId" value={s.id} />
                          <button className="text-xs font-medium text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100">Add</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex items-center justify-between text-sm text-zinc-500 dark:text-zinc-400">
            <span>Showing page {page} of {lastPage} · {total} servers</span>
            <div className="flex gap-2">
              {page > 1 ? <Link href={`/app/${slug}/mcp/new?page=${page - 1}`} className="rounded-md border border-zinc-200 px-3 py-1 dark:border-zinc-700">Prev</Link> : null}
              {page < lastPage ? <Link href={`/app/${slug}/mcp/new?page=${page + 1}`} className="rounded-md border border-zinc-200 px-3 py-1 dark:border-zinc-700">Next</Link> : null}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
```

(Note: `db` import is retained only if used; if `pnpm lint` flags it as unused, remove the `import { db }` line — the rewrite above does not use `db` directly, so delete that import.)

- [ ] **Step 3: Verify** `pnpm exec tsc --noEmit` (0 errors) and `pnpm lint` introduces no new errors in these two files.

- [ ] **Step 4: Run** `pnpm test` — all pass.

- [ ] **Step 5: Commit**

```bash
git add "src/app/app/[workspace]/mcp/new/page.tsx" src/lib/workspace/queries.ts
git commit -m "feat: browse page with Featured + paginated All MCPs + Add custom"
```

---

### Task A7: inspector Variables tab — `VariablesEditor`

**Files:**
- Create: `src/components/dashboard/VariablesEditor.tsx`
- Modify: `src/app/app/[workspace]/mcp/[deploymentId]/page.tsx`

- [ ] **Step 1: Create `src/components/dashboard/VariablesEditor.tsx`:**

```tsx
'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { setDeploymentEnvAction } from '@/lib/workspace/actions';

type Row = { key: string; value: string };

export function VariablesEditor({ slug, deploymentId, initial }: { slug: string; deploymentId: string; initial: Row[] }) {
  const [rows, setRows] = useState<Row[]>(initial.length ? initial : [{ key: '', value: '' }]);

  return (
    <form action={setDeploymentEnvAction} className="space-y-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <div>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">My Credentials</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Environment variables for this server. Restart to apply.</p>
      </div>
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="deploymentId" value={deploymentId} />
      <input type="hidden" name="env" value={JSON.stringify(rows.filter((r) => r.key))} />

      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex gap-2">
            <input
              value={row.key}
              onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
              placeholder="API_KEY"
              className="h-9 w-1/3 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <input
              type="password"
              value={row.value}
              onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
              placeholder="value"
              className="h-9 flex-1 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-red-600">
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setRows((rs) => [...rs, { key: '', value: '' }])} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
          <Plus className="size-3.5" /> Add variable
        </button>
        <button type="submit" className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900">Save</button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2:** In `src/app/app/[workspace]/mcp/[deploymentId]/page.tsx`: import the editor and read current env. Add import:

```ts
import { VariablesEditor } from '@/components/dashboard/VariablesEditor';
```

After `const label = deploymentLabel(dep);`, add:

```ts
  const envCfg = (dep.installCfg ?? {}) as { env?: Record<string, string> };
  const envRows = Object.entries(envCfg.env ?? {}).map(([key, value]) => ({ key, value }));
```

Replace the `current === 'variables'` block (currently the dashed "This server has no configurable variables." placeholder) with:

```tsx
        {current === 'variables' ? (
          <VariablesEditor slug={slug} deploymentId={deploymentId} initial={envRows} />
        ) : null}
```

(The inspector query already loads `dep` with all scalar columns including `installCfg`, so no query change is needed.)

- [ ] **Step 3: Verify** `pnpm exec tsc --noEmit` (0 errors).

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/VariablesEditor.tsx "src/app/app/[workspace]/mcp/[deploymentId]/page.tsx"
git commit -m "feat: inspector Variables tab edits per-deployment env (My Credentials)"
```

---

### Task A8: Phase A verification

- [ ] **Step 1:** `pnpm exec tsc --noEmit` → 0 errors.
- [ ] **Step 2:** `pnpm test` → all pass.
- [ ] **Step 3:** `pnpm build` → succeeds (confirm `.next/BUILD_ID` written).
- [ ] **Step 4: Manual smoke** (`docker compose up -d`, `pnpm dev`, login `smoke@example.com`/`password123`): `/mcp` → Browse MCPs → **Add custom** → npm `@modelcontextprotocol/server-everything` / name `Everything` → Deploy → row provisions→running → open it → **Variables** tab → add `FOO`=`bar` → Save → Restart → Tools tab shows real tools. Switch the dialog Source to PyPI/GitHub/Docker and confirm the field label changes (Docker shows Start Command).
- [ ] **Step 5:** No commit needed unless smoke required a fix.

---

# PHASE B — Custom Skills

### Task B1: Prisma — `InstalledSkill.skillId` nullable + custom fields

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1:** Replace the entire `InstalledSkill` model with:

```prisma
model InstalledSkill {
  id             String         @id @default(cuid())
  workspaceId    String
  workspace      Workspace      @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  skillId        String?
  skill          Skill?         @relation(fields: [skillId], references: [id], onDelete: Cascade)
  name           String?
  slug           String?
  description    String?
  content        String?
  source         String?
  sourceRef      String?
  status         String         @default("published")
  userInvocable  Boolean        @default(true)
  agentInvocable Boolean        @default(true)
  effort         String         @default("default")
  files          Json?
  createdAt      DateTime       @default(now())
  toolkitLinks   ToolkitSkill[]
  agentLinks     AgentSkill[]

  @@unique([workspaceId, skillId])
}
```

- [ ] **Step 2:** `pnpm exec prisma validate` → valid.
- [ ] **Step 3:** `pnpm exec prisma migrate dev --name custom_skills` → migration created + applied + client regenerated.
- [ ] **Step 4:** `pnpm exec tsc --noEmit`. EXPECTED: errors only in files that read `installedSkill.skill.*` (now nullable) — these are fixed in B4. Confirm there are no *unexpected* errors (only nullable-skill access). Do NOT fix consumers here.
- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: make InstalledSkill.skillId nullable + add custom skill columns"
```

---

### Task B2: `skill-label.ts` — catalog vs custom display (pure, TDD)

**Files:**
- Create: `src/lib/workspace/skill-label.ts`
- Test: `tests/unit/skill-label.test.ts`

- [ ] **Step 1: Test** `tests/unit/skill-label.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { skillLabel } from '@/lib/workspace/skill-label';

describe('skillLabel', () => {
  it('catalog', () => {
    expect(skillLabel({ skillId: 's1', skill: { name: 'PDF', slug: 'pdf' }, name: null, slug: null, source: null }))
      .toEqual({ name: 'PDF', slug: 'pdf', source: 'catalog' });
  });
  it('custom', () => {
    expect(skillLabel({ skillId: null, skill: null, name: 'My Skill', slug: 'my-skill', source: 'custom' }))
      .toEqual({ name: 'My Skill', slug: 'my-skill', source: 'custom' });
  });
});
```

- [ ] **Step 2: Run — FAIL** `pnpm vitest run tests/unit/skill-label.test.ts`.

- [ ] **Step 3: Create `src/lib/workspace/skill-label.ts`:**

```ts
export type SkillLabelInput = {
  skillId: string | null;
  skill: { name: string; slug: string } | null;
  name: string | null;
  slug: string | null;
  source: string | null;
};

export type SkillLabel = { name: string; slug: string; source: string };

export function skillLabel(s: SkillLabelInput): SkillLabel {
  if (s.skillId && s.skill) return { name: s.skill.name, slug: s.skill.slug, source: 'catalog' };
  return { name: s.name ?? 'Untitled skill', slug: s.slug ?? 'skill', source: s.source ?? 'custom' };
}
```

- [ ] **Step 4: Run — PASS** `pnpm vitest run tests/unit/skill-label.test.ts`.
- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace/skill-label.ts tests/unit/skill-label.test.ts
git commit -m "feat: skillLabel resolves catalog vs custom skill display"
```

---

### Task B3: `artifact.ts` — custom SKILL.md + branch resolver (TDD)

**Files:**
- Modify: `src/lib/skills/artifact.ts`
- Create: `tests/unit/skill-artifact-custom.test.ts`

- [ ] **Step 1: Test** `tests/unit/skill-artifact-custom.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildCustomSkillMarkdown, buildInstalledSkillMarkdown } from '@/lib/skills/artifact';

describe('buildCustomSkillMarkdown', () => {
  it('emits frontmatter from attributes + content body', () => {
    const md = buildCustomSkillMarkdown({ slug: 'my-skill', name: 'My Skill', description: 'does X', content: '# Body\n\nsteps', userInvocable: true, agentInvocable: false, effort: 'high' });
    expect(md).toContain('name: my-skill');
    expect(md).toContain('description: "does X"');
    expect(md).toContain('agent-invocable: false');
    expect(md).toContain('effort: high');
    expect(md).toContain('# Body');
  });
});

describe('buildInstalledSkillMarkdown', () => {
  it('uses catalog synthesis when skill present', () => {
    const md = buildInstalledSkillMarkdown({ skillId: 's1', skill: { slug: 'pdf', name: 'PDF', description: 'x', author: 'a' } });
    expect(md).toContain('name: pdf');
  });
  it('uses custom content when skill null', () => {
    const md = buildInstalledSkillMarkdown({ skillId: null, skill: null, slug: 'c', name: 'C', content: '# Hi', userInvocable: true, agentInvocable: true });
    expect(md).toContain('# Hi');
  });
});
```

- [ ] **Step 2: Run — FAIL** `pnpm vitest run tests/unit/skill-artifact-custom.test.ts`.

- [ ] **Step 3:** Append to `src/lib/skills/artifact.ts` (after the existing `buildSkillMarkdown`; reuse the module-local `yamlString`):

```ts
type CustomSkillData = {
  slug?: string | null;
  name?: string | null;
  description?: string | null;
  content?: string | null;
  userInvocable?: boolean;
  agentInvocable?: boolean;
  effort?: string | null;
};

export function buildCustomSkillMarkdown(s: CustomSkillData): string {
  const slug = (s.slug || s.name || 'skill').trim();
  const description = (s.description || `${s.name ?? slug} agent skill.`).trim();
  const body = (s.content ?? '').trim() || `# ${s.name ?? slug}\n\n${description}`;
  return [
    '---',
    `name: ${slug}`,
    `description: ${yamlString(description)}`,
    `user-invocable: ${s.userInvocable !== false}`,
    `agent-invocable: ${s.agentInvocable !== false}`,
    `effort: ${s.effort || 'default'}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

export function buildInstalledSkillMarkdown(installed: {
  skillId: string | null;
  skill: { slug: string; name: string; description?: string | null; author?: string | null } | null;
} & CustomSkillData): string {
  if (installed.skillId && installed.skill) return buildSkillMarkdown(installed.skill);
  return buildCustomSkillMarkdown(installed);
}
```

- [ ] **Step 4: Run — PASS** `pnpm vitest run tests/unit/skill-artifact-custom.test.ts`.
- [ ] **Step 5: Commit**

```bash
git add src/lib/skills/artifact.ts tests/unit/skill-artifact-custom.test.ts
git commit -m "feat: build custom SKILL.md from content + attributes; branch resolver"
```

---

### Task B4: fix all nullable-`skill` consumers + agent integration

The B1 migration makes `installedSkill.skill` nullable, breaking every reader. Route display names through `skillLabel` (B2) and markdown through `buildInstalledSkillMarkdown` (B3). Custom skills must also work in agents.

**Files & exact changes:**

- [ ] **Step 1: `src/lib/agents/resolve.ts`** — replace the file with (carries custom fields through, filters out `agentInvocable === false`):

```ts
export type SkillForPrompt = {
  skillId: string | null;
  skill: { slug: string; name: string; description?: string | null; author?: string | null } | null;
  name?: string | null;
  slug?: string | null;
  description?: string | null;
  content?: string | null;
  userInvocable?: boolean;
  agentInvocable?: boolean;
  effort?: string | null;
};

type AttachedSkill = { installedSkill: { id: string } & SkillForPrompt };

export type LoadedAgentTools = {
  servers: { deploymentId: string }[];
  skills: AttachedSkill[];
  toolkits: { toolkit: { servers: { deploymentId: string }[]; skills: AttachedSkill[] } }[];
};

export function resolveAgentTools(agent: LoadedAgentTools): { deploymentIds: string[]; skills: SkillForPrompt[] } {
  const depSet = new Set<string>();
  const skillMap = new Map<string, SkillForPrompt>();
  for (const s of agent.servers) depSet.add(s.deploymentId);
  for (const s of agent.skills) skillMap.set(s.installedSkill.id, s.installedSkill);
  for (const tk of agent.toolkits) {
    for (const s of tk.toolkit.servers) depSet.add(s.deploymentId);
    for (const s of tk.toolkit.skills) skillMap.set(s.installedSkill.id, s.installedSkill);
  }
  const skills = [...skillMap.values()].filter((s) => s.agentInvocable !== false);
  return { deploymentIds: [...depSet], skills };
}
```

- [ ] **Step 2: `src/lib/agents/system-prompt.ts`** — replace with:

```ts
import 'server-only';
import { buildInstalledSkillMarkdown } from '@/lib/skills/artifact';
import { skillLabel } from '@/lib/workspace/skill-label';
import type { SkillForPrompt } from './resolve';

export function assembleSystemPrompt(systemPrompt: string | null | undefined, skills: SkillForPrompt[]): string {
  const sections: string[] = [];
  const base = systemPrompt?.trim();
  if (base) sections.push(base);
  for (const s of skills) {
    const label = skillLabel({ skillId: s.skillId, skill: s.skill, name: s.name ?? null, slug: s.slug ?? null, source: null });
    sections.push(`# Skill: ${label.name}\n\n${buildInstalledSkillMarkdown(s)}`);
  }
  return sections.join('\n\n---\n\n');
}
```

- [ ] **Step 3: Update agent unit tests** `tests/unit/agents-resolve.test.ts` and `tests/unit/agents-system-prompt.test.ts`: in each test's `installedSkill` fixtures, replace `skill: { ... }` objects so they include `id`, and add `skillId` (set `skillId` to a truthy id and keep `skill` for catalog cases). For `assembleSystemPrompt` tests, the skill objects now need `skillId` + `skill` (catalog) or `skillId: null` + `content` (custom). Run `pnpm vitest run tests/unit/agents-resolve.test.ts tests/unit/agents-system-prompt.test.ts`, read the failures, and update the fixtures until green. (The two functions' public behavior — dedupe deployments, concatenate skill markdown — is unchanged for catalog skills.)

- [ ] **Step 4: List/inspector/download/manifest/agents/toolkits pages** — for each, route `installedSkill.skill.*` reads through `skillLabel` and markdown through `buildInstalledSkillMarkdown`. Apply per file:
  - `src/app/app/[workspace]/skills/page.tsx`: add `import { skillLabel } from '@/lib/workspace/skill-label';`. In the rows map, compute `const label = skillLabel(s);` and use `label.name` for the link text, `s.skill?.iconUrl` for the icon. Add a Draft/Published badge: `{label.source !== 'catalog' && s.status === 'draft' ? <span …>Draft</span> : null}` (the `status` scalar is returned by the existing `include`).
  - `src/app/app/[workspace]/skills/[installId]/page.tsx`: add imports `skillLabel` and `buildInstalledSkillMarkdown`. Replace `buildSkillMarkdown(install.skill)` with `buildInstalledSkillMarkdown(install)`, and `install.skill.name`/`install.skill.slug` with `skillLabel(install).name`/`skillLabel(install).slug`. (B11 will replace this page with the editor for custom skills; this keeps it compiling/read-only meanwhile.)
  - `src/app/api/v1/skills/[installId]/download/route.ts`: replace the `buildSkillMarkdown(install.skill)` call with `buildInstalledSkillMarkdown(install)` (import it); use `skillLabel(install).slug` for the download filename if the route names the file by slug.
  - `src/app/api/v1/workspaces/[slug]/manifest/route.ts`: `name: skillLabel(i).name, slug: skillLabel(i).slug` for the `installedSkills.map`.
  - `src/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/manifest/route.ts`: `name: skillLabel(s.installedSkill).name, slug: skillLabel(s.installedSkill).slug`.
  - `src/app/app/[workspace]/agents/[agentId]/page.tsx`: `label: skillLabel(s).name` for the skills map.
  - `src/app/app/[workspace]/toolkits/[slug]/page.tsx`: replace each `*.installedSkill.skill.name` / `*.skill.name` skill read with `skillLabel(...)` (import it).
  Each file using `skillLabel` imports it from `@/lib/workspace/skill-label`.

- [ ] **Step 5: Verify** `pnpm exec tsc --noEmit` → **0 errors**. Then `pnpm test` → all pass.
  - **Contingency:** if tsc reports that the agent's `skills[].installedSkill` is missing `content`/`agentInvocable`/`name`/etc. (because `lib/agents/queries.ts` `getAgentForRequest` loads the agent's `skills.installedSkill` via `select` rather than `include`), change that query so `installedSkill` is loaded with `include: { skill: true }` (which returns all `InstalledSkill` scalar columns) instead of a narrow `select`. Add `lib/agents/queries.ts` to this task's commit if you touch it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agents/resolve.ts src/lib/agents/system-prompt.ts tests/unit/agents-resolve.test.ts tests/unit/agents-system-prompt.test.ts "src/app/app/[workspace]/skills/page.tsx" "src/app/app/[workspace]/skills/[installId]/page.tsx" "src/app/api/v1/skills/[installId]/download/route.ts" "src/app/api/v1/workspaces/[slug]/manifest/route.ts" "src/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/manifest/route.ts" "src/app/app/[workspace]/agents/[agentId]/page.tsx" "src/app/app/[workspace]/toolkits/[slug]/page.tsx"
git commit -m "fix: handle nullable catalog skill across consumers; custom skills work in agents"
```

---

### Task B5: `custom-skill.ts` validation + `lib/skills/actions.ts`

**Files:**
- Create: `src/lib/skills/custom-skill.ts`
- Create: `tests/unit/custom-skill-validate.test.ts`
- Create: `src/lib/skills/actions.ts`

- [ ] **Step 1: Test** `tests/unit/custom-skill-validate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseCreateSkill, isGithubUrl, githubRawSkillUrl } from '@/lib/skills/custom-skill';

describe('parseCreateSkill', () => {
  it('derives a slug from the name', () => {
    expect(parseCreateSkill({ name: 'My Cool Skill', description: 'x' })).toEqual({ name: 'My Cool Skill', description: 'x', slug: 'my-cool-skill' });
  });
  it('rejects empty name', () => {
    expect(() => parseCreateSkill({ name: '  ', description: '' })).toThrow();
  });
});

describe('github helpers', () => {
  it('accepts github urls only', () => {
    expect(isGithubUrl('https://github.com/org/repo')).toBe(true);
    expect(isGithubUrl('https://evil.com/org/repo')).toBe(false);
  });
  it('maps repo url to a raw SKILL.md url', () => {
    expect(githubRawSkillUrl('https://github.com/org/repo/tree/main')).toBe('https://raw.githubusercontent.com/org/repo/HEAD/SKILL.md');
  });
});
```

- [ ] **Step 2: Run — FAIL** `pnpm vitest run tests/unit/custom-skill-validate.test.ts`.

- [ ] **Step 3: Create `src/lib/skills/custom-skill.ts`:**

```ts
import { z } from 'zod';

const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/.*)?$/;

const createSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(80),
  description: z.string().trim().max(280).default(''),
});

export function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

export function parseCreateSkill(raw: unknown): { name: string; description: string; slug: string } {
  const v = createSchema.parse(raw);
  return { name: v.name, description: v.description, slug: slugify(v.name) };
}

export function isGithubUrl(u: string): boolean {
  return GITHUB_URL.test(u.trim());
}

export function githubRawSkillUrl(repoUrl: string): string {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/.exec(repoUrl.trim());
  if (!m) throw new Error('invalid github url');
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/SKILL.md`;
}
```

- [ ] **Step 4: Run — PASS** `pnpm vitest run tests/unit/custom-skill-validate.test.ts`.

- [ ] **Step 5: Create `src/lib/skills/actions.ts`:**

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { parseCreateSkill, isGithubUrl, githubRawSkillUrl, slugify } from './custom-skill';

const STARTER = `## What this skill does

Describe the capability.

## How to use it

Describe how an agent should invoke this skill.
`;

async function authedWs(slug: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  const ws = await getWorkspaceForUser(slug, user.id);
  return ws ? { user, ws } : null;
}

async function ownCustomSkill(installId: string, workspaceId: string) {
  return db.installedSkill.findFirst({ where: { id: installId, workspaceId, skillId: null } });
}

export async function createCustomSkillAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const ctx = await authedWs(slug);
  if (!ctx) return;
  let parsed;
  try {
    parsed = parseCreateSkill({ name: formData.get('name'), description: formData.get('description') ?? '' });
  } catch {
    return;
  }
  const created = await db.installedSkill.create({
    data: { workspaceId: ctx.ws.id, skillId: null, source: 'custom', name: parsed.name, slug: parsed.slug, description: parsed.description || null, content: STARTER, status: 'draft' },
  });
  redirect(`/app/${slug}/skills/${created.id}`);
}

export async function updateSkillContentAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const installId = String(formData.get('installId') ?? '');
  const ctx = await authedWs(slug);
  if (!ctx || !(await ownCustomSkill(installId, ctx.ws.id))) return;
  await db.installedSkill.update({ where: { id: installId }, data: { content: String(formData.get('content') ?? '') } });
  revalidatePath(`/app/${slug}/skills/${installId}`);
}

export async function updateSkillAttributesAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const installId = String(formData.get('installId') ?? '');
  const ctx = await authedWs(slug);
  if (!ctx || !(await ownCustomSkill(installId, ctx.ws.id))) return;
  await db.installedSkill.update({
    where: { id: installId },
    data: {
      description: String(formData.get('description') ?? '') || null,
      userInvocable: formData.get('userInvocable') === 'on',
      agentInvocable: formData.get('agentInvocable') === 'on',
      effort: String(formData.get('effort') ?? 'default'),
    },
  });
  revalidatePath(`/app/${slug}/skills/${installId}`);
}

export async function publishSkillAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const installId = String(formData.get('installId') ?? '');
  const ctx = await authedWs(slug);
  if (!ctx) return;
  const s = await ownCustomSkill(installId, ctx.ws.id);
  if (!s) return;
  await db.installedSkill.update({ where: { id: installId }, data: { status: s.status === 'published' ? 'draft' : 'published' } });
  revalidatePath(`/app/${slug}/skills/${installId}`);
}

export async function deleteCustomSkillAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const installId = String(formData.get('installId') ?? '');
  const ctx = await authedWs(slug);
  if (!ctx || !(await ownCustomSkill(installId, ctx.ws.id))) return;
  await db.installedSkill.deleteMany({ where: { id: installId, workspaceId: ctx.ws.id } });
  redirect(`/app/${slug}/skills`);
}

export async function importSkillFromGithubAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const repo = String(formData.get('repo') ?? '').trim();
  const ctx = await authedWs(slug);
  if (!ctx || !isGithubUrl(repo)) return;
  let content = '';
  try {
    const res = await fetch(githubRawSkillUrl(repo), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    content = (await res.text()).slice(0, 200_000);
  } catch {
    return;
  }
  const name = repo.replace(/\/$/, '').split('/').pop() || 'skill';
  const created = await db.installedSkill.create({
    data: { workspaceId: ctx.ws.id, skillId: null, source: 'github', sourceRef: repo, name, slug: slugify(name), content, status: 'draft' },
  });
  redirect(`/app/${slug}/skills/${created.id}`);
}

export async function uploadSkillFolderAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const ctx = await authedWs(slug);
  if (!ctx) return;
  let files: { path: string; content: string }[] = [];
  try {
    files = JSON.parse(String(formData.get('files') ?? '[]'));
  } catch {
    return;
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > 20) return;
  const skillMd = files.find((f) => /(^|\/)SKILL\.md$/i.test(f.path));
  const extra = files.filter((f) => f !== skillMd).slice(0, 19);
  const nm = name || 'Uploaded skill';
  const created = await db.installedSkill.create({
    data: { workspaceId: ctx.ws.id, skillId: null, source: 'upload', name: nm, slug: slugify(nm), content: skillMd?.content ?? '', files: extra.length ? extra : undefined, status: 'draft' },
  });
  redirect(`/app/${slug}/skills/${created.id}`);
}
```

- [ ] **Step 6: Verify** `pnpm exec tsc --noEmit` → 0 errors.
- [ ] **Step 7: Commit**

```bash
git add src/lib/skills/custom-skill.ts tests/unit/custom-skill-validate.test.ts src/lib/skills/actions.ts
git commit -m "feat: custom skill validation + actions (create/edit/publish/delete/import/upload)"
```

---

### Task B6: `AddSkillDialog` — 3 sources

**Files:**
- Create: `src/components/dashboard/AddSkillDialog.tsx`
- Create: `tests/unit/add-skill-dialog.test.tsx`

- [ ] **Step 1: Create `src/components/dashboard/AddSkillDialog.tsx`:**

```tsx
'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, FileText, Github, Upload } from 'lucide-react';
import { createCustomSkillAction, importSkillFromGithubAction, uploadSkillFolderAction } from '@/lib/skills/actions';

type Mode = 'menu' | 'create' | 'github' | 'upload';
const field =
  'h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';

export function AddSkillDialog({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('menu');
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const close = () => { setOpen(false); setMode('menu'); setFiles([]); };

  async function onPickFolder(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []).slice(0, 20);
    const read = await Promise.all(
      list.map(async (f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, content: (await f.text()).slice(0, 256_000) })),
    );
    setFiles(read);
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200">
        <Plus className="size-4" /> Add skill
      </button>

      {open
        ? createPortal(
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={close}>
              <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950" onClick={(e) => e.stopPropagation()}>
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Add a skill</h2>
                  <button type="button" onClick={close} className="text-zinc-400 hover:text-zinc-700"><X className="size-5" /></button>
                </div>

                {mode === 'menu' ? (
                  <div className="space-y-2">
                    <button type="button" onClick={() => setMode('github')} className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 p-3 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                      <Github className="size-5 text-zinc-500" /><span><span className="block text-sm font-medium">Import from GitHub</span><span className="block text-xs text-zinc-500">Pull a SKILL.md from a repo.</span></span>
                    </button>
                    <button type="button" onClick={() => setMode('upload')} className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 p-3 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                      <Upload className="size-5 text-zinc-500" /><span><span className="block text-sm font-medium">Upload a folder</span><span className="block text-xs text-zinc-500">Drag in a skill folder.</span></span>
                    </button>
                    <button type="button" onClick={() => setMode('create')} className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 p-3 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                      <FileText className="size-5 text-zinc-500" /><span><span className="block text-sm font-medium">Create new</span><span className="block text-xs text-zinc-500">Start from a blank SKILL.md.</span></span>
                    </button>
                  </div>
                ) : null}

                {mode === 'create' ? (
                  <form action={createCustomSkillAction} className="space-y-3">
                    <input type="hidden" name="workspace" value={slug} />
                    <input name="name" required placeholder="My awesome skill" className={field} />
                    <input name="description" placeholder="Summarize this skill's purpose" className={field} />
                    <button type="submit" className="h-9 w-full rounded-md bg-zinc-900 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Create skill</button>
                  </form>
                ) : null}

                {mode === 'github' ? (
                  <form action={importSkillFromGithubAction} className="space-y-3">
                    <input type="hidden" name="workspace" value={slug} />
                    <input name="repo" required placeholder="https://github.com/org/skill" className={`${field} font-mono`} />
                    <button type="submit" className="h-9 w-full rounded-md bg-zinc-900 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Import</button>
                  </form>
                ) : null}

                {mode === 'upload' ? (
                  <form action={uploadSkillFolderAction} className="space-y-3">
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="files" value={JSON.stringify(files)} />
                    <input name="name" placeholder="Skill name" className={field} />
                    {/* @ts-expect-error webkitdirectory is a non-standard attribute */}
                    <input type="file" webkitdirectory="" multiple onChange={onPickFolder} className="block w-full text-xs" />
                    <p className="text-xs text-zinc-500">{files.length} file(s) selected</p>
                    <button type="submit" disabled={files.length === 0} className="h-9 w-full rounded-md bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">Upload</button>
                  </form>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
```

- [ ] **Step 2: Create `tests/unit/add-skill-dialog.test.tsx`:**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddSkillDialog } from '@/components/dashboard/AddSkillDialog';

vi.mock('@/lib/skills/actions', () => ({
  createCustomSkillAction: vi.fn(),
  importSkillFromGithubAction: vi.fn(),
  uploadSkillFolderAction: vi.fn(),
}));

describe('AddSkillDialog', () => {
  it('shows three sources and reveals the create form', async () => {
    render(<AddSkillDialog slug="acme" />);
    await userEvent.click(screen.getByRole('button', { name: /add skill/i }));
    expect(screen.getByText('Import from GitHub')).toBeInTheDocument();
    expect(screen.getByText('Upload a folder')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Create new'));
    expect(screen.getByPlaceholderText('My awesome skill')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run — PASS** `pnpm vitest run tests/unit/add-skill-dialog.test.tsx`.
- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/AddSkillDialog.tsx tests/unit/add-skill-dialog.test.tsx
git commit -m "feat: Add skill dialog (Create new / GitHub / Upload folder)"
```

---

### Task B7: `SkillEditor` — custom skill editor

**Files:**
- Create: `src/components/dashboard/SkillEditor.tsx`

- [ ] **Step 1: Create `src/components/dashboard/SkillEditor.tsx`:**

```tsx
'use client';

import { useState } from 'react';
import { Streamdown } from 'streamdown';
import { updateSkillContentAction, updateSkillAttributesAction, publishSkillAction, deleteCustomSkillAction } from '@/lib/skills/actions';

type Props = {
  slug: string;
  installId: string;
  status: string;
  content: string;
  description: string;
  userInvocable: boolean;
  agentInvocable: boolean;
  effort: string;
};

const input = 'rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900';

export function SkillEditor(p: Props) {
  const [content, setContent] = useState(p.content);
  const [view, setView] = useState<'source' | 'rendered'>('source');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <form action={publishSkillAction}>
          <input type="hidden" name="workspace" value={p.slug} />
          <input type="hidden" name="installId" value={p.installId} />
          <button className="inline-flex h-8 items-center rounded-md bg-zinc-900 px-3 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
            {p.status === 'published' ? 'Unpublish' : 'Publish'}
          </button>
        </form>
        <span className="rounded-md border border-zinc-200 px-2 py-1 text-xs capitalize text-zinc-500 dark:border-zinc-700">{p.status}</span>
        <form action={deleteCustomSkillAction} className="ml-auto">
          <input type="hidden" name="workspace" value={p.slug} />
          <input type="hidden" name="installId" value={p.installId} />
          <button className="h-8 rounded-md border border-zinc-200 px-3 text-xs text-zinc-500 hover:border-red-200 hover:text-red-600 dark:border-zinc-700">Delete</button>
        </form>
      </div>

      <form action={updateSkillAttributesAction} className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <input type="hidden" name="workspace" value={p.slug} />
        <input type="hidden" name="installId" value={p.installId} />
        <label className="flex flex-col gap-1 text-xs text-zinc-500">Description<input name="description" defaultValue={p.description} className={`${input} w-64`} /></label>
        <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300"><input type="checkbox" name="userInvocable" defaultChecked={p.userInvocable} /> User-invocable</label>
        <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300"><input type="checkbox" name="agentInvocable" defaultChecked={p.agentInvocable} /> Agent-invocable</label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">Effort
          <select name="effort" defaultValue={p.effort} className={input}><option value="default">default</option><option value="low">low</option><option value="high">high</option></select>
        </label>
        <button className="h-8 rounded-md border border-zinc-200 px-3 text-xs font-medium dark:border-zinc-700">Save attributes</button>
      </form>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">SKILL.md</h2>
          <div className="flex gap-1 rounded-md border border-zinc-200 p-0.5 text-xs dark:border-zinc-700">
            <button type="button" onClick={() => setView('source')} className={`rounded px-2 py-1 ${view === 'source' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : ''}`}>Source</button>
            <button type="button" onClick={() => setView('rendered')} className={`rounded px-2 py-1 ${view === 'rendered' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : ''}`}>Rendered</button>
          </div>
        </div>
        {view === 'source' ? (
          <form action={updateSkillContentAction} className="space-y-2">
            <input type="hidden" name="workspace" value={p.slug} />
            <input type="hidden" name="installId" value={p.installId} />
            <textarea name="content" value={content} onChange={(e) => setContent(e.target.value)} rows={20} className="w-full rounded-md border border-zinc-200 bg-white p-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900" />
            <button className="h-9 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Save</button>
          </form>
        ) : (
          <div className="prose prose-sm max-w-none rounded-md border border-zinc-200 p-4 dark:prose-invert dark:border-zinc-700">
            <Streamdown>{content}</Streamdown>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify** `pnpm exec tsc --noEmit` → 0 errors. (Confirm `streamdown` exports `Streamdown` — it is already used for assistant replies; match that import. If the existing usage imports differently, mirror it.)
- [ ] **Step 3: Commit**

```bash
git add src/components/dashboard/SkillEditor.tsx
git commit -m "feat: custom skill editor (content, attributes, publish, delete, preview)"
```

---

### Task B8: skills list page — Add skill dialog + Draft badge

**Files:**
- Modify: `src/app/app/[workspace]/skills/page.tsx`

- [ ] **Step 1:** Add `import { AddSkillDialog } from '@/components/dashboard/AddSkillDialog';`. Replace the two "Add skill" `<Link href={…/skills/new}>` buttons (header + empty state) with `<AddSkillDialog slug={slug} />`. Keep the empty-state "Browse directory" link to `/tools/skills`. (The `skillLabel`/Draft-badge row changes were already applied in B4 Step 4.)
- [ ] **Step 2: Verify** `pnpm exec tsc --noEmit` → 0; `pnpm test` → all pass.
- [ ] **Step 3: Commit**

```bash
git add "src/app/app/[workspace]/skills/page.tsx"
git commit -m "feat: skills page uses Add skill dialog"
```

---

### Task B9: skill inspector — editable for custom

**Files:**
- Modify: `src/app/app/[workspace]/skills/[installId]/page.tsx`

- [ ] **Step 1:** Load the full installed skill (the query already loads `install`; ensure it selects/includes the custom scalars — with `include: { skill: {...} }` the scalars are returned automatically). Compute `const label = skillLabel(install);` and `const isCustom = !install.skillId;`. Import `SkillEditor`.
- [ ] **Step 2:** When `isCustom`, render `<SkillEditor slug={slug} installId={install.id} status={install.status} content={install.content ?? ''} description={install.description ?? ''} userInvocable={install.userInvocable} agentInvocable={install.agentInvocable} effort={install.effort} />` in place of the read-only "How to use / SKILL.md" sections. When catalog (`!isCustom`), keep the existing read-only view (already updated in B4 to use `buildInstalledSkillMarkdown(install)` / `skillLabel`). Use `label.name` for the header title in both cases.
- [ ] **Step 3: Verify** `pnpm exec tsc --noEmit` → 0 errors.
- [ ] **Step 4: Commit**

```bash
git add "src/app/app/[workspace]/skills/[installId]/page.tsx"
git commit -m "feat: skill inspector edits custom skills (catalog stays read-only)"
```

---

### Task B10: Phase B verification

- [ ] **Step 1:** `pnpm exec tsc --noEmit` → 0 errors.
- [ ] **Step 2:** `pnpm test` → all pass.
- [ ] **Step 3:** `pnpm build` → succeeds (`.next/BUILD_ID` written).
- [ ] **Step 4: Manual smoke** (`pnpm dev`, login smoke account): `/skills` → **Add skill** → **Create new** → name `My Skill` → lands on editor → edit SKILL.md → Save → toggle Rendered → set Agent-invocable + Save attributes → **Publish** → back on `/skills` shows Published. Create an agent, attach this skill, chat, and confirm the agent's system prompt includes the authored content (the skill influences a reply). Then `Add skill` → **Import from GitHub** with a repo containing a `SKILL.md` → confirm content imported. Download SKILL.md from a custom skill → confirm it's the authored content with frontmatter.
- [ ] **Step 5:** No commit unless smoke required a fix.

---

## Final review (after all tasks)

- [ ] `pnpm lint` introduces no new errors in changed files (pre-existing debt in `DashboardHeaderControls.tsx`/`ThemeToggle.tsx`/`mcp-tools.test.ts`/`last-ndc.ts` is out of scope).
- [ ] Dispatch a final whole-branch code review (`git diff main...HEAD`) focused on: workspace authz on every new action (no IDOR), SSRF limits on GitHub import (host-restricted, timeout, size cap), spawn arrays not shell strings, immutability, and that custom skills with `agentInvocable=false` are excluded from agents.
