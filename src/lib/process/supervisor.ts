import 'server-only';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { db } from '@/lib/db';
import { type SpawnSpec } from './spawn-spec';

type Entry = {
  child: ChildProcess;
  port: number | null;
  status: string;
  pid?: number;
  name: string;
  stopping?: boolean;
};

type Store = Map<string, Entry>;

// Persist the process table on globalThis so it survives dev hot-reload
// (module re-evaluation) while the Next server process stays alive.
const g = globalThis as unknown as { __mcpSupervisor?: Store };
function store(): Store {
  if (!g.__mcpSupervisor) g.__mcpSupervisor = new Map();
  return g.__mcpSupervisor;
}

const BUILTIN = path.join(process.cwd(), 'scripts', 'mcp-server.mjs');
const BRIDGE = path.join(process.cwd(), 'scripts', 'mcp-stdio-bridge.mjs');

// How long startProcess waits for the child to print `LISTENING <port>` before
// returning. A builtin server is ready in ~50ms; a custom MCP cold-start (npx
// fetch / uvx / docker pull) measured ~5s, so 3s was too short — it returned
// while still "provisioning". 15s covers a cold start; the process still flips
// to running in the background if it exceeds even this.
const READY_TIMEOUT_MS = 15000;

async function persist(deploymentId: string, status: string) {
  try {
    await db.deployment.update({ where: { id: deploymentId }, data: { status } });
  } catch {
    // deployment may have been removed; ignore
  }
}

export function liveStatus(deploymentId: string): string | null {
  return store().get(deploymentId)?.status ?? null;
}

// Active states require a live supervised process. When the process table has
// no entry for a deployment (e.g. after a dev-server restart cleared it), a DB
// 'running'/'provisioning' is stale — the real status is 'stopped'. Terminal DB
// states (stopped/error) are accurate as-is. Use this — not `liveStatus(id) ??
// dbStatus` — wherever a deployment's status is displayed.
const ACTIVE_STATES = new Set(['running', 'provisioning']);
export function effectiveStatus(deploymentId: string, dbStatus: string): string {
  const live = liveStatus(deploymentId);
  if (live) return live;
  return ACTIVE_STATES.has(dbStatus) ? 'stopped' : dbStatus;
}

export function livePort(deploymentId: string): number | null {
  return store().get(deploymentId)?.port ?? null;
}

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
    setTimeout(resolve, READY_TIMEOUT_MS);
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

export async function stopProcess(deploymentId: string): Promise<void> {
  const e = store().get(deploymentId);
  if (e) {
    e.stopping = true;
    if (e.child.exitCode === null) e.child.kill('SIGTERM');
    e.status = 'stopped';
  }
  await persist(deploymentId, 'stopped');
}

export async function restartProcess(deploymentId: string, spec: SpawnSpec): Promise<void> {
  await stopProcess(deploymentId);
  await new Promise((r) => setTimeout(r, 250));
  store().delete(deploymentId);
  await startProcess(deploymentId, spec);
}

export function killProcess(deploymentId: string): void {
  const e = store().get(deploymentId);
  if (e) {
    e.stopping = true;
    if (e.child.exitCode === null) e.child.kill('SIGKILL');
  }
  store().delete(deploymentId);
}

// Kill every supervised process for a set of deployments (e.g. when a
// workspace is deleted) so no child processes are left orphaned.
export function killMany(deploymentIds: string[]): void {
  for (const id of deploymentIds) killProcess(id);
}
