# Custom MCP Install (npm) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace deploy a real, runnable MCP server from an npm package (e.g. `@modelcontextprotocol/server-everything`) via a "Deploy custom MCP" slide-over, fully integrated with the inspector, ToolPlayground, and agents.

**Architecture:** A new `scripts/mcp-stdio-bridge.mjs` spawns `npx -y <pkg>`, does the MCP stdio handshake once, and exposes the same HTTP JSON-RPC + `LISTENING <port>` surface the existing supervisor/gateway already speak — so nothing downstream changes. `Deployment.serverId` becomes nullable with added `source`/`sourceRef`/`name`/`installCfg` columns so custom installs never touch the public `Server` catalog.

**Tech Stack:** Next.js 16 (App Router, server actions), Prisma 7 + pg, Vitest 4, zod 4, Node `child_process`, **pnpm** (npm crashes in this repo).

**Spec:** `docs/superpowers/specs/2026-06-25-custom-mcp-install-design.md`

**Conventions for every task:** run all commands with `pnpm`. Type-check with `pnpm exec tsc --noEmit`. Commit messages omit any `Co-Authored-By` trailer (attribution disabled in this repo). After Task 4 (migration) the dev server must be restarted if running.

---

### Task 1: `spawn-spec.ts` — map a deployment to a spawn command (pure, TDD)

**Files:**
- Create: `src/lib/process/spawn-spec.ts`
- Test: `tests/unit/spawn-spec.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/spawn-spec.test.ts
import { describe, it, expect } from 'vitest';
import { buildSpawnSpec, resolveSpawnSpec } from '@/lib/process/spawn-spec';

describe('buildSpawnSpec', () => {
  it('maps npm to npx -y <pkg> with extra args', () => {
    expect(buildSpawnSpec('npm', 'mcp-server-fetch', ['--flag'])).toEqual({
      command: 'npx',
      args: ['-y', 'mcp-server-fetch', '--flag'],
    });
  });

  it('throws on unsupported sources', () => {
    expect(() => buildSpawnSpec('pypi', 'x', [])).toThrow(/Unsupported MCP source/);
  });
});

describe('resolveSpawnSpec', () => {
  it('returns a builtin spec for catalog deployments', () => {
    expect(
      resolveSpawnSpec({
        serverId: 'srv1',
        server: { name: 'GitHub' },
        name: null,
        source: null,
        sourceRef: null,
        installCfg: null,
      }),
    ).toEqual({ kind: 'builtin', name: 'GitHub' });
  });

  it('returns a bridge spec for custom deployments', () => {
    expect(
      resolveSpawnSpec({
        serverId: null,
        server: null,
        name: 'Fetcher',
        source: 'npm',
        sourceRef: 'mcp-server-fetch',
        installCfg: { env: { TOKEN: 'x' }, args: ['--v'] },
      }),
    ).toEqual({
      kind: 'bridge',
      name: 'Fetcher',
      command: 'npx',
      args: ['-y', 'mcp-server-fetch', '--v'],
      env: { TOKEN: 'x' },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/spawn-spec.test.ts`
Expected: FAIL — cannot resolve `@/lib/process/spawn-spec`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/process/spawn-spec.ts
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

export function buildSpawnSpec(
  source: string,
  ref: string,
  args: string[],
): { command: string; args: string[] } {
  if (source === 'npm') {
    return { command: 'npx', args: ['-y', ref, ...args] };
  }
  throw new Error(`Unsupported MCP source: ${source || '(none)'}`);
}

function readCfg(installCfg: unknown): { env: Record<string, string>; args: string[] } {
  const c = (installCfg ?? {}) as { env?: Record<string, string>; args?: string[] };
  return { env: c.env ?? {}, args: Array.isArray(c.args) ? c.args : [] };
}

