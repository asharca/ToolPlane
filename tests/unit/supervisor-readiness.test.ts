// @vitest-environment node
import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  updateDeployment: vi.fn(),
  ensureConnectorBroker: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mocks.spawn };
});

vi.mock('@/lib/db', () => ({
  db: { deployment: { update: mocks.updateDeployment } },
}));

vi.mock('@/lib/sandboxes/connector-broker', () => ({
  ensureConnectorBroker: mocks.ensureConnectorBroker,
}));

type Supervisor = typeof import('@/lib/process/supervisor');
type FakeChild = ChildProcess & {
  stdout: EventEmitter;
  stderr: EventEmitter;
};

const registryDir = path.join(
  os.tmpdir(),
  `toolplane-supervisor-readiness-${process.pid}-${Date.now()}`,
);
const originalRegistryDir = process.env.TOOLPLANE_SUPERVISOR_DIR;
let supervisor: Supervisor;
let nextPid = 99_000_000;

function createChild(
  exitOnSignals: Array<NodeJS.Signals | number> = ['SIGTERM', 'SIGKILL'],
): FakeChild {
  let exited = false;
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: null,
    stdio: [],
    pid: nextPid++,
    connected: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: process.execPath,
    killed: false,
    send: vi.fn(() => false),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
  }) as unknown as FakeChild;
  child.kill = vi.fn((signal: NodeJS.Signals | number = 'SIGTERM') => {
    if (exitOnSignals.includes(signal)) {
      queueMicrotask(() => {
        if (exited) return;
        exited = true;
        Object.assign(child, {
          exitCode: typeof signal === 'number' ? signal : null,
          signalCode: typeof signal === 'string' ? signal : null,
          killed: true,
        });
        child.emit('exit', child.exitCode, child.signalCode);
      });
    }
    return true;
  });
  return child;
}

function resetSupervisorGlobals() {
  const globals = globalThis as typeof globalThis & {
    __mcpSupervisor?: unknown;
    __mcpSupervisorPersistQueues?: unknown;
    __mcpSupervisorLifecycleQueues?: unknown;
    __mcpSupervisorTombstones?: unknown;
    __mcpSupervisorWorkspaceTombstones?: unknown;
  };
  delete globals.__mcpSupervisor;
  delete globals.__mcpSupervisorPersistQueues;
  delete globals.__mcpSupervisorLifecycleQueues;
  delete globals.__mcpSupervisorTombstones;
  delete globals.__mcpSupervisorWorkspaceTombstones;
}

beforeAll(async () => {
  process.env.TOOLPLANE_SUPERVISOR_DIR = registryDir;
  supervisor = await import('@/lib/process/supervisor');
});

