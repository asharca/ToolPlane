// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
  effectiveStatus: vi.fn(),
  killProcess: vi.fn(),
  livePort: vi.fn(),
  restartProcess: vi.fn(),
  startProcess: vi.fn(),
  stopProcess: vi.fn(),
  copyDockerVolume: vi.fn(),
  removeDockerSandboxContainer: vi.fn(),
  removeDockerSandboxRuntimeStrict: vi.fn(),
  pullDockerImage: vi.fn(),
  stopDockerSandboxContainer: vi.fn(),
  resolveSpawnSpec: vi.fn(),
  agentRuntimeUpdateMany: vi.fn(),
  sandboxUpdateMany: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  transaction: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('@/lib/agents/queries', () => ({ getAgent: mocks.getAgent }));
vi.mock('@/lib/process/supervisor', () => ({
  effectiveStatus: mocks.effectiveStatus,
  killProcess: mocks.killProcess,
  livePort: mocks.livePort,
  restartProcess: mocks.restartProcess,
  startProcess: mocks.startProcess,
  stopProcess: mocks.stopProcess,
}));
vi.mock('@/lib/process/spawn-spec', () => ({ resolveSpawnSpec: mocks.resolveSpawnSpec }));
vi.mock('@/lib/sandboxes/runtime', () => ({
  copyDockerVolume: mocks.copyDockerVolume,
  removeDockerSandboxContainer: mocks.removeDockerSandboxContainer,
  removeDockerSandboxRuntimeStrict: mocks.removeDockerSandboxRuntimeStrict,
  pullDockerImage: mocks.pullDockerImage,
  sandboxContainerName: (id: string) => `sandbox-${id}`,
  sandboxSyncContainerName: (id: string) => `sandbox-${id}-sync`,
  sandboxVolumeName: (id: string) => `volume-${id}`,
  stopDockerSandboxContainer: mocks.stopDockerSandboxContainer,
}));
vi.mock('@/lib/db', () => ({
  db: {
    agentRuntime: { updateMany: mocks.agentRuntimeUpdateMany },
    sandbox: { updateMany: mocks.sandboxUpdateMany },
    deployment: { updateMany: mocks.deploymentUpdateMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: mocks.spawn,
}));

import {
  acquireHermesRuntimeWriteLease,
  cleanupHermesRuntime,
  copyHermesRuntimeVolume,
  ensureHermesDashboardReady,
  ensureHermesRuntimeReady,
  runHermesDashboardMutation,
  runHermesRuntimeMaintenance,
  stopHermesRuntime,
  syncHermesRuntime,
  upgradeHermesRuntime,
} from '@/lib/agents/hermes/runtime';

function deletingAgent() {
  return {
    id: 'agent-1',
    slug: 'agent-1',
    provider: { format: 'openai', baseUrl: 'https://example.test', apiKey: 'secret' },
    model: 'model-1',
    modelProviders: [{
      provider: {
        id: 'provider-1',
        name: 'Provider 1',
        format: 'openai',
        baseUrl: 'https://example.test',
        apiKey: 'secret',
        models: ['model-1'],
      },
    }],
    servers: [],
    skills: [],
    toolkits: [],
    sandboxes: [],
    subAgents: [],
    maxSteps: 8,
    runtime: {
      id: 'runtime-1',
      kind: 'hermes',
      image: 'hermes:test',
      status: 'running',
      configHash: null,
      configVersion: 1,
      sandboxId: 'sandbox-1',
      sandbox: {
        id: 'sandbox-1',
        workspaceId: 'workspace-1',
        image: 'hermes:test',
        config: { env: { EXISTING: 'value' } },
        deploymentId: 'deployment-1',
        deployment: {
          id: 'deployment-1',
          workspaceId: 'workspace-1',
          source: 'sandbox',
          sourceRef: 'hermes:test',
          status: 'deleting',
          installCfg: {},
        },
      },
    },
  };
}

function successfulDockerChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => child.emit('close', 0));
  return child;
}

function failedDockerChild(message: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stderr.write(message);
    child.emit('close', 1);
  });
  return child;
}