export function resolveSpawnSpec(d: DeploymentForSpawn): SpawnSpec {
  if (d.serverId && d.server) {
    return { kind: 'builtin', name: d.server.name };
  }
  const { env, args } = readCfg(d.installCfg);
  const ref = d.sourceRef ?? '';
  const { command, args: cmdArgs } = buildSpawnSpec(d.source ?? '', ref, args);
  return { kind: 'bridge', name: d.name ?? ref || 'custom', command, args: cmdArgs, env };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/spawn-spec.test.ts`
Expected: PASS (5 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/process/spawn-spec.ts tests/unit/spawn-spec.test.ts
git commit -m "feat: spawn-spec maps deployments to builtin/bridge run commands"
```

---

### Task 2: `custom-mcp.ts` — validate + normalize form input (pure, TDD)

**Files:**
- Create: `src/lib/workspace/custom-mcp.ts`
- Test: `tests/unit/custom-mcp-validate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/custom-mcp-validate.test.ts
import { describe, it, expect } from 'vitest';
import { parseCustomMcpInput } from '@/lib/workspace/custom-mcp';

const base = { source: 'npm', packageRef: '@scope/server', name: 'My Server', env: [], args: '' };

describe('parseCustomMcpInput', () => {
  it('normalizes a valid npm input', () => {
    const out = parseCustomMcpInput({
      ...base,
      env: [{ key: 'API_KEY', value: 'abc' }],
      args: '--port 3000  --verbose',
    });
    expect(out).toEqual({
      source: 'npm',
      packageRef: '@scope/server',
      name: 'My Server',
      installCfg: { env: { API_KEY: 'abc' }, args: ['--port', '3000', '--verbose'] },
    });
  });

  it('rejects an invalid npm package name', () => {
    expect(() => parseCustomMcpInput({ ...base, packageRef: 'Bad Name!' })).toThrow();
  });

  it('rejects an invalid env var key', () => {
    expect(() => parseCustomMcpInput({ ...base, env: [{ key: '1BAD', value: 'x' }] })).toThrow();
  });

  it('rejects an empty name', () => {
    expect(() => parseCustomMcpInput({ ...base, name: '   ' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/custom-mcp-validate.test.ts`
Expected: FAIL — cannot resolve `@/lib/workspace/custom-mcp`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/workspace/custom-mcp.ts
import { z } from 'zod';

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const schema = z.object({
  source: z.literal('npm'),
  packageRef: z.string().trim().min(1).regex(NPM_NAME, 'invalid npm package name'),
  name: z.string().trim().min(1, 'name is required').max(80),
  env: z
    .array(z.object({ key: z.string().regex(ENV_KEY, 'invalid env var name'), value: z.string() }))
    .default([]),
  args: z.string().default(''),
});

export type ParsedCustomMcp = {
  source: 'npm';
  packageRef: string;
  name: string;
  installCfg: { env: Record<string, string>; args: string[] };
};

export function parseCustomMcpInput(raw: unknown): ParsedCustomMcp {
  const v = schema.parse(raw);
  const env: Record<string, string> = {};
  for (const row of v.env) env[row.key] = row.value;
  const args = v.args.split(/\s+/).filter(Boolean);
  return { source: v.source, packageRef: v.packageRef, name: v.name, installCfg: { env, args } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/custom-mcp-validate.test.ts`
Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace/custom-mcp.ts tests/unit/custom-mcp-validate.test.ts
git commit -m "feat: validate + normalize custom MCP install input (zod)"
```

---

### Task 3: `deployment-label.ts` — display name for catalog vs custom (pure, TDD)

**Files:**
- Create: `src/lib/workspace/deployment-label.ts`
- Test: `tests/unit/deployment-label.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/deployment-label.test.ts
import { describe, it, expect } from 'vitest';
import { deploymentLabel } from '@/lib/workspace/deployment-label';

describe('deploymentLabel', () => {
  it('uses the catalog server name for catalog deployments', () => {
    expect(
      deploymentLabel({ serverId: 's1', server: { name: 'Stripe' }, name: null, source: null, sourceRef: null }),
    ).toEqual({ name: 'Stripe', source: 'catalog', ref: null });
  });

  it('falls back to name/source/ref for custom deployments', () => {
    expect(
      deploymentLabel({ serverId: null, server: null, name: 'Fetcher', source: 'npm', sourceRef: 'mcp-server-fetch' }),
    ).toEqual({ name: 'Fetcher', source: 'npm', ref: 'mcp-server-fetch' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/deployment-label.test.ts`
Expected: FAIL — cannot resolve `@/lib/workspace/deployment-label`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/workspace/deployment-label.ts
export type LabelInput = {
  serverId: string | null;
  server: { name: string } | null;
  name: string | null;
  source: string | null;
  sourceRef: string | null;
};

export type DeploymentLabel = { name: string; source: string; ref: string | null };

export function deploymentLabel(d: LabelInput): DeploymentLabel {
  if (d.serverId && d.server) {
    return { name: d.server.name, source: 'catalog', ref: null };
  }
  return {
    name: d.name ?? d.sourceRef ?? 'Untitled server',
    source: d.source ?? 'custom',
    ref: d.sourceRef ?? null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/deployment-label.test.ts`
Expected: PASS (2 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace/deployment-label.ts tests/unit/deployment-label.test.ts
git commit -m "feat: deploymentLabel resolves catalog vs custom display name"
```

---

### Task 4: Prisma — nullable `serverId` + custom-source columns + migration

**Files:**
- Modify: `prisma/schema.prisma` (the `Deployment` model)
- Create: `prisma/migrations/<timestamp>_add_custom_deployments/` (generated)

- [ ] **Step 1: Edit the `Deployment` model**

Replace the existing `Deployment` model in `prisma/schema.prisma` with:

```prisma
model Deployment {
  id           String          @id @default(cuid())
  workspaceId  String
  workspace    Workspace       @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  serverId     String?
  server       Server?         @relation(fields: [serverId], references: [id], onDelete: Cascade)
  name         String?
  source       String?
  sourceRef    String?
  installCfg   Json?
  status       String          @default("provisioning")
  createdAt    DateTime        @default(now())
  updatedAt    DateTime        @updatedAt
  toolkitLinks ToolkitServer[]
  agentLinks   AgentServer[]

  @@unique([workspaceId, serverId])
}
```

(No change needed to `Server.deployments` — an optional relation back-references fine.)

- [ ] **Step 2: Validate the schema**

Run: `pnpm exec prisma validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀".

- [ ] **Step 3: Create + apply the migration**

Run: `pnpm exec prisma migrate dev --name add_custom_deployments`
Expected: a new migration folder is created and applied; "Your database is now in sync with your schema." and the client is regenerated. (Existing rows keep their non-null `serverId`; the column simply becomes nullable.)

- [ ] **Step 4: Verify types compile**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. (If the running dev server is open, restart it — Prisma 7 regenerates the client on disk but the live process keeps the old one.)

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: make Deployment.serverId nullable + add custom source columns"
```

---

### Task 4b: fix remaining nullable-`server` consumers (discovered during Task 4)

Making `Deployment.server` optional makes `tsc` flag every existing reader of `deployment.server.*`. Tasks 5/9/10 cover `actions.ts`, `mcp/page.tsx`, and the inspector. These **five additional files** also read it and must route name displays through `deploymentLabel` (Task 3), with `slug` falling back for custom installs:

- `src/app/api/v1/workspaces/[slug]/manifest/route.ts` — `name: deploymentLabel(d).name`, `slug: d.server?.slug ?? d.sourceRef ?? d.id`
- `src/app/api/v1/workspaces/[slug]/toolkits/[toolkitSlug]/manifest/route.ts` — `name: deploymentLabel(s.deployment).name`, `slug: s.deployment.server?.slug ?? s.deployment.sourceRef ?? s.deployment.id`
- `src/app/app/[workspace]/agents/[agentId]/page.tsx` — `label: deploymentLabel(d).name`
- `src/app/app/[workspace]/mcp/new/page.tsx` — `deployedIds` must drop nulls: `new Set(deployed.map((d) => d.serverId).filter((id): id is string => id !== null))`
- `src/app/app/[workspace]/toolkits/[slug]/page.tsx` — three reads → `deploymentLabel(...).name`

Each file that uses `deploymentLabel` imports it from `@/lib/workspace/deployment-label`. Verify with `pnpm exec tsc --noEmit` (only the Task 5/9/10 files should still error afterward). Commit: `fix: handle nullable catalog server in manifest/agents/toolkits readers`.

---

### Task 5: supervisor — `startProcess(deploymentId, spec)` + bridge branch

**Files:**
- Modify: `src/lib/process/supervisor.ts`
- Modify: `src/lib/workspace/actions.ts` (the deploy/start/restart callers)

- [ ] **Step 1: Update the supervisor's spawn logic**

In `src/lib/process/supervisor.ts`, add the import and replace the `SERVER` constant + `startProcess` + `restartProcess`.

Add near the top imports:

```ts
import { type SpawnSpec } from './spawn-spec';
```

Replace this line:

```ts
const SERVER = path.join(process.cwd(), 'scripts', 'mcp-server.mjs');
```

with:

```ts
const BUILTIN = path.join(process.cwd(), 'scripts', 'mcp-server.mjs');
const BRIDGE = path.join(process.cwd(), 'scripts', 'mcp-stdio-bridge.mjs');
```

Replace the whole `startProcess` function with:

```ts
export async function startProcess(deploymentId: string, spec: SpawnSpec): Promise<void> {
  const s = store();
  const existing = s.get(deploymentId);
  if (existing && existing.child.exitCode === null && !existing.stopping) return;

  const script = spec.kind === 'bridge' ? BRIDGE : BUILTIN;
  const env =
    spec.kind === 'bridge'
      ? {
          ...process.env,
          ...spec.env,
          MCP_PORT: '0',
          MCP_NAME: spec.name,
          MCP_COMMAND: spec.command,
          MCP_ARGS: JSON.stringify(spec.args),
        }
      : { ...process.env, MCP_PORT: '0', MCP_NAME: spec.name };

  const child = spawn(process.execPath, [script], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const entry: Entry = {
    child,
    port: null,
    status: 'provisioning',
    pid: child.pid,
    name: spec.name,
  };
  s.set(deploymentId, entry);
  await persist(deploymentId, 'provisioning');

  const ready = new Promise<void>((resolve) => {
    child.stdout?.on('data', (buf: Buffer) => {
      const m = /LISTENING (\d+)/.exec(buf.toString());
      if (m) {
        entry.port = Number(m[1]);
        entry.status = 'running';
        void persist(deploymentId, 'running');
        resolve();
      }
    });
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
    setTimeout(resolve, 3000);
  });

  child.on('exit', (code) => {
    entry.status = entry.stopping ? 'stopped' : code === 0 ? 'stopped' : 'error';
    void persist(deploymentId, entry.status);
  });
  child.on('error', () => {
    entry.status = 'error';
    void persist(deploymentId, 'error');
  });

  await ready;
}
```

Replace the whole `restartProcess` function with:

```ts
export async function restartProcess(deploymentId: string, spec: SpawnSpec): Promise<void> {
  await stopProcess(deploymentId);
  await new Promise((r) => setTimeout(r, 250));
  store().delete(deploymentId);
  await startProcess(deploymentId, spec);
}
```

- [ ] **Step 2: Update the callers in `actions.ts`**

In `src/lib/workspace/actions.ts`, add this import alongside the others:

```ts
import { resolveSpawnSpec } from '@/lib/process/spawn-spec';
```

In `deployServerAction`, replace:

```ts
  await startProcess(dep.id, server?.name ?? 'mcp');
```

with:

```ts
  await startProcess(dep.id, { kind: 'builtin', name: server?.name ?? 'mcp' });
```

In `startDeploymentAction`, replace:

```ts
  await startProcess(dep.id, dep.server.name);
```

with:

```ts
  await startProcess(dep.id, resolveSpawnSpec(dep));
```

In `restartDeploymentAction`, replace:

```ts
  await restartProcess(dep.id, dep.server.name);
```

with:

```ts
  await restartProcess(dep.id, resolveSpawnSpec(dep));
```

(`deploymentInWorkspace` already includes `server: { select: { name: true } }`; Prisma returns the new scalar columns automatically, so `dep` satisfies `DeploymentForSpawn`.)

- [ ] **Step 3: Verify types compile**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the existing test suite (no regressions)**

Run: `pnpm test`
Expected: all existing tests pass (the new Task 1–3 unit tests included).

- [ ] **Step 5: Commit**

```bash
git add src/lib/process/supervisor.ts src/lib/workspace/actions.ts
git commit -m "feat: supervisor spawns builtin or stdio-bridge per spawn spec"
```

---

### Task 6: stdio↔HTTP bridge script + fake-server fixture + integration test

**Files:**
- Create: `tests/fixtures/fake-stdio-mcp.mjs`
- Create: `scripts/mcp-stdio-bridge.mjs`
- Create: `tests/integration/stdio-bridge.test.ts`

- [ ] **Step 1: Write the fake stdio MCP server fixture**

```js
// tests/fixtures/fake-stdio-mcp.mjs
// Minimal newline-delimited JSON-RPC MCP server over stdio. Lets us test the
// bridge without any network access (no real npx download).
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  const { id, method } = msg;
  if (id === undefined || id === null) return; // notification, no reply
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' },
      },
    });
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: [{ name: 'ping_tool', description: 'returns pong', inputSchema: { type: 'object', properties: {} } }] },
    });
  } else if (method === 'tools/call') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'pong' }] } });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
}
```

- [ ] **Step 2: Write the failing integration test**

```ts
// tests/integration/stdio-bridge.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const BRIDGE = path.join(process.cwd(), 'scripts', 'mcp-stdio-bridge.mjs');
const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'fake-stdio-mcp.mjs');

function startBridge(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        MCP_PORT: '0',
        MCP_NAME: 'fake',
        MCP_COMMAND: process.execPath,
        MCP_ARGS: JSON.stringify([FIXTURE]),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('bridge did not print LISTENING')), 8000);
    proc.stdout.on('data', (b: Buffer) => {
      const m = /LISTENING (\d+)/.exec(b.toString());
      if (m) {
        clearTimeout(timer);
        resolve({ proc, port: Number(m[1]) });
      }
    });
    proc.on('error', reject);
  });
}

async function rpc(port: number, method: string, params?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  return res.json();
}

let proc: ChildProcess | undefined;
afterAll(() => {
  proc?.kill('SIGKILL');
});

describe('mcp-stdio-bridge', () => {
  it('handshakes then proxies tools/list and tools/call over HTTP', async () => {
    const started = await startBridge();
    proc = started.proc;

    const list = await rpc(started.port, 'tools/list');
    expect((list.result.tools as { name: string }[]).map((t) => t.name)).toContain('ping_tool');

    const call = await rpc(started.port, 'tools/call', { name: 'ping_tool', arguments: {} });
    expect(call.result.content[0].text).toBe('pong');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/integration/stdio-bridge.test.ts`
Expected: FAIL — bridge script does not exist, so it never prints LISTENING (rejects after 8s).

- [ ] **Step 4: Write the bridge implementation**

```js
// scripts/mcp-stdio-bridge.mjs
// Bridges a stdio MCP server (spawned from MCP_COMMAND/MCP_ARGS) to the HTTP
// JSON-RPC surface the rest of the app speaks. Holds ONE persistent stdio
// connection, performs the MCP initialize handshake once, then forwards each
// incoming HTTP JSON-RPC request onto that connection (remapping ids so
// concurrent callers can't collide). Prints `LISTENING <port>` once ready,
// mirroring scripts/mcp-server.mjs so the supervisor/gateway are unchanged.
import http from 'node:http';
import { spawn } from 'node:child_process';

const NAME = process.env.MCP_NAME || 'mcp';
const COMMAND = process.env.MCP_COMMAND;
const ARGS = JSON.parse(process.env.MCP_ARGS || '[]');
const PROTOCOL_VERSION = '2025-06-18';
const CALL_TIMEOUT_MS = 30000;

if (!COMMAND) {
  process.stderr.write('mcp-stdio-bridge: MCP_COMMAND is required\n');
  process.exit(1);
}

// Spawn the real MCP server; strip our control vars so they don't leak into it.
const childEnv = { ...process.env };
delete childEnv.MCP_COMMAND;
delete childEnv.MCP_ARGS;
delete childEnv.MCP_PORT;

const child = spawn(COMMAND, ARGS, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
child.on('error', (err) => {
  process.stderr.write(`mcp-stdio-bridge: spawn failed: ${err.message}\n`);
  process.exit(1);
});
child.on('exit', (code) => {
  process.stderr.write(`mcp-stdio-bridge: child exited (${code})\n`);
  process.exit(code ?? 1);
});
child.stderr.on('data', (b) => process.stderr.write(b));

// --- persistent stdio JSON-RPC plumbing ---
let nextId = 1;
const pending = new Map(); // ourId -> resolve(msg)
let buffer = '';
let initResult = null;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore non-JSON noise on stdout
    }
    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function callChild(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${method}`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notifyChild(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function handshake() {
  const reply = await callChild('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'toolplane-bridge', version: '1.0.0' },
  });
  initResult = reply.result ?? {};
  notifyChild('notifications/initialized', {});
}

// --- HTTP surface (mirrors scripts/mcp-server.mjs) ---
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', name: NAME }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on('end', async () => {
    let msg;
    try {
      msg = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    // Notifications: nothing to forward, no response body.
    if (msg.id === undefined || msg.id === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    // The child is already initialized; answer initialize from our stored result.
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: initResult }));
      return;
    }
    try {
      const reply = await callChild(msg.method, msg.params);
      reply.id = msg.id; // restore the caller's original id
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    } catch (err) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String((err && err.message) || err) } }),
      );
    }
  });
});