beforeEach(() => {
  vi.useFakeTimers();
  mocks.spawn.mockReset();
  mocks.updateDeployment.mockReset().mockResolvedValue({});
  mocks.ensureConnectorBroker.mockReset().mockResolvedValue({
    port: 9322,
    internalUrl: 'http://127.0.0.1:9322',
    internalToken: 'internal-test-token',
  });
  nextPid = 99_000_000;
  vi.spyOn(process, 'kill').mockReturnValue(true);
  resetSupervisorGlobals();
  rmSync(registryDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  resetSupervisorGlobals();
  rmSync(registryDir, { recursive: true, force: true });
  if (originalRegistryDir === undefined) {
    delete process.env.TOOLPLANE_SUPERVISOR_DIR;
  } else {
    process.env.TOOLPLANE_SUPERVISOR_DIR = originalRegistryDir;
  }
});

describe('supervisor readiness races', () => {
  it('ignores a buffered LISTENING line after stop begins', async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);

    await supervisor.startProcess(
      'late-ready',
      { kind: 'builtin', name: 'Late ready' },
      { awaitReady: false },
    );
    await supervisor.stopProcess('late-ready');

    child.stdout.emit('data', Buffer.from('LISTENING 4567\n'));
    await Promise.resolve();

    const statuses = mocks.updateDeployment.mock.calls.map(
      ([input]) => input.data.status as string,
    );
    expect(statuses).toEqual(['provisioning', 'stopped']);
    expect(supervisor.liveStatus('late-ready')).toBeNull();
  });

  it('persists stopped after an earlier running write finishes late', async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);
    let storedStatus = '';
    let releaseRunning: (() => void) | undefined;
    let markRunningStarted: (() => void) | undefined;
    const runningStarted = new Promise<void>((resolve) => {
      markRunningStarted = resolve;
    });

    mocks.updateDeployment.mockImplementation(async (input) => {
      const status = input.data.status as string;
      if (status === 'running') {
        markRunningStarted?.();
        await new Promise<void>((resolve) => {
          releaseRunning = resolve;
        });
      }
      storedStatus = status;
      return {};
    });

    await supervisor.startProcess(
      'slow-running-write',
      { kind: 'builtin', name: 'Slow running write' },
      { awaitReady: false },
    );
    child.stdout.emit('data', Buffer.from('LISTENING 4568\n'));
    await runningStarted;

    const stopping = supervisor.stopProcess('slow-running-write');
    await Promise.resolve();
    expect(releaseRunning).toBeTypeOf('function');
    releaseRunning?.();
    await stopping;

    expect(storedStatus).toBe('stopped');
    expect(
      mocks.updateDeployment.mock.calls.map(([input]) => input.data.status as string),
    ).toEqual(['provisioning', 'running', 'stopped']);
  });

  it('signals the child before a slow provisioning write finishes', async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);
    let releaseProvisioning: (() => void) | undefined;
    let markProvisioningStarted: (() => void) | undefined;
    const provisioningStarted = new Promise<void>((resolve) => {
      markProvisioningStarted = resolve;
    });
    mocks.updateDeployment.mockImplementation(async (input) => {
      if (input.data.status === 'provisioning') {
        markProvisioningStarted?.();
        await new Promise<void>((resolve) => {
          releaseProvisioning = resolve;
        });
      }
      return {};
    });

    await supervisor.startProcess(
      'slow-provisioning-write',
      { kind: 'builtin', name: 'Slow provisioning write' },
      { awaitReady: false },
    );
    await provisioningStarted;
    const stopping = supervisor.stopProcess('slow-provisioning-write');
    await Promise.resolve();
    await Promise.resolve();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(releaseProvisioning).toBeTypeOf('function');
    releaseProvisioning?.();
    await stopping;
    expect(mocks.updateDeployment.mock.calls.at(-1)?.[0].data.status).toBe('stopped');
  });

  it('kills an adopted registry process before its running write finishes', async () => {
    const deploymentId = 'adopted-running';
    const pid = 99_123_456;
    let alive = true;
    vi.mocked(process.kill).mockImplementation(((target: number, signal?: number | NodeJS.Signals) => {
      if (target !== pid) return true;
      if (signal === 0) {
        if (alive) return true;
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      if (signal === 'SIGKILL') alive = false;
      return true;
    }) as typeof process.kill);
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      path.join(registryDir, `${deploymentId}.json`),
      JSON.stringify({
        deploymentId,
        name: 'Adopted',
        pid,
        port: 4571,
        status: 'running',
        updatedAt: new Date().toISOString(),
      }),
    );

    let releaseRunning: (() => void) | undefined;
    let markRunningStarted: (() => void) | undefined;
    const runningStarted = new Promise<void>((resolve) => {
      markRunningStarted = resolve;
    });
    mocks.updateDeployment.mockImplementation(async (input) => {
      if (input.data.status === 'running') {
        markRunningStarted?.();
        await new Promise<void>((resolve) => {
          releaseRunning = resolve;
        });
      }
      return {};
    });

    await supervisor.startProcess(
      deploymentId,
      { kind: 'builtin', name: 'Ignored replacement' },
      { awaitReady: false },
    );
    await runningStarted;
    const killing = supervisor.killProcess(deploymentId);
    await Promise.resolve();
    await Promise.resolve();

    expect(process.kill).toHaveBeenCalledWith(pid, 'SIGKILL');
    expect(releaseRunning).toBeTypeOf('function');
    releaseRunning?.();
    await killing;
    expect(mocks.updateDeployment.mock.calls.at(-1)?.[0].data.status).toBe('stopped');
  });

  it('serializes concurrent restarts without orphaning an intermediate child', async () => {
    const initial = createChild();
    const intermediate = createChild();
    const current = createChild();
    mocks.spawn
      .mockReturnValueOnce(initial)
      .mockReturnValueOnce(intermediate)
      .mockReturnValueOnce(current);

    await supervisor.startProcess(
      'concurrent-restart',
      { kind: 'builtin', name: 'Initial' },
      { awaitReady: false },
    );
    const firstRestart = supervisor.restartProcess(
      'concurrent-restart',
      { kind: 'builtin', name: 'Intermediate' },
      { awaitReady: false },
    );
    const secondRestart = supervisor.restartProcess(
      'concurrent-restart',
      { kind: 'builtin', name: 'Current' },
      { awaitReady: false },
    );

    await Promise.all([firstRestart, secondRestart]);

    expect(mocks.spawn).toHaveBeenCalledTimes(3);
    expect(initial.kill).toHaveBeenCalledWith('SIGTERM');
    expect(intermediate.kill).toHaveBeenCalledWith('SIGTERM');
    expect(current.kill).not.toHaveBeenCalled();

    current.stdout.emit('data', Buffer.from('LISTENING 4569\n'));
    await Promise.resolve();
    expect(supervisor.livePort('concurrent-restart')).toBe(4569);
  });

  it('ignores an old child exit after its replacement is running', async () => {
    const oldChild = createChild();
    const replacement = createChild();
    mocks.spawn.mockReturnValueOnce(oldChild).mockReturnValueOnce(replacement);

    await supervisor.startProcess(
      'old-exit',
      { kind: 'builtin', name: 'Old' },
      { awaitReady: false },
    );
    const restarting = supervisor.restartProcess(
      'old-exit',
      { kind: 'builtin', name: 'Replacement' },
      { awaitReady: false },
    );
    await restarting;

    replacement.stdout.emit('data', Buffer.from('LISTENING 4570\n'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.updateDeployment.mock.calls.at(-1)?.[0].data.status).toBe('running');
    const writesBeforeOldExit = mocks.updateDeployment.mock.calls.length;

    oldChild.emit('exit', 0);
    await Promise.resolve();

    expect(mocks.updateDeployment).toHaveBeenCalledTimes(writesBeforeOldExit);
    expect(
      mocks.updateDeployment.mock.calls.at(-1)?.[0].data.status,
    ).toBe('running');
    expect(supervisor.livePort('old-exit')).toBe(4570);
  });

  it('cancels a pending launch during destructive cleanup', async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);
    let releaseBroker: (() => void) | undefined;
    let markBrokerStarted: (() => void) | undefined;
    const brokerStarted = new Promise<void>((resolve) => {
      markBrokerStarted = resolve;
    });
    mocks.ensureConnectorBroker.mockImplementation(
      () => new Promise((resolve) => {
        markBrokerStarted?.();
        releaseBroker = () => resolve({
          port: 9322,
          internalUrl: 'http://127.0.0.1:9322',
          internalToken: 'internal-test-token',
        });
      }),
    );

    const starting = supervisor.startProcess(
      'pending-launch',
      {
        kind: 'sandbox',
        name: 'Pending connector',
        sandboxId: 'sandbox-pending',
        sandboxKind: 'connector',
        network: 'isolated',
        env: {},
      },
      { awaitReady: false },
    );
    await brokerStarted;
    const killing = supervisor.killProcess('pending-launch', { preventRestart: true });

    expect(releaseBroker).toBeTypeOf('function');
    releaseBroker?.();
    await Promise.all([starting, killing]);

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(supervisor.liveStatus('pending-launch')).toBeNull();
    expect(mocks.updateDeployment.mock.calls.at(-1)?.[0].data.status).toBe('stopped');
  });

  it('persists the destructive lifecycle status requested by the caller', async () => {
    await supervisor.killProcess('deleting-deployment', {
      preventRestart: true,
      finalStatus: 'deleting',
    });

    expect(mocks.updateDeployment.mock.calls.at(-1)?.[0].data.status).toBe('deleting');
  });

  it('blocks new deployment ids after workspace teardown begins', async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);
    supervisor.preventWorkspaceStarts('workspace-deleting');

    await supervisor.startProcess(
      'created-after-snapshot',
      { kind: 'builtin', name: 'Too late' },
      { awaitReady: false, workspaceId: 'workspace-deleting' },
    );

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.updateDeployment).not.toHaveBeenCalled();
  });

  it('escalates a slow SIGTERM to SIGKILL before replacement', async () => {
    const slowChild = createChild(['SIGKILL']);
    const replacement = createChild();
    mocks.spawn.mockReturnValueOnce(slowChild).mockReturnValueOnce(replacement);

    await supervisor.startProcess(
      'slow-termination',
      { kind: 'builtin', name: 'Slow termination' },
      { awaitReady: false },
    );
    const restarting = supervisor.restartProcess(
      'slow-termination',
      { kind: 'builtin', name: 'Replacement' },
      { awaitReady: false },
    );

    await vi.advanceTimersByTimeAsync(5000);
    await restarting;

    expect(slowChild.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(slowChild.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(replacement.kill).not.toHaveBeenCalled();
  });

  it('observes an immediate child exit while provisioning persistence is slow', async () => {
    const child = createChild([]);
    mocks.spawn.mockReturnValue(child);
    let releaseProvisioning: (() => void) | undefined;
    let markErrorPersisted: (() => void) | undefined;
    const errorPersisted = new Promise<void>((resolve) => {
      markErrorPersisted = resolve;
    });
    mocks.updateDeployment.mockImplementation(async (input) => {
      if (input.data.status === 'provisioning') {
        await new Promise<void>((resolve) => {
          releaseProvisioning = resolve;
        });
      }
      if (input.data.status === 'error') markErrorPersisted?.();
      return {};
    });

    const starting = supervisor.startProcess(
      'immediate-exit',
      { kind: 'builtin', name: 'Immediate exit' },
      { awaitReady: true },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    Object.assign(child, { exitCode: 1 });
    child.emit('exit', 1, null);
    await starting;

    expect(releaseProvisioning).toBeTypeOf('function');
    releaseProvisioning?.();
    await errorPersisted;
    expect(mocks.updateDeployment.mock.calls.at(-1)?.[0].data.status).toBe('error');
  });
});