function volumeCopyAgent({
  agentId,
  runtimeId,
  sandboxId,
  deploymentId,
  deploymentStatus = 'stopped',
  runtimeStatus = 'setup_required',
  providerCount = 1,
}: {
  agentId: string;
  runtimeId: string;
  sandboxId: string;
  deploymentId: string;
  deploymentStatus?: string;
  runtimeStatus?: string;
  providerCount?: number;
}) {
  return {
    id: agentId,
    workspaceId: 'workspace-1',
    modelProviders: Array.from({ length: providerCount }, (_, index) => ({
      provider: { id: `provider-${index}` },
    })),
    runtime: {
      id: runtimeId,
      workspaceId: 'workspace-1',
      kind: 'hermes',
      image: 'hermes:test',
      status: runtimeStatus,
      configHash: null,
      configVersion: 1,
      lastSyncedAt: null,
      sandboxId,
      sandbox: {
        id: sandboxId,
        workspaceId: 'workspace-1',
        deploymentId,
        deployment: {
          id: deploymentId,
          workspaceId: 'workspace-1',
          source: 'sandbox',
          status: deploymentStatus,
          installCfg: {},
        },
      },
    },
  };
}

describe('Hermes sandbox lifecycle isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgent.mockResolvedValue(deletingAgent());
    mocks.effectiveStatus.mockImplementation((_deploymentId: string, status: string) => status);
    mocks.killProcess.mockResolvedValue(undefined);
    mocks.copyDockerVolume.mockResolvedValue(undefined);
    mocks.removeDockerSandboxRuntimeStrict.mockResolvedValue(undefined);
    mocks.stopDockerSandboxContainer.mockResolvedValue(undefined);
    mocks.pullDockerImage.mockResolvedValue(undefined);
    mocks.startProcess.mockResolvedValue(undefined);
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'sandbox' });
    mocks.agentRuntimeUpdateMany.mockResolvedValue({ count: 1 });
    mocks.sandboxUpdateMany.mockResolvedValue({ count: 1 });
    mocks.deploymentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => operation({
      agentRuntime: { updateMany: mocks.agentRuntimeUpdateMany },
      sandbox: { updateMany: mocks.sandboxUpdateMany },
      deployment: { updateMany: mocks.deploymentUpdateMany },
    }));
    mocks.spawn.mockImplementation(successfulDockerChild);
  });

  it('does not sync, start, restart, or stop a runtime retained for deletion', async () => {
    await expect(syncHermesRuntime('workspace-1', 'agent-1')).resolves.toEqual({
      status: 'deleting',
      error: 'The Hermes sandbox has a pending lifecycle operation.',
    });
    await expect(ensureHermesRuntimeReady('workspace-1', 'agent-1')).resolves.toEqual({
      error: 'The Hermes sandbox has a pending lifecycle operation.',
    });
    await expect(ensureHermesDashboardReady('workspace-1', 'agent-1')).resolves.toEqual({
      error: 'The Hermes sandbox has a pending lifecycle operation.',
    });
    await stopHermesRuntime('workspace-1', 'agent-1');

    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.restartProcess).not.toHaveBeenCalled();
    expect(mocks.stopProcess).not.toHaveBeenCalled();
    expect(mocks.deploymentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.agentRuntimeUpdateMany).not.toHaveBeenCalled();
  });

  it('allows explicit runtime cleanup while preserving the deleting status', async () => {
    await expect(cleanupHermesRuntime('workspace-1', 'agent-1')).resolves.toBe(true);

    expect(mocks.killProcess).toHaveBeenCalledWith('deployment-1', {
      preventRestart: true,
      finalStatus: 'deleting',
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'deployment-1',
        workspaceId: 'workspace-1',
        source: 'sandbox',
      },
      data: { status: 'deleting' },
    });
    expect(mocks.removeDockerSandboxRuntimeStrict).toHaveBeenCalledWith(
      'sandbox-1',
      'volume-sandbox-1',
      { timeoutMs: 4 * 60 * 60 * 1000 },
    );
  });

  it('rebuilds an unchanged projection only when an explicit sync is forced', async () => {
    const agent = deletingAgent();
    agent.runtime.status = 'stopped';
    agent.runtime.sandbox.deployment.status = 'stopped';
    (agent.runtime.sandbox.config.env as Record<string, string>).TELEGRAM_BOT_TOKEN =
      'legacy-channel-token';
    mocks.getAgent.mockResolvedValue(agent);
    mocks.agentRuntimeUpdateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(agent.runtime, data);
      return { count: 1 };
    });
    mocks.deploymentUpdateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(agent.runtime.sandbox.deployment, data);
      return { count: 1 };
    });

    await expect(syncHermesRuntime('workspace-1', agent.id, { start: false })).resolves.toEqual({
      status: 'setup_required',
    });
    expect(agent.runtime.configHash).toEqual(expect.any(String));

    mocks.killProcess.mockClear();
    mocks.spawn.mockClear();
    await expect(syncHermesRuntime('workspace-1', agent.id, { start: false })).resolves.toEqual({
      status: 'stopped',
    });
    expect(mocks.killProcess).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();

    await expect(syncHermesRuntime(
      'workspace-1',
      agent.id,
      { start: false, force: true },
    )).resolves.toEqual({ status: 'setup_required' });
    expect(mocks.killProcess).toHaveBeenCalledWith('deployment-1', undefined);
    expect(mocks.spawn).toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'sandbox-sandbox-1'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    const syncCreate = mocks.spawn.mock.calls.find(([, args]) => (
      Array.isArray(args) && args[0] === 'create' && args.includes('sandbox-sandbox-1-sync')
    ));
    expect(syncCreate?.[1]).toEqual(expect.arrayContaining(['--env', 'HERMES_HOME=/opt/data']));
    expect(String(syncCreate?.[1]?.at(-1))).toContain(
      "migrate(interactive=False, quiet=True) if callable(migrate) else None",
    );
    expect(String(syncCreate?.[1]?.at(-1))).toContain(
      'for path in /opt/data/config.yaml /opt/data/.env /opt/data/.toolplane-env-keys.json /opt/data/SOUL.md /opt/data/cron /opt/data/sessions /opt/data/logs /opt/data/memories /opt/data/pairing /opt/data/hooks /opt/data/image_cache /opt/data/audio_cache /opt/data/skills /opt/data/skill-bundles; do',
    );
    expect(String(syncCreate?.[1]?.at(-1))).toContain(
      '[ ! -e "$path" ] || chown -R "$(id -u hermes):$(id -g hermes)" "$path"; done; chown -R',
    );
    expect(String(syncCreate?.[1]?.at(-1))).not.toContain(
      'chown -R "$(id -u hermes):$(id -g hermes)" /opt/data; fi',
    );
    expect(String(syncCreate?.[1]?.at(-1))).toContain(
      'chown -R "$(id -u hermes):$(id -g hermes)" /opt/data/workspace 2>/dev/null || true; fi',
    );
    expect(mocks.sandboxUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 'sandbox-1', workspaceId: 'workspace-1' },
      data: { config: { env: { EXISTING: 'value' } } },
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        installCfg: expect.objectContaining({ env: { EXISTING: 'value' } }),
      }),
    }));
  });

  it('fails a rebuild without installing or restarting when Docker cannot remove the old container', async () => {
    const agent = deletingAgent();
    agent.runtime.sandbox.deployment.status = 'stopped';
    mocks.getAgent.mockResolvedValue(agent);
    mocks.spawn.mockImplementation((_command: string, args: string[]) => (
      args[0] === 'rm' && args[2] === 'sandbox-sandbox-1'
        ? failedDockerChild('Docker daemon unavailable')
        : successfulDockerChild()
    ));

    await expect(syncHermesRuntime(
      'workspace-1',
      agent.id,
      { force: true },
    )).resolves.toEqual({
      status: 'error',
      error: 'Docker daemon unavailable',
    });

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenCalledWith({
      where: { id: 'runtime-1', workspaceId: 'workspace-1' },
      data: { status: 'error', lastError: 'Docker daemon unavailable' },
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'deployment-1', workspaceId: 'workspace-1' },
      data: { status: 'error' },
    });
  });

  it('rejects an ancient imported config before stopping the current runtime', async () => {
    const agent = deletingAgent();
    agent.runtime.sandbox.deployment.status = 'running';
    mocks.getAgent.mockResolvedValue(agent);
    mocks.spawn.mockImplementation((_command: string, args: string[]) => (
      args[0] === 'run'
        ? failedDockerChild(
            'ToolPlane cannot safely sync this Hermes volume because config.yaml has _config_version 6, below Hermes supported migration floor 12.',
          )
        : successfulDockerChild()
    ));

    await expect(syncHermesRuntime(
      'workspace-1',
      agent.id,
      { force: true },
    )).resolves.toEqual({
      status: 'error',
      error: expect.stringContaining('_config_version 6'),
    });

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'run',
        '--read-only',
        '--user',
        'hermes',
        'volume-sandbox-1:/opt/data:ro',
        '/opt/hermes/.venv/bin/python',
      ]),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(mocks.killProcess).not.toHaveBeenCalled();
    expect(mocks.startProcess).not.toHaveBeenCalled();
  });

  it('does not report stopped when the strict Docker stop fails', async () => {
    const agent = deletingAgent();
    agent.runtime.sandbox.deployment.status = 'stopped';
    mocks.getAgent.mockResolvedValue(agent);
    mocks.stopDockerSandboxContainer.mockRejectedValueOnce(new Error('Docker daemon unavailable'));

    await expect(stopHermesRuntime('workspace-1', agent.id)).rejects.toThrow(
      'Could not stop the Hermes runtime: Docker daemon unavailable',
    );

    expect(mocks.agentRuntimeUpdateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'stopped' }),
    }));
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenCalledWith({
      where: { id: 'runtime-1', workspaceId: 'workspace-1' },
      data: {
        status: 'error',
        lastError: 'Could not stop the Hermes runtime: Docker daemon unavailable',
      },
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'deployment-1',
        workspaceId: 'workspace-1',
        source: 'sandbox',
      },
      data: { status: 'error' },
    });
  });

  it('serializes readiness and cleanup for the same Hermes agent', async () => {
    const agent = deletingAgent();
    agent.runtime.sandbox.deployment.status = 'stopped';
    mocks.getAgent.mockResolvedValue(agent);
    mocks.livePort.mockReturnValue(null);
    let releaseStart: (() => void) | undefined;
    mocks.startProcess.mockImplementation(() => new Promise<void>((resolve) => {
      releaseStart = resolve;
    }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      gateway_state: 'running',
      pid: 141,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const ready = ensureHermesRuntimeReady('workspace-serial', 'agent-1');
    await vi.waitFor(() => expect(mocks.startProcess).toHaveBeenCalledOnce());
    const cleanup = cleanupHermesRuntime('workspace-serial', 'agent-1');
    await Promise.resolve();
    expect(mocks.killProcess).not.toHaveBeenCalled();

    mocks.livePort.mockReturnValue(4312);
    releaseStart?.();

    await expect(ready).resolves.toEqual({ port: 4312 });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4312/hermes/health/detailed',
      expect.objectContaining({ cache: 'no-store' }),
    );
    await expect(cleanup).resolves.toBe(true);
    expect(mocks.killProcess).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('does not treat a live outer proxy as a healthy Hermes gateway', async () => {
    const agent = deletingAgent();
    agent.runtime.sandbox.deployment.status = 'stopped';
    mocks.getAgent.mockResolvedValue(agent);
    mocks.livePort.mockReturnValue(4312);
    const abort = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () => {
      abort.abort(new Error('stop readiness polling'));
      return new Response(JSON.stringify({
        gateway_state: 'startup_failed',
        pid: 141,
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(ensureHermesRuntimeReady('workspace-1', agent.id, {
      signal: abort.signal,
    })).rejects.toThrow('stop readiness polling');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4312/hermes/health/detailed',
      expect.objectContaining({ cache: 'no-store' }),
    );

    vi.unstubAllGlobals();
  });

  it('restores a default gateway left want-down by an inner Hermes stop', async () => {
    vi.useFakeTimers();
    const agent = deletingAgent();
    agent.runtime.sandbox.deployment.status = 'stopped';
    mocks.getAgent.mockResolvedValue(agent);
    mocks.livePort.mockReturnValue(4312);
    let healthReads = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/hermes/control/gateway/default/up')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      healthReads += 1;
      return new Response(JSON.stringify(healthReads === 1
        ? { gateway_state: 'stopped', pid: null }
        : { gateway_state: 'running', pid: 242 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const ready = ensureHermesRuntimeReady('workspace-1', agent.id);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(ready).resolves.toEqual({ port: 4312 });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4312/hermes/control/gateway/default/up',
      expect.objectContaining({ method: 'POST', cache: 'no-store' }),
    );
    expect(healthReads).toBe(2);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps a dashboard save in the lifecycle queue until its upstream write completes', async () => {
    const agent = deletingAgent();
    agent.runtime.sandbox.deployment.status = 'stopped';
    mocks.getAgent.mockResolvedValue(agent);
    mocks.livePort.mockReturnValue(4312);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const lease = acquireHermesRuntimeWriteLease('workspace-1', agent.id);
    expect(lease).not.toBeNull();

    let markWriteStarted!: () => void;
    let finishWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writeCanFinish = new Promise<void>((resolve) => { finishWrite = resolve; });
    const mutation = runHermesDashboardMutation(
      'workspace-1',
      agent.id,
      lease!,
      async () => {
        markWriteStarted();
        await writeCanFinish;
        return 'saved';
      },
    );
    await writeStarted;

    const stop = stopHermesRuntime('workspace-1', agent.id);
    await Promise.resolve();
    expect(mocks.stopProcess).not.toHaveBeenCalled();

    finishWrite();
    await expect(mutation).resolves.toBe('saved');
    lease?.release();
    await expect(stop).resolves.toBeUndefined();
    expect(mocks.stopProcess).toHaveBeenCalledWith('deployment-1');
    vi.unstubAllGlobals();
  });

  it('quiesces a live source, copies its volume, and leaves a syncable target', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
      deploymentStatus: 'running',
      runtimeStatus: 'running',
    });
    const target = volumeCopyAgent({
      agentId: 'target-agent',
      runtimeId: 'target-runtime',
      sandboxId: 'target-sandbox',
      deploymentId: 'target-deployment',
    });
    mocks.getAgent.mockImplementation(async (_workspaceId: string, agentId: string) => (
      agentId === source.id ? source : agentId === target.id ? target : null
    ));

    await expect(copyHermesRuntimeVolume('workspace-1', source.id, target.id)).resolves.toEqual({
      status: 'copied',
    });

    expect(mocks.killProcess).toHaveBeenCalledWith('source-deployment', { finalStatus: 'copying' });
    expect(mocks.stopDockerSandboxContainer).toHaveBeenCalledWith('source-sandbox');
    expect(mocks.copyDockerVolume).toHaveBeenCalledWith('volume-source-sandbox', 'volume-target-sandbox');
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'source-deployment',
      { kind: 'sandbox' },
      { awaitReady: false, workspaceId: 'workspace-1' },
    );
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'target-deployment',
        workspaceId: 'workspace-1',
        source: 'sandbox',
        status: 'stopped',
      },
      data: { status: 'copying' },
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'target-deployment', workspaceId: 'workspace-1', source: 'sandbox' },
      data: { status: 'stopped' },
    });
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'target-runtime',
        workspaceId: 'workspace-1',
        agentId: 'target-agent',
        sandboxId: 'target-sandbox',
        kind: 'hermes',
      },
      data: { status: 'copying', lastError: null },
    });
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenCalledWith({
      where: { id: 'target-runtime', workspaceId: 'workspace-1', agentId: 'target-agent' },
      data: expect.objectContaining({
        status: 'stopped',
        configHash: null,
        lastSyncedAt: null,
      }),
    });
    expect(mocks.copyDockerVolume.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.stopDockerSandboxContainer.mock.invocationCallOrder[0],
    );
  });

  it('cleans and leaves the target syncable when volume copy fails, then restores a live source', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
      deploymentStatus: 'running',
      runtimeStatus: 'running',
    });
    const target = volumeCopyAgent({
      agentId: 'target-agent',
      runtimeId: 'target-runtime',
      sandboxId: 'target-sandbox',
      deploymentId: 'target-deployment',
    });
    mocks.getAgent.mockImplementation(async (_workspaceId: string, agentId: string) => (
      agentId === source.id ? source : agentId === target.id ? target : null
    ));
    mocks.copyDockerVolume.mockRejectedValueOnce(new Error('copy exploded'));

    await expect(copyHermesRuntimeVolume('workspace-1', source.id, target.id)).resolves.toEqual({
      status: 'error',
      error: 'copy exploded',
    });

    expect(mocks.removeDockerSandboxRuntimeStrict).toHaveBeenCalledWith(
      'target-sandbox',
      'volume-target-sandbox',
    );
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'target-deployment', workspaceId: 'workspace-1', source: 'sandbox' },
      data: { status: 'stopped' },
    });
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenCalledWith({
      where: { id: 'target-runtime', workspaceId: 'workspace-1', agentId: 'target-agent' },
      data: expect.objectContaining({ status: 'stopped', lastError: 'copy exploded' }),
    });
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'source-deployment',
      { kind: 'sandbox' },
      { awaitReady: false, workspaceId: 'workspace-1' },
    );
  });

  it('treats a source without an initialized volume as an empty, valid clone', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
    });
    const target = volumeCopyAgent({
      agentId: 'target-agent',
      runtimeId: 'target-runtime',
      sandboxId: 'target-sandbox',
      deploymentId: 'target-deployment',
    });
    mocks.getAgent.mockImplementation(async (_workspaceId: string, agentId: string) => (
      agentId === source.id ? source : agentId === target.id ? target : null
    ));
    mocks.copyDockerVolume.mockRejectedValueOnce(new Error('no such volume: volume-source-sandbox'));

    await expect(copyHermesRuntimeVolume(
      'workspace-1',
      source.id,
      target.id,
      async () => ({ copiedRecords: true }),
    )).resolves.toEqual({ status: 'copied', data: { copiedRecords: true } });

    expect(mocks.removeDockerSandboxRuntimeStrict).not.toHaveBeenCalled();
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'target-deployment', workspaceId: 'workspace-1', source: 'sandbox' },
      data: { status: 'stopped' },
    });
  });

  it('keeps a copied target finalizable when the source cannot restart', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
      deploymentStatus: 'running',
      runtimeStatus: 'running',
    });
    const target = volumeCopyAgent({
      agentId: 'target-agent',
      runtimeId: 'target-runtime',
      sandboxId: 'target-sandbox',
      deploymentId: 'target-deployment',
    });
    mocks.getAgent.mockImplementation(async (_workspaceId: string, agentId: string) => (
      agentId === source.id ? source : agentId === target.id ? target : null
    ));
    mocks.startProcess.mockRejectedValueOnce(new Error('restart exploded'));

    await expect(copyHermesRuntimeVolume(
      'workspace-1',
      source.id,
      target.id,
      async () => ({ copiedRecords: true }),
    )).resolves.toEqual({
      status: 'copied',
      data: { copiedRecords: true },
      sourceRestartError: 'The source Hermes runtime could not be restarted after a volume copy: restart exploded',
    });

    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'target-deployment', workspaceId: 'workspace-1', source: 'sandbox' },
      data: { status: 'stopped' },
    });
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenCalledWith({
      where: { id: 'source-runtime', workspaceId: 'workspace-1' },
      data: expect.objectContaining({ status: 'error' }),
    });
  });

  it('cleans the target when mapping copied records fails', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
    });
    const target = volumeCopyAgent({
      agentId: 'target-agent',
      runtimeId: 'target-runtime',
      sandboxId: 'target-sandbox',
      deploymentId: 'target-deployment',
    });
    mocks.getAgent.mockImplementation(async (_workspaceId: string, agentId: string) => (
      agentId === source.id ? source : agentId === target.id ? target : null
    ));

    await expect(copyHermesRuntimeVolume(
      'workspace-1',
      source.id,
      target.id,
      async () => { throw new Error('mapping exploded'); },
    )).resolves.toEqual({ status: 'error', error: 'mapping exploded' });

    expect(mocks.removeDockerSandboxRuntimeStrict).toHaveBeenCalledWith(
      'target-sandbox',
      'volume-target-sandbox',
    );
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'target-deployment', workspaceId: 'workspace-1', source: 'sandbox' },
      data: { status: 'stopped' },
    });
  });

  it('refuses an agent outside the requested workspace before touching volumes', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
    });
    source.workspaceId = 'other-workspace';
    const target = volumeCopyAgent({
      agentId: 'target-agent',
      runtimeId: 'target-runtime',
      sandboxId: 'target-sandbox',
      deploymentId: 'target-deployment',
    });
    mocks.getAgent.mockImplementation(async (_workspaceId: string, agentId: string) => (
      agentId === source.id ? source : agentId === target.id ? target : null
    ));

    await expect(copyHermesRuntimeVolume('workspace-1', source.id, target.id)).resolves.toEqual({
      status: 'error',
      error: 'Source and target must be workspace-owned Hermes runtimes.',
    });

    expect(mocks.killProcess).not.toHaveBeenCalled();
    expect(mocks.copyDockerVolume).not.toHaveBeenCalled();
    expect(mocks.removeDockerSandboxRuntimeStrict).not.toHaveBeenCalled();
  });

  it('drains an active Hermes write lease before it snapshots the source volume', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
      deploymentStatus: 'running',
      runtimeStatus: 'running',
    });
    const target = volumeCopyAgent({
      agentId: 'target-agent',
      runtimeId: 'target-runtime',
      sandboxId: 'target-sandbox',
      deploymentId: 'target-deployment',
    });
    mocks.getAgent.mockImplementation(async (_workspaceId: string, agentId: string) => (
      agentId === source.id ? source : agentId === target.id ? target : null
    ));

    const activeWrite = acquireHermesRuntimeWriteLease('workspace-1', source.id);
    expect(activeWrite).not.toBeNull();
    const copy = copyHermesRuntimeVolume('workspace-1', source.id, target.id);

    await vi.waitFor(() => {
      expect(acquireHermesRuntimeWriteLease('workspace-1', source.id)).toBeNull();
    });
    expect(mocks.killProcess).not.toHaveBeenCalled();
    expect(mocks.copyDockerVolume).not.toHaveBeenCalled();

    activeWrite?.release();

    await expect(copy).resolves.toEqual({ status: 'copied' });
    expect(mocks.killProcess).toHaveBeenCalledWith('source-deployment', { finalStatus: 'copying' });
    expect(mocks.copyDockerVolume).toHaveBeenCalledWith('volume-source-sandbox', 'volume-target-sandbox');

    const nextWrite = acquireHermesRuntimeWriteLease('workspace-1', source.id);
    expect(nextWrite).not.toBeNull();
    nextWrite?.release();
  });

  it('serializes a Hermes snapshot behind write leases and resumes the source runtime', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
      deploymentStatus: 'running',
      runtimeStatus: 'running',
    });
    mocks.getAgent.mockResolvedValue(source);

    const activeWrite = acquireHermesRuntimeWriteLease('workspace-1', source.id);
    const maintenance = runHermesRuntimeMaintenance(
      'workspace-1',
      source.id,
      source.runtime.sandboxId,
      { quiesce: true, operationStatus: 'copying' },
      async ({ volumeName }) => {
        await mocks.copyDockerVolume(volumeName, 'snapshot-volume');
        return 'snapshotted';
      },
    );

    await vi.waitFor(() => {
      expect(acquireHermesRuntimeWriteLease('workspace-1', source.id)).toBeNull();
    });
    expect(mocks.killProcess).not.toHaveBeenCalled();

    activeWrite?.release();

    await expect(maintenance).resolves.toEqual({ status: 'completed', data: 'snapshotted' });
    expect(mocks.killProcess).toHaveBeenCalledWith('source-deployment', { finalStatus: 'copying' });
    expect(mocks.stopDockerSandboxContainer).toHaveBeenCalledWith('source-sandbox');
    expect(mocks.copyDockerVolume).toHaveBeenCalledWith('volume-source-sandbox', 'snapshot-volume');
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'source-deployment',
      { kind: 'sandbox' },
      { awaitReady: false, workspaceId: 'workspace-1' },
    );
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'source-deployment',
        workspaceId: 'workspace-1',
        source: 'sandbox',
        status: 'running',
      },
      data: { status: 'copying' },
    });
  });

  it('allows a ready recovery snapshot operation from restore_failed', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
      deploymentStatus: 'restore_failed',
      runtimeStatus: 'error',
    });
    mocks.getAgent.mockResolvedValue(source);

    await expect(runHermesRuntimeMaintenance(
      'workspace-1',
      source.id,
      source.runtime.sandboxId,
      { quiesce: false, allowRestoreFailed: true },
      async () => 'deleted',
    )).resolves.toEqual({ status: 'completed', data: 'deleted' });
  });

  it('reprojects current managed Hermes files after restoring a stopped volume', async () => {
    const base = deletingAgent();
    const agent = {
      ...base,
      workspaceId: 'workspace-1',
      runtime: {
        ...base.runtime,
        workspaceId: 'workspace-1',
        status: 'stopped',
        configHash: 'previous-projection' as string | null,
        configVersion: 6,
        sandbox: {
          ...base.runtime.sandbox,
          deployment: {
            ...base.runtime.sandbox.deployment,
            status: 'stopped',
          },
        },
      },
    };
    mocks.getAgent.mockResolvedValue(agent);
    mocks.agentRuntimeUpdateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(agent.runtime, data);
      return { count: 1 };
    });
    mocks.deploymentUpdateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(agent.runtime.sandbox.deployment, data);
      return { count: 1 };
    });

    await expect(runHermesRuntimeMaintenance(
      'workspace-1',
      agent.id,
      agent.runtime.sandboxId,
      { quiesce: true, operationStatus: 'restoring', reprojectAfter: true },
      async ({ volumeName }) => {
        await mocks.copyDockerVolume('snapshot-volume', volumeName, { replace: true });
        return undefined;
      },
    )).resolves.toEqual({ status: 'completed', data: undefined });

    expect(mocks.agentRuntimeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ configHash: null, configVersion: 0 }),
    }));
    expect(mocks.killProcess).toHaveBeenCalledWith('deployment-1', { finalStatus: 'restoring' });
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'stopped' }),
    }));
    expect(mocks.startProcess).not.toHaveBeenCalled();
  });

  it('pulls, replaces every persisted image reference, and rebuilds the same mutable tag safely', async () => {
    const agent = deletingAgent();
    agent.runtime.status = 'running';
    agent.runtime.sandbox.deployment.status = 'stopped';
    mocks.getAgent.mockResolvedValue(agent);
    mocks.agentRuntimeUpdateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(agent.runtime, data);
      return { count: 1 };
    });
    mocks.sandboxUpdateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(agent.runtime.sandbox, data);
      return { count: 1 };
    });
    mocks.deploymentUpdateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(agent.runtime.sandbox.deployment, data);
      return { count: 1 };
    });

    const targetImage = 'nousresearch/hermes-agent:latest';
    let markPullStarted!: () => void;
    let finishPull!: () => void;
    const pullStarted = new Promise<void>((resolve) => {
      markPullStarted = resolve;
    });
    const pullCanFinish = new Promise<void>((resolve) => {
      finishPull = resolve;
    });
    mocks.pullDockerImage.mockImplementationOnce(async () => {
      markPullStarted();
      await pullCanFinish;
    });

    const activeWrite = acquireHermesRuntimeWriteLease('workspace-1', agent.id);
    expect(activeWrite).not.toBeNull();
    const upgrade = upgradeHermesRuntime('workspace-1', agent.id, `  ${targetImage}  `);

    await pullStarted;
    expect(mocks.pullDockerImage).toHaveBeenCalledWith(targetImage, 15 * 60_000);
    expect(mocks.killProcess).not.toHaveBeenCalled();
    finishPull();

    // Let the completed pull schedule the upgrade's maintenance lease, then
    // verify it blocks new writes until the pre-existing write has drained.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const blockedWrite = acquireHermesRuntimeWriteLease('workspace-1', agent.id);
    blockedWrite?.release();
    expect(blockedWrite).toBeNull();
    expect(mocks.killProcess).not.toHaveBeenCalled();
    activeWrite?.release();

    await expect(upgrade).resolves.toEqual({ status: 'provisioning', image: targetImage });

    expect(mocks.killProcess).toHaveBeenNthCalledWith(1, 'deployment-1', {
      finalStatus: 'upgrading',
    });
    expect(mocks.killProcess).toHaveBeenNthCalledWith(2, 'deployment-1', {
      finalStatus: 'upgrading',
    });
    expect(mocks.spawn).toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'sandbox-sandbox-1'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ image: targetImage, status: 'upgrading', configHash: null }),
    }));
    expect(mocks.sandboxUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { image: targetImage },
    }));
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sourceRef: targetImage,
        status: 'upgrading',
        installCfg: expect.objectContaining({
          image: targetImage,
          sandboxId: 'sandbox-1',
          runtimeId: 'runtime-1',
          env: { EXISTING: 'value' },
        }),
      }),
    }));
    expect(agent.runtime.image).toBe(targetImage);
    expect(agent.runtime.sandbox.image).toBe(targetImage);
    expect(agent.runtime.sandbox.deployment.sourceRef).toBe(targetImage);
    expect(agent.runtime.sandbox.deployment.installCfg).toMatchObject({ image: targetImage });
    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: targetImage,
      installCfg: expect.objectContaining({ image: targetImage }),
    }));
  });

  it('keeps the old runtime untouched when pulling an upgrade image fails', async () => {
    const agent = deletingAgent();
    agent.runtime.sandbox.deployment.status = 'stopped';
    mocks.getAgent.mockResolvedValue(agent);
    mocks.pullDockerImage.mockRejectedValueOnce(new Error('registry unavailable'));

    await expect(upgradeHermesRuntime(
      'workspace-1',
      agent.id,
      'nousresearch/hermes-agent:v2026.8.3',
    )).resolves.toEqual({
      status: 'error',
      error: 'Could not pull Hermes image: registry unavailable',
    });

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.killProcess).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(agent.runtime.image).toBe('hermes:test');
    expect(agent.runtime.sandbox.deployment.sourceRef).toBe('hermes:test');
  });

  it('rejects an argument-shaped upgrade image before contacting Docker', async () => {
    await expect(upgradeHermesRuntime('workspace-1', 'agent-1', '--privileged')).resolves.toEqual({
      status: 'error',
      error: 'Enter a valid Docker image reference.',
    });

    expect(mocks.getAgent).not.toHaveBeenCalled();
    expect(mocks.pullDockerImage).not.toHaveBeenCalled();
  });
});