const shutdown = () => {
  try {
    child.kill('SIGTERM');
  } catch {}
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Orphan watchdog: self-terminate if the supervising parent dies.
const initialPpid = process.ppid;
setInterval(() => {
  if (process.ppid === 1 || process.ppid !== initialPpid) shutdown();
}, 2000).unref();

// Bring the child up, then start listening (so "running" means truly ready).
handshake()
  .then(() => {
    server.listen(Number(process.env.MCP_PORT || 0), '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      process.stdout.write(`LISTENING ${port}\n`);
    });
  })
  .catch((err) => {
    process.stderr.write(`mcp-stdio-bridge: handshake failed: ${err.message}\n`);
    process.exit(1);
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/integration/stdio-bridge.test.ts`
Expected: PASS — bridge prints LISTENING, `tools/list` contains `ping_tool`, `tools/call` returns `pong`.

- [ ] **Step 6: Commit**

```bash
git add scripts/mcp-stdio-bridge.mjs tests/fixtures/fake-stdio-mcp.mjs tests/integration/stdio-bridge.test.ts
git commit -m "feat: stdio<->HTTP MCP bridge with integration test"
```

---

### Task 7: `deployCustomServerAction` — create a custom deployment + start the bridge

**Files:**
- Modify: `src/lib/workspace/actions.ts`

- [ ] **Step 1: Add the server action**

In `src/lib/workspace/actions.ts`, add this import:

```ts
import { parseCustomMcpInput } from '@/lib/workspace/custom-mcp';
```

Then add this exported action (place it after `deployServerAction`):

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
      packageRef: String(formData.get('packageRef') ?? ''),
      name: String(formData.get('name') ?? ''),
      env: JSON.parse(String(formData.get('env') ?? '[]')),
      args: String(formData.get('args') ?? ''),
    });
  } catch {
    // Invalid input — the slide-over keeps client-side `required` guards.
    return;
  }

  const dep = await db.deployment.create({
    data: {
      workspaceId: ctx.ws.id,
      serverId: null,
      name: parsed.name,
      source: parsed.source,
      sourceRef: parsed.packageRef,
      installCfg: parsed.installCfg,
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

- [ ] **Step 2: Verify types compile**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/workspace/actions.ts
git commit -m "feat: deployCustomServerAction creates + starts a custom npm MCP"
```

---

### Task 8: realistic timeouts for real tool calls

**Files:**
- Modify: `src/lib/process/mcp-client.ts`
- Modify: `src/app/api/v1/mcp/[deploymentId]/rpc/route.ts`

Real MCP tools do network I/O; the current 2.5s/3s caps would abort them. Widen tool-call timeouts while keeping `tools/list` snappy.

- [ ] **Step 1: Add a `timeoutMs` parameter to `mcpRpc`**

In `src/lib/process/mcp-client.ts`, replace the `mcpRpc` signature line:

```ts
export async function mcpRpc(
  deploymentId: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
```

with:

```ts
export async function mcpRpc(
  deploymentId: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<Record<string, unknown> | null> {
```

In the same function, replace:

```ts
      signal: AbortSignal.timeout(2500),
```

with:

```ts
      signal: AbortSignal.timeout(timeoutMs),
```

Then make `listMcpTools` keep a short timeout — replace:

```ts
  const result = await mcpRpc(deploymentId, 'tools/list');
```

with:

```ts
  const result = await mcpRpc(deploymentId, 'tools/list', undefined, 5000);
```

(`buildToolSet` in `tools.ts` calls `mcpRpc(deploymentId, 'tools/call', …)` with no timeout arg, so it now gets the 30s default automatically — no change there.)

- [ ] **Step 2: Widen the gateway proxy timeout**

In `src/app/api/v1/mcp/[deploymentId]/rpc/route.ts`, replace:

```ts
        signal: AbortSignal.timeout(3000),
```

with:

```ts
        signal: AbortSignal.timeout(30000),
```

- [ ] **Step 3: Verify types + tests**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: no type errors; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/process/mcp-client.ts "src/app/api/v1/mcp/[deploymentId]/rpc/route.ts"
git commit -m "feat: widen MCP tool-call timeouts to 30s (keep tools/list at 5s)"
```

---

### Task 9: slide-over UI + list-page wiring + provisioning poll

**Files:**
- Create: `src/components/dashboard/DeployCustomMcpLauncher.tsx`
- Create: `src/components/dashboard/ProvisioningRefresher.tsx`
- Create: `tests/unit/deploy-custom-mcp-launcher.test.tsx`
- Modify: `src/app/app/[workspace]/mcp/page.tsx`

- [ ] **Step 1: Write the launcher (slide-over) component**

```tsx
// src/components/dashboard/DeployCustomMcpLauncher.tsx
'use client';

import { useState } from 'react';
import { Plus, X, Trash2, AlertTriangle } from 'lucide-react';
import { deployCustomServerAction } from '@/lib/workspace/actions';

const SOURCES = [
  { key: 'npm', label: 'npm', enabled: true },
  { key: 'pypi', label: 'PyPI', enabled: false },
  { key: 'github', label: 'GitHub', enabled: false },
  { key: 'docker', label: 'Docker', enabled: false },
];

type EnvRow = { key: string; value: string };

const field =
  'h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';
const labelCls = 'mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500';

export function DeployCustomMcpLauncher({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('npm');
  const [name, setName] = useState('');
  const [env, setEnv] = useState<EnvRow[]>([]);

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
        Deploy custom MCP
      </button>

      {open ? (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={() => setOpen(false)}>
          <div
            className="h-full w-full max-w-md overflow-y-auto border-l border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Deploy custom MCP</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-700">
                <X className="size-5" />
              </button>
            </div>

            <div className="mb-5 flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                MCP servers can access your data and execute arbitrary code. Only install servers from sources you trust.
              </span>
            </div>

            <form action={deployCustomServerAction} className="space-y-5">
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="source" value={source} />
              <input type="hidden" name="env" value={JSON.stringify(env)} />

              <div>
                <p className={labelCls}>Source</p>
                <div className="flex gap-1 rounded-md border border-zinc-200 p-1 dark:border-zinc-700">
                  {SOURCES.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      disabled={!s.enabled}
                      onClick={() => s.enabled && setSource(s.key)}
                      title={s.enabled ? undefined : 'Coming soon'}
                      className={`flex-1 rounded px-2 py-1.5 text-sm transition-colors ${
                        source === s.key
                          ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                          : 'text-zinc-600 dark:text-zinc-300'
                      } ${s.enabled ? 'hover:bg-zinc-100 dark:hover:bg-zinc-800' : 'cursor-not-allowed opacity-40'}`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className={labelCls}>NPM package</label>
                <input
                  name="packageRef"
                  required
                  placeholder="@modelcontextprotocol/server-everything"
                  className={`${field} font-mono`}
                />
              </div>

              <div>
                <label className={labelCls}>Server name</label>
                <input
                  name="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Weather API"
                  className={field}
                />
                <p className="mt-1 font-mono text-xs text-zinc-400">
                  /{slug}/mcp/{slugPreview}
                </p>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Environment variables</span>
                  <button
                    type="button"
                    onClick={() => setEnv((rows) => [...rows, { key: '', value: '' }])}
                    className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                  >
                    + Add
                  </button>
                </div>
                <div className="space-y-2">
                  {env.map((row, i) => (
                    <div key={i} className="flex gap-2">
                      <input
                        value={row.key}
                        onChange={(e) => setEnv((rows) => rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                        placeholder="KEY"
                        className={`${field} w-1/3 font-mono text-xs`}
                      />
                      <input
                        value={row.value}
                        onChange={(e) => setEnv((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                        placeholder="value"
                        className={`${field} flex-1 font-mono text-xs`}
                      />
                      <button
                        type="button"
                        onClick={() => setEnv((rows) => rows.filter((_, j) => j !== i))}
                        className="text-zinc-400 hover:text-red-600"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label className={labelCls}>Arguments</label>
                <input name="args" placeholder="--port 3000" className={`${field} font-mono`} />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-4 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
                >
                  Deploy
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
```

- [ ] **Step 2: Write the provisioning refresher**

```tsx
// src/components/dashboard/ProvisioningRefresher.tsx
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// While any deployment is provisioning (e.g. npx is still downloading a custom
// server), poll the server component so its status flips to running on its own.
export function ProvisioningRefresher({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
```

- [ ] **Step 3: Write the failing component test**

```tsx
// tests/unit/deploy-custom-mcp-launcher.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeployCustomMcpLauncher } from '@/components/dashboard/DeployCustomMcpLauncher';

vi.mock('@/lib/workspace/actions', () => ({ deployCustomServerAction: vi.fn() }));

describe('DeployCustomMcpLauncher', () => {
  it('opens the slide-over with npm enabled and other sources disabled', async () => {
    render(<DeployCustomMcpLauncher slug="acme" />);
    await userEvent.click(screen.getByRole('button', { name: /deploy custom mcp/i }));

    expect(screen.getByPlaceholderText(/server-everything/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'npm' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'PyPI' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Docker' })).toBeDisabled();
  });
});
```

- [ ] **Step 4: Run the component test**

Run: `pnpm vitest run tests/unit/deploy-custom-mcp-launcher.test.tsx`
Expected: PASS — the slide-over opens, the NPM-package field renders, the `npm` tab is enabled, and `PyPI`/`Docker` are disabled. (This is a render assertion, not strict red-green; the component from Step 1 is under test.)

- [ ] **Step 5: Wire the list page**

In `src/app/app/[workspace]/mcp/page.tsx`:

Add imports below the existing ones:

```ts
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { DeployCustomMcpLauncher } from '@/components/dashboard/DeployCustomMcpLauncher';
import { ProvisioningRefresher } from '@/components/dashboard/ProvisioningRefresher';
```

Replace the `DashboardHeader` `actions` prop value:

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

with:

```tsx
        actions={
          <div className="flex items-center gap-2">
            <DeployCustomMcpLauncher slug={slug} />
            <Link
              href={`/app/${slug}/mcp/new`}
              className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Browse MCPs
            </Link>
          </div>
        }
```

Immediately after `const deployments = await getDeployments(ws.id);`, add:

```ts
  const anyProvisioning = deployments.some(
    (d) => displayStatus(d.id, d.status) === 'provisioning',
  );
```

Right after the opening `<>` of the returned JSX, add:

```tsx
      <ProvisioningRefresher active={anyProvisioning} />
```

In the `deployments.map((d) => { ... })` row body, replace the server-cell block. Replace:

```tsx
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          {d.server.iconUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={d.server.iconUrl}
                              alt=""
                              width={20}
                              height={20}
                              className="size-5 rounded object-cover"
                            />
                          ) : (
                            <span className="size-5 rounded bg-zinc-200 dark:bg-zinc-700" />
                          )}
                          <Link
                            href={`/app/${slug}/mcp/${d.id}`}
                            className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                          >
                            {d.server.name}
                          </Link>
                        </div>
                      </td>
```

with:

```tsx
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          {d.server?.iconUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={d.server.iconUrl}
                              alt=""
                              width={20}
                              height={20}
                              className="size-5 rounded object-cover"
                            />
                          ) : (
                            <span className="size-5 rounded bg-zinc-200 dark:bg-zinc-700" />
                          )}
                          <Link
                            href={`/app/${slug}/mcp/${d.id}`}
                            className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                          >
                            {deploymentLabel(d).name}
                          </Link>
                          {deploymentLabel(d).source !== 'catalog' ? (
                            <span className="inline-flex items-center rounded-md border border-zinc-200 px-1.5 py-0.5 text-[11px] font-medium uppercase text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                              {deploymentLabel(d).source}
                            </span>
                          ) : null}
                        </div>
                      </td>
```

- [ ] **Step 6: Run the launcher test + type-check**

Run: `pnpm vitest run tests/unit/deploy-custom-mcp-launcher.test.tsx && pnpm exec tsc --noEmit`
Expected: test PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/dashboard/DeployCustomMcpLauncher.tsx src/components/dashboard/ProvisioningRefresher.tsx tests/unit/deploy-custom-mcp-launcher.test.tsx "src/app/app/[workspace]/mcp/page.tsx"
git commit -m "feat: Deploy custom MCP slide-over + provisioning auto-refresh"
```

---

### Task 10: inspector page — handle the nullable catalog server

**Files:**
- Modify: `src/app/app/[workspace]/mcp/[deploymentId]/page.tsx`

The inspector reads `dep.server.slug` / `dep.server.name`, which are null for custom deployments. Route them through `deploymentLabel`.

- [ ] **Step 1: Add the import**

Add below the existing imports:

```ts
import { deploymentLabel } from '@/lib/workspace/deployment-label';
```

- [ ] **Step 2: Compute the label after the `notFound()` guard**

Immediately after:

```ts
  if (!dep) notFound();
```

add:

```ts
  const label = deploymentLabel(dep);
```

- [ ] **Step 3: Replace the four `dep.server.*` references**

Breadcrumb — replace:

```tsx
          { label: dep.server.slug },
```

with:

```tsx
          { label: dep.server?.slug ?? label.name },
```

Heading — replace:

```tsx
              {dep.server.name}
```

with:

```tsx
              {label.name}
```

ConnectDialog — replace:

```tsx
              name={dep.server.name}
```

with:

```tsx
              name={label.name}
```

ReadyToConnectBanner — replace:

```tsx
            <ReadyToConnectBanner noun="server" endpoint={endpoint} name={dep.server.name} />
```

with:

```tsx
            <ReadyToConnectBanner noun="server" endpoint={endpoint} name={label.name} />
```

- [ ] **Step 4: Type-check + build**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add "src/app/app/[workspace]/mcp/[deploymentId]/page.tsx"
git commit -m "feat: inspector handles custom (no-catalog) deployments"
```

---

### Task 11: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all unit + integration tests pass (including `spawn-spec`, `custom-mcp-validate`, `deployment-label`, `stdio-bridge`, `deploy-custom-mcp-launcher`).

- [ ] **Step 3: Production build (full type-check)**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 4: Manual smoke (requires `pnpm dev` + Postgres up; downloads from npm)**

1. `docker compose up -d` (Postgres), then `pnpm dev`.
2. Log in (`smoke@example.com` / `password123`), go to `/app/<ws>/mcp`.
3. Click **Deploy custom MCP** → source **npm** → package `@modelcontextprotocol/server-everything` → name `Everything` → **Deploy**.
4. Row appears as `provisioning`, then flips to `running` (first npx run downloads — up to ~60s; the poll refreshes it).
5. Open the deployment → **Tools** tab → real tools list; run one in ToolPlayground and confirm a result.
6. Create/edit an agent, attach this server, chat, and confirm the agent can call a tool.

- [ ] **Step 5: Final commit (if any manual-fix tweaks were needed)**

```bash
git add -A
git commit -m "chore: custom MCP install verification fixes"
```

---

## Optional follow-up (not in this slice)

- Extend `e2e/dashboard.e2e.mjs` to deploy `@modelcontextprotocol/server-everything` and assert `tools/list` is non-empty (network-dependent; gate behind an env flag).
- Surface validation errors from `deployCustomServerAction` in the slide-over via `useActionState` instead of silently returning.
- Implement PyPI (`uvx`), GitHub (clone+build), Docker (`docker run`) in `buildSpawnSpec` and enable their source tabs.
