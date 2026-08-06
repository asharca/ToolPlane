// @vitest-environment node
import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
    __mcpSupervisorRuntime?: unknown;
  };
  delete globals.__mcpSupervisor;
  delete globals.__mcpSupervisorPersistQueues;
  delete globals.__mcpSupervisorLifecycleQueues;
  delete globals.__mcpSupervisorTombstones;
  delete globals.__mcpSupervisorWorkspaceTombstones;
  delete globals.__mcpSupervisorRuntime;
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

  it('does not duplicate a provisioning process owned by another worker', async () => {
    const deploymentId = 'adopted-provisioning';
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      path.join(registryDir, `${deploymentId}.json`),
      JSON.stringify({
        deploymentId,
        name: 'Already provisioning',
        pid: process.pid,
        port: null,
        status: 'provisioning',
        generation: 'other-worker-generation',
        phase: 'pulling-image',
        updatedAt: new Date().toISOString(),
      }),
    );

    await supervisor.startProcess(
      deploymentId,
      { kind: 'builtin', name: 'Should not spawn' },
      { awaitReady: false },
    );
    await Promise.resolve();

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.updateDeployment).toHaveBeenCalledWith({
      where: { id: deploymentId },
      data: { status: 'provisioning' },
    });
  });

  it('does not delete an unreadable cross-worker registry while it may be atomically replaced', () => {
    const deploymentId = 'temporarily-unreadable-registry';
    const file = path.join(registryDir, `${deploymentId}.json`);
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(file, '{"deploymentId":');

    expect(supervisor.effectiveStatus(deploymentId, 'running')).toBe('stopped');
    expect(existsSync(file)).toBe(true);
  });

  it('does not duplicate a launch while another worker holds the pre-registry launch lock', async () => {
    const deploymentId = 'launch-lock-held';
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      path.join(registryDir, `${deploymentId}.launch.lock`),
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        nonce: 'other-worker-lock',
      }),
    );

    await supervisor.startProcess(
      deploymentId,
      { kind: 'builtin', name: 'Locked launch' },
      { awaitReady: false },
    );
    await Promise.resolve();

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.updateDeployment).toHaveBeenCalledWith({
      where: { id: deploymentId },
      data: { status: 'provisioning' },
    });
  });

  it('recovers an expired launch lock before spawning a replacement', async () => {
    const deploymentId = 'launch-lock-expired';
    const child = createChild();
    mocks.spawn.mockReturnValue(child);
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      path.join(registryDir, `${deploymentId}.launch.lock`),
      JSON.stringify({
        pid: process.pid,
        createdAt: '2000-01-01T00:00:00.000Z',
        nonce: 'expired-worker-lock',
      }),
    );

    await supervisor.startProcess(
      deploymentId,
      { kind: 'builtin', name: 'Recovered launch' },
      { awaitReady: false },
    );

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(registryDir, `${deploymentId}.launch.lock`))).toBe(false);
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

  it('injects a stable container name into managed Docker bridge launches', async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);

    await supervisor.startProcess(
      'named-bridge',
      {
        kind: 'bridge',
        name: 'Named bridge',
        command: 'docker',
        args: ['run', '--rm', 'example/mcp'],
        env: {},
      },
      { awaitReady: false },
    );

    const options = mocks.spawn.mock.calls[0]?.[2] as { env?: Record<string, string> };
    const args = JSON.parse(options.env?.MCP_ARGS ?? '[]') as string[];
    expect(args.slice(0, 4)).toEqual(['run', '--name', 'toolplane-mcp-named-bridge', '--rm']);
  });

  it('publishes bridge phases and a redacted stderr-only runtime log generation', async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await supervisor.startProcess(
      'runtime-progress',
      {
        kind: 'bridge',
        name: 'Runtime progress',
        command: 'docker',
        args: [
          'run', '--rm', 'node:24-bookworm-slim',
          '--password', 'argv-password',
          'ssh://git:url-password@example.test/repo',
        ],
        env: { MCP_TOKEN: 'super-secret-value' },
        image: 'node:24-bookworm-slim',
      },
      { awaitReady: false },
    );

    const options = mocks.spawn.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(options.env).toMatchObject({
      MCP_CONTAINER_NAME: 'toolplane-mcp-runtime-progress',
      MCP_IMAGE: 'node:24-bookworm-slim',
      MCP_STARTUP_IDLE_TIMEOUT_MS: expect.any(String),
      MCP_STARTUP_MAX_TIMEOUT_MS: expect.any(String),
      MCP_RUNTIME_EVENT_TOKEN: expect.any(String),
    });
    const eventToken = options.env?.MCP_RUNTIME_EVENT_TOKEN;
    expect(eventToken).toEqual(expect.any(String));
    const starting = supervisor.getDeploymentRuntimeSnapshot('runtime-progress');
    expect(starting).toMatchObject({
      status: 'provisioning',
      phase: 'preparing-image',
      containerName: 'toolplane-mcp-runtime-progress',
    });
    expect(starting?.generation).toEqual(expect.any(String));

    // An MCP can write arbitrary stderr, so a phase-looking line without the
    // bridge's launch-private token must never alter runtime metadata.
    child.stderr.emit('data', Buffer.from(
      '[toolplane-runtime] {"type":"phase","phase":"forged-running","imageState":"forged"}\n',
    ));
    expect(supervisor.getDeploymentRuntimeSnapshot('runtime-progress')).toMatchObject({
      status: 'provisioning',
      phase: 'preparing-image',
    });

    child.stderr.emit('data', Buffer.from(
      '[toolplane-runtime] {"type":"phase","token":"' + eventToken
      + '","phase":"pulling-image","imageState":"pulling","containerState":"created"}\n'
      + 'MCP_TOKEN=super-sec',
    ));

    expect(supervisor.getDeploymentRuntimeSnapshot('runtime-progress')).toMatchObject({
      status: 'provisioning',
      phase: 'pulling-image',
      imageState: 'pulling',
      containerState: 'created',
    });
    // The configured secret is split across stderr chunks and has no newline
    // yet, so neither its prefix nor the event nonce may have reached logs.
    const incomplete = supervisor.getDeploymentRuntimeLogChunk('runtime-progress', { limit: 64 * 1024 });
    expect(incomplete.text).not.toContain('super-sec');
    expect(incomplete.text).not.toContain(eventToken!);

    child.stderr.emit('data', Buffer.from(
      'ret-value Authorization: Bearer another-secret argv-password url-password\n',
    ));
    const log = supervisor.getDeploymentRuntimeLogChunk('runtime-progress', { limit: 64 * 1024 });
    expect(log.generation).toBe(starting?.generation);
    expect(log.text).toContain('[REDACTED]');
    expect(log.text).not.toContain('super-secret-value');
    expect(log.text).not.toContain('super-sec');
    expect(log.text).not.toContain('ret-value');
    expect(log.text).not.toContain('another-secret');
    expect(log.text).not.toContain('argv-password');
    expect(log.text).not.toContain('url-password');
    expect(log.text).not.toContain(eventToken!);
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain(eventToken!);

    child.stdout.emit('data', Buffer.from('LISTENING 4580\n'));
    expect(supervisor.getDeploymentRuntimeSnapshot('runtime-progress')).toMatchObject({
      status: 'running',
      phase: 'ready',
    });
  });

  it('flushes a terminal unterminated stderr line only after redacting its configured secret', async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);

    await supervisor.startProcess(
      'runtime-terminal-tail',
      {
        kind: 'bridge',
        name: 'Terminal tail',
        command: 'docker',
        args: ['run', '--rm', 'node:24-bookworm-slim'],
        env: { MCP_TOKEN: 'terminal-known-secret' },
        image: 'node:24-bookworm-slim',
      },
      { awaitReady: false },
    );

    child.stderr.emit('data', Buffer.from('MCP_TOKEN=terminal-known-'));
    child.stderr.emit('data', Buffer.from('secret'));
    const beforeEnd = supervisor.getDeploymentRuntimeLogChunk('runtime-terminal-tail', { limit: 64 * 1024 });
    expect(beforeEnd.text).toBe('');

    // ChildProcess emits the stderr stream end/close after its exit; the
    // supervisor must flush that final line through the same redactor.
    child.stderr.emit('end');
    const afterEnd = supervisor.getDeploymentRuntimeLogChunk('runtime-terminal-tail', { limit: 64 * 1024 });
    expect(afterEnd.text).toContain('[REDACTED]');
    expect(afterEnd.text).not.toContain('terminal-known-secret');
    expect(afterEnd.text).not.toContain('terminal-known-');
  });

  it('omits an overlong unterminated stderr line instead of leaking a partial generic credential', async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);

    await supervisor.startProcess(
      'runtime-overlong-line',
      { kind: 'builtin', name: 'Overlong line' },
      { awaitReady: false },
    );
    child.stderr.emit('data', Buffer.from(
      'Authorization: Bearer generic-split-token-' + 'x'.repeat(300 * 1024),
    ));
    const omitted = supervisor.getDeploymentRuntimeLogChunk('runtime-overlong-line', { limit: 64 * 1024 });
    expect(omitted.text).toContain('omitted overlong stderr line');
    expect(omitted.text).not.toContain('generic-split-token');

    // Discard only until the next line break; later useful diagnostics remain.
    child.stderr.emit('data', Buffer.from('\nnormal diagnostic after omission\n'));
    const resumed = supervisor.getDeploymentRuntimeLogChunk('runtime-overlong-line', {
      cursor: omitted.nextCursor,
      limit: 64 * 1024,
    });
    expect(resumed.text).toContain('normal diagnostic after omission');
  });

  it('resets runtime log cursors for a new launch generation and retains terminal error logs', async () => {
    const first = createChild();
    const second = createChild();
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);

    await supervisor.startProcess(
      'runtime-generation',
      { kind: 'builtin', name: 'First run' },
      { awaitReady: false },
    );
    first.stderr.emit('data', Buffer.from('first run failed TOKEN=visible-secret\n'));
    const firstSnapshot = supervisor.getDeploymentRuntimeSnapshot('runtime-generation');
    const firstLog = supervisor.getDeploymentRuntimeLogChunk('runtime-generation', { limit: 64 * 1024 });
    expect(firstLog.text).toContain('first run failed');
    expect(firstLog.text).not.toContain('visible-secret');

    Object.assign(first, { exitCode: 1 });
    first.emit('exit', 1, null);
    expect(supervisor.getDeploymentRuntimeSnapshot('runtime-generation')).toMatchObject({
      status: 'error',
      phase: 'error',
      generation: firstSnapshot?.generation,
    });

    await supervisor.startProcess(
      'runtime-generation',
      { kind: 'builtin', name: 'Second run' },
      { awaitReady: false },
    );
    const secondSnapshot = supervisor.getDeploymentRuntimeSnapshot('runtime-generation');
    expect(secondSnapshot?.generation).not.toBe(firstSnapshot?.generation);
    const reset = supervisor.getDeploymentRuntimeLogChunk('runtime-generation', {
      generation: firstSnapshot?.generation,
      cursor: firstLog.nextCursor,
    });
    expect(reset).toMatchObject({
      generation: secondSnapshot?.generation,
      cursor: 0,
      nextCursor: 0,
      reset: true,
      text: '',
    });
  });

  it('does not report a stale active runtime snapshot after its process is gone', async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);
    await supervisor.startProcess(
      'stale-runtime',
      { kind: 'builtin', name: 'Stale runtime' },
      { awaitReady: false },
    );

    const globals = globalThis as typeof globalThis & {
      __mcpSupervisor?: unknown;
      __mcpSupervisorRuntime?: unknown;
    };
    delete globals.__mcpSupervisor;
    delete globals.__mcpSupervisorRuntime;
    vi.mocked(process.kill).mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === child.pid && signal === 0) {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    }) as typeof process.kill);

    expect(supervisor.getDeploymentRuntimeSnapshot('stale-runtime')).toMatchObject({
      status: 'stopped',
      phase: 'stopped',
    });
  });

  it('prefers a newer cross-worker registry generation over a cached runtime record', () => {
    const deploymentId = 'cross-worker-runtime';
    const logText = 'new worker is starting\n';
    const now = new Date().toISOString();
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      path.join(registryDir, `${deploymentId}.runtime.json`),
      JSON.stringify({
        deploymentId,
        pid: process.pid,
        status: 'error',
        phase: 'error',
        generation: 'old-generation',
        startedAt: now,
        updatedAt: now,
        logStartCursor: 0,
        logEndCursor: 0,
      }),
    );
    writeFileSync(path.join(registryDir, `${deploymentId}.log`), logText);
    writeFileSync(
      path.join(registryDir, `${deploymentId}.json`),
      JSON.stringify({
        deploymentId,
        name: 'New worker',
        pid: process.pid,
        port: null,
        status: 'provisioning',
        generation: 'new-generation',
        phase: 'pulling-image',
        imageState: 'pulling',
        logStartCursor: 0,
        logEndCursor: Buffer.byteLength(logText),
        updatedAt: now,
      }),
    );
    // Simulate a worker that previously cached the terminal record, then has
    // no local child after another worker launched the replacement.
    resetSupervisorGlobals();

    expect(supervisor.getDeploymentRuntimeSnapshot(deploymentId)).toMatchObject({
      status: 'provisioning',
      phase: 'pulling-image',
      generation: 'new-generation',
      imageState: 'pulling',
    });
    expect(supervisor.getDeploymentRuntimeLogChunk(deploymentId, { limit: 64 * 1024 })).toMatchObject({
      generation: 'new-generation',
      text: logText,
    });
    expect(supervisor.effectiveStatuses([{ id: deploymentId, status: 'error' }]).get(deploymentId))
      .toBe('provisioning');
  });

  it('reads live Docker output for the deployment container', async () => {
    const dockerLogs = createChild();
    mocks.spawn.mockReturnValue(dockerLogs);

    const reading = supervisor.getDeploymentContainerLogs('live-logs', {
      containerName: 'toolplane-mcp-live-logs',
      limit: 25,
    });
    dockerLogs.stdout.emit('data', Buffer.from('2026-08-05T09:00:00Z MCP started\n'));
    dockerLogs.emit('close', 0);

    await expect(reading).resolves.toMatchObject({
      containerName: 'toolplane-mcp-live-logs',
      source: 'docker',
      text: '2026-08-05T09:00:00Z MCP started\n',
    });
    expect(mocks.spawn).toHaveBeenCalledWith(
      'docker',
      ['logs', '--timestamps', '--tail', '25', 'toolplane-mcp-live-logs'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });
});
