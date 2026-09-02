import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  deploymentFindFirst: vi.fn(),
  deploymentConfigFileFindMany: vi.fn(),
  deploymentCreate: vi.fn(),
  deploymentUpsert: vi.fn(),
  deploymentDeleteMany: vi.fn(),
  deploymentUpdate: vi.fn(),
  marketInstallUpdateMany: vi.fn(),
  serverFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  membershipFindUnique: vi.fn(),
  membershipCreate: vi.fn(),
  startProcess: vi.fn(),
  restartProcess: vi.fn(),
  liveStatus: vi.fn(),
  listMcpTools: vi.fn(),
  mcpRpc: vi.fn(),
  logRequest: vi.fn(),
  resolveSpawnSpec: vi.fn(),
  killProcess: vi.fn(),
  removeDeploymentContainer: vi.fn(),
  removeDeploymentConfigVolume: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/db', () => ({
  db: (() => {
    const client = {
    deployment: {
      findFirst: mocks.deploymentFindFirst,
      create: mocks.deploymentCreate,
      upsert: mocks.deploymentUpsert,
      deleteMany: mocks.deploymentDeleteMany,
      update: mocks.deploymentUpdate,
    },
    server: {
      findUnique: mocks.serverFindUnique,
    },
    deploymentConfigFile: {
      findMany: mocks.deploymentConfigFileFindMany,
    },
    user: {
      findUnique: mocks.userFindUnique,
    },
    membership: {
      findUnique: mocks.membershipFindUnique,
      create: mocks.membershipCreate,
    },
    marketInstall: { updateMany: mocks.marketInstallUpdateMany },
    };
    return {
      ...client,
      $transaction: (input: unknown) => typeof input === 'function'
        ? (input as (tx: typeof client) => unknown)(client)
        : Promise.all(input as Promise<unknown>[]),
    };
  })(),
}));
vi.mock('@/lib/process/supervisor', () => ({
  startProcess: mocks.startProcess,
  stopProcess: vi.fn(),
  restartProcess: mocks.restartProcess,
  killProcess: mocks.killProcess,
  liveStatus: mocks.liveStatus,
}));
vi.mock('@/lib/process/mcp-client', () => ({
  listMcpTools: mocks.listMcpTools,
  mcpRpc: mocks.mcpRpc,
}));
vi.mock('@/lib/observability/log', () => ({ logRequest: mocks.logRequest }));
vi.mock('@/lib/process/spawn-spec', () => ({ resolveSpawnSpec: mocks.resolveSpawnSpec }));
vi.mock('@/lib/process/deployment-config-volume', () => ({
  removeDeploymentConfigVolume: mocks.removeDeploymentConfigVolume,
}));
vi.mock('@/lib/process/deployment-runtime-container', () => ({
  removeDeploymentContainer: mocks.removeDeploymentContainer,
}));
vi.mock('@/lib/workspace/teardown', () => ({ killWorkspaceProcesses: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import {
  deployServerAction,
  deployCustomServerAction,
  cloneDeploymentAction,
  inviteWorkspaceMemberAction,
  removeDeploymentAction,
  renameDeploymentAction,
  revealMcpJsonConfigAction,
  runMcpConsoleToolAction,
  setDeploymentEnvAction,
  startDeploymentAction,
  restartDeploymentAction,
  rebuildDeploymentAction,
  updateMcpToolExposureAction,
  updateMcpJsonConfigAction,
} from '@/lib/workspace/actions';

function formData(deploymentId: string): FormData {
  const fd = new FormData();
  fd.set('workspace', 'mine');
  fd.set('deploymentId', deploymentId);
  return fd;
}

function inviteFormData(email: string): FormData {
  const fd = new FormData();
  fd.set('workspace', 'mine');
  fd.set('email', email);
  return fd;
}

function configFormData(deploymentId: string, config: unknown): FormData {
  const fd = formData(deploymentId);
  fd.set('config', typeof config === 'string' ? config : JSON.stringify(config));
  return fd;
}

function customMcpFormData(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) fd.set(key, value);
  return fd;
}

function deployFormData(serverId = 'server1'): FormData {
  const fd = new FormData();
  fd.set('workspace', 'mine');
  fd.set('serverId', serverId);
  return fd;
}

describe('deployServerAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
    mocks.liveStatus.mockReturnValue(null);
  });

  it('creates setup-required deployments without starting empty required variables', async () => {
    mocks.serverFindUnique.mockResolvedValue({
      id: 'server1',
      slug: 'firecrawl',
      name: 'Firecrawl',
      verifiedAt: new Date(),
      installCfg: { source: 'npm', ref: 'firecrawl-mcp', env: ['FIRECRAWL_API_KEY'] },
    });
    mocks.deploymentUpsert.mockResolvedValue({
      id: 'dep1',
      serverId: 'server1',
      name: null,
      source: 'npm',
      sourceRef: 'firecrawl-mcp',
      installCfg: { env: { FIRECRAWL_API_KEY: '' } },
      status: 'setup_required',
    });
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      workspaceId: 'ws1',
      serverId: 'server1',
      name: null,
      source: 'npm',
      sourceRef: 'firecrawl-mcp',
      installCfg: { env: { FIRECRAWL_API_KEY: '' }, requiredEnv: ['FIRECRAWL_API_KEY'] },
      status: 'setup_required',
      server: {
        name: 'Firecrawl',
        slug: 'firecrawl',
        installCfg: { source: 'npm', ref: 'firecrawl-mcp', env: ['FIRECRAWL_API_KEY'] },
      },
    });

    await deployServerAction(deployFormData());

    expect(mocks.deploymentUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        status: 'setup_required',
        installCfg: {
          env: { FIRECRAWL_API_KEY: '' },
          requiredEnv: ['FIRECRAWL_API_KEY'],
        },
      }),
    }));
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith('/app/mine/mcp/dep1?tab=variables');
  });

  it('preserves one-click startup for recipes without missing required variables', async () => {
    mocks.serverFindUnique.mockResolvedValue({
      id: 'server1',
      slug: 'memory',
      name: 'Memory',
      verifiedAt: new Date(),
      installCfg: { source: 'npm', ref: '@modelcontextprotocol/server-memory', env: [] },
    });
    mocks.deploymentUpsert.mockResolvedValue({
      id: 'dep1',
      serverId: 'server1',
      name: null,
      source: 'npm',
      sourceRef: '@modelcontextprotocol/server-memory',
      installCfg: { env: {} },
      status: 'provisioning',
    });
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      workspaceId: 'ws1',
      serverId: 'server1',
      name: null,
      source: 'npm',
      sourceRef: '@modelcontextprotocol/server-memory',
      installCfg: { env: {} },
      status: 'provisioning',
      server: {
        name: 'Memory',
        slug: 'memory',
        installCfg: { source: 'npm', ref: '@modelcontextprotocol/server-memory', env: [] },
      },
    });
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'bridge', command: 'docker', args: [] });

    await deployServerAction(deployFormData());

    expect(mocks.deploymentUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: 'provisioning' }),
    }));
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep1',
      { kind: 'bridge', command: 'docker', args: [] },
      expect.objectContaining({ awaitReady: false, workspaceId: 'ws1', onReady: expect.any(Function) }),
    );
    expect(mocks.redirect).toHaveBeenCalledWith('/app/mine/mcp/dep1');
  });
});

describe('removeDeploymentAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
    mocks.removeDeploymentContainer.mockResolvedValue(undefined);
    mocks.removeDeploymentConfigVolume.mockResolvedValue(undefined);
  });

  it('does not kill a process when the deployment is outside the workspace', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(null);

    await removeDeploymentAction(formData('foreign-dep'));

    expect(mocks.deploymentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'foreign-dep',
          workspaceId: 'ws1',
          OR: [{ source: null }, { source: { not: 'sandbox' } }],
        },
      }),
    );
    expect(mocks.killProcess).not.toHaveBeenCalled();
    expect(mocks.deploymentDeleteMany).not.toHaveBeenCalled();
  });

  it('kills and cleans the runtime container and configuration volume after workspace confirmation', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({ id: 'dep1', source: 'npm' });

    await removeDeploymentAction(formData('dep1'));

    expect(mocks.killProcess).toHaveBeenCalledWith('dep1', { preventRestart: true });
    expect(mocks.removeDeploymentContainer).toHaveBeenCalledWith('dep1');
    expect(mocks.removeDeploymentConfigVolume).toHaveBeenCalledWith('dep1');
    expect(mocks.killProcess.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeDeploymentContainer.mock.invocationCallOrder[0],
    );
    expect(mocks.removeDeploymentContainer.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeDeploymentConfigVolume.mock.invocationCallOrder[0],
    );
    expect(mocks.deploymentDeleteMany).toHaveBeenCalledWith({
      where: { id: 'dep1', workspaceId: 'ws1' },
    });
    expect(mocks.removeDeploymentConfigVolume.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deploymentDeleteMany.mock.invocationCallOrder[0],
    );
  });

  it('does not require Docker cleanup to remove a builtin deployment', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({ id: 'builtin1', source: null });

    await removeDeploymentAction(formData('builtin1'));

    expect(mocks.killProcess).toHaveBeenCalledWith('builtin1', { preventRestart: true });
    expect(mocks.removeDeploymentContainer).not.toHaveBeenCalled();
    expect(mocks.removeDeploymentConfigVolume).not.toHaveBeenCalled();
    expect(mocks.deploymentDeleteMany).toHaveBeenCalledWith({
      where: { id: 'builtin1', workspaceId: 'ws1' },
    });
  });

  it('excludes sandbox-backed deployments from generic lifecycle actions', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(null);

    await startDeploymentAction(formData('sandbox-dep'));

    expect(mocks.deploymentFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'sandbox-dep',
        OR: [{ source: null }, { source: { not: 'sandbox' } }],
      }),
    }));
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('starts deployments in provisioning mode without waiting for ready', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({ id: 'dep1', workspaceId: 'ws1' });
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'builtin' });

    await startDeploymentAction(formData('dep1'));

    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith({ id: 'dep1', workspaceId: 'ws1' });
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep1',
      { kind: 'builtin' },
      expect.objectContaining({ awaitReady: false, workspaceId: 'ws1', onReady: expect.any(Function) }),
    );
    await mocks.startProcess.mock.calls[0][2].onReady();
    expect(mocks.listMcpTools).toHaveBeenCalledWith('dep1');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/mcp');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/mcp/dep1');
    expect(mocks.redirect).toHaveBeenCalledWith(
      '/app/mine/mcp/dep1?tab=logs#runtime-logs',
    );
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });

  it('restarts deployments and opens the runtime log stream', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({ id: 'dep1', workspaceId: 'ws1' });
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'builtin' });

    await restartDeploymentAction(formData('dep1'));

    expect(mocks.restartProcess).toHaveBeenCalledWith(
      'dep1',
      { kind: 'builtin' },
      expect.objectContaining({ awaitReady: false, workspaceId: 'ws1', onReady: expect.any(Function) }),
    );
    expect(mocks.redirect).toHaveBeenCalledWith(
      '/app/mine/mcp/dep1?tab=logs#runtime-logs',
    );
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });

  it('rebuilds deployments and opens the runtime log stream', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({ id: 'dep1', workspaceId: 'ws1' });
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'builtin' });

    await rebuildDeploymentAction(formData('dep1'));

    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith(
      { id: 'dep1', workspaceId: 'ws1' },
      true,
    );
    expect(mocks.restartProcess).toHaveBeenCalledWith(
      'dep1',
      { kind: 'builtin' },
      expect.objectContaining({ awaitReady: false, workspaceId: 'ws1', onReady: expect.any(Function) }),
    );
    expect(mocks.redirect).toHaveBeenCalledWith(
      '/app/mine/mcp/dep1?tab=logs#runtime-logs',
    );
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });

  it('blocks direct starts while a catalog deployment still has empty required variables', async () => {
    mocks.liveStatus.mockReturnValue(null);
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      workspaceId: 'ws1',
      installCfg: { env: { API_TOKEN: '' } },
      server: {
        name: 'Protected MCP',
        slug: 'protected-mcp',
        installCfg: { source: 'npm', ref: 'protected-mcp', env: ['API_TOKEN'] },
      },
    });

    await startDeploymentAction(formData('dep1'));

    expect(mocks.killProcess).toHaveBeenCalledWith('dep1', { finalStatus: 'setup_required' });
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.resolveSpawnSpec).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith('/app/mine/mcp/dep1?tab=variables');
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });

  it('stops a live runtime instead of restarting it with an empty required variable', async () => {
    mocks.liveStatus.mockReturnValue('running');
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      workspaceId: 'ws1',
      installCfg: { env: { API_TOKEN: '' } },
      server: {
        name: 'Protected MCP',
        slug: 'protected-mcp',
        installCfg: { source: 'npm', ref: 'protected-mcp', env: ['API_TOKEN'] },
      },
    });

    await restartDeploymentAction(formData('dep1'));

    expect(mocks.killProcess).toHaveBeenCalledWith('dep1', { finalStatus: 'setup_required' });
    expect(mocks.restartProcess).not.toHaveBeenCalled();
    expect(mocks.resolveSpawnSpec).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith('/app/mine/mcp/dep1?tab=variables');
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });

  it('enforces stored requirements after a catalog clone is detached', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep-copy',
      workspaceId: 'ws1',
      installCfg: {
        env: { API_TOKEN: '' },
        requiredEnv: ['API_TOKEN'],
      },
      server: null,
    });

    await startDeploymentAction(formData('dep-copy'));

    expect(mocks.killProcess).toHaveBeenCalledWith('dep-copy', { finalStatus: 'setup_required' });
    expect(mocks.startProcess).not.toHaveBeenCalled();
  });
});

describe('MCP deployment management actions', () => {
  const sourceDeployment = {
    id: 'dep1',
    workspaceId: 'ws1',
    serverId: 'server1',
    server: { name: 'Catalog MCP' },
    name: null,
    source: 'npm',
    sourceRef: '@example/mcp',
    installCfg: {
      env: { API_TOKEN: 'secret-value' },
      network: 'none',
    },
    status: 'running',
    mcpToolExposure: 'allowlist',
    mcpAllowedTools: ['search'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
    mocks.deploymentConfigFileFindMany.mockResolvedValue([]);
  });

  it('renames a deployment only after a workspace-scoped lookup', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(sourceDeployment);
    const fd = formData('dep1');
    fd.set('name', '  Renamed MCP  ');

    await renameDeploymentAction(fd);

    expect(mocks.deploymentFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'dep1',
        workspaceId: 'ws1',
        OR: [{ source: null }, { source: { not: 'sandbox' } }],
      },
    }));
    expect(mocks.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'dep1' },
      data: { name: 'Renamed MCP' },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/mcp');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/mcp/dep1');
  });

  it('clones runtime configuration, environment variables, and tool exposure by default', async () => {
    const clonedDeployment = {
      ...sourceDeployment,
      id: 'dep-copy',
      serverId: null,
      server: null,
      name: 'Catalog MCP Copy',
      status: 'provisioning',
    };
    mocks.deploymentFindFirst
      .mockResolvedValueOnce(sourceDeployment)
      .mockResolvedValueOnce(clonedDeployment);
    mocks.deploymentConfigFileFindMany.mockResolvedValue([
      {
        path: 'ssh-config.json',
        pathKey: 'ssh-config.json',
        encryptedContent: { version: 1, ciphertext: 'encrypted-runtime-config' },
        size: 84,
      },
    ]);
    mocks.deploymentCreate.mockResolvedValue(clonedDeployment);
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'bridge', command: 'docker', args: [] });

    await cloneDeploymentAction(formData('dep1'));

    expect(mocks.deploymentCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws1',
        serverId: null,
        name: 'Catalog MCP Copy',
        source: 'npm',
        sourceRef: '@example/mcp',
        installCfg: {
          env: { API_TOKEN: 'secret-value' },
          network: 'none',
        },
        status: 'provisioning',
        mcpToolExposure: 'allowlist',
        mcpAllowedTools: ['search'],
        configFiles: {
          create: [
            {
              path: 'ssh-config.json',
              pathKey: 'ssh-config.json',
              encryptedContent: { version: 1, ciphertext: 'encrypted-runtime-config' },
              size: 84,
            },
          ],
        },
      },
      include: { server: { select: { name: true } } },
    });
    expect(mocks.deploymentConfigFileFindMany).toHaveBeenCalledWith({
      where: { deploymentId: 'dep1' },
      select: {
        path: true,
        pathKey: true,
        encryptedContent: true,
        size: true,
      },
    });
    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith(clonedDeployment);
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep-copy',
      { kind: 'bridge', command: 'docker', args: [] },
      expect.objectContaining({ awaitReady: false, workspaceId: 'ws1', onReady: expect.any(Function) }),
    );
    expect(mocks.redirect).toHaveBeenCalledWith('/app/mine/mcp/dep-copy');
  });

  it('can clone without environment variables when the default is explicitly disabled', async () => {
    const clonedDeployment = {
      ...sourceDeployment,
      id: 'dep-copy',
      serverId: null,
      server: null,
      name: 'No secrets',
      installCfg: { network: 'none' },
    };
    mocks.deploymentFindFirst
      .mockResolvedValueOnce(sourceDeployment)
      .mockResolvedValueOnce(clonedDeployment);
    mocks.deploymentCreate.mockResolvedValue(clonedDeployment);
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'bridge', command: 'docker', args: [] });
    const fd = formData('dep1');
    fd.set('name', 'No secrets');
    fd.set('copyEnvironmentVariables', 'false');

    await cloneDeploymentAction(fd);

    expect(mocks.deploymentCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: 'No secrets',
        installCfg: { network: 'none' },
      }),
    }));
  });

  it('keeps catalog requirements on a detached clone and does not start it without copied values', async () => {
    const catalogSource = {
      ...sourceDeployment,
      server: {
        name: 'Catalog MCP',
        slug: 'catalog-mcp',
        installCfg: { source: 'npm', ref: '@example/mcp', env: ['API_TOKEN'] },
      },
    };
    mocks.deploymentFindFirst.mockResolvedValue(catalogSource);
    mocks.deploymentCreate.mockResolvedValue({
      ...catalogSource,
      id: 'dep-copy',
      serverId: null,
      server: null,
      name: 'No catalog secrets',
      installCfg: {
        env: { API_TOKEN: '' },
        network: 'none',
        requiredEnv: ['API_TOKEN'],
      },
      status: 'setup_required',
    });
    const fd = formData('dep1');
    fd.set('name', 'No catalog secrets');
    fd.set('copyEnvironmentVariables', 'false');

    await cloneDeploymentAction(fd);

    expect(mocks.deploymentCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        serverId: null,
        status: 'setup_required',
        installCfg: {
          env: { API_TOKEN: '' },
          network: 'none',
          requiredEnv: ['API_TOKEN'],
        },
      }),
    }));
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.resolveSpawnSpec).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith('/app/mine/mcp/dep-copy?tab=variables');
  });

  it('can clone without runtime files when the default is explicitly disabled', async () => {
    const clonedDeployment = {
      ...sourceDeployment,
      id: 'dep-copy',
      serverId: null,
      server: null,
      name: 'No files',
    };
    mocks.deploymentFindFirst
      .mockResolvedValueOnce(sourceDeployment)
      .mockResolvedValueOnce(clonedDeployment);
    mocks.deploymentCreate.mockResolvedValue(clonedDeployment);
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'bridge', command: 'docker', args: [] });
    const fd = formData('dep1');
    fd.set('name', 'No files');
    fd.set('copyRuntimeFiles', 'false');

    await cloneDeploymentAction(fd);

    expect(mocks.deploymentConfigFileFindMany).not.toHaveBeenCalled();
    expect(mocks.deploymentCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ configFiles: expect.anything() }),
    }));
  });

  it('does not rename or clone a deployment outside the workspace', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(null);
    const renameFd = formData('foreign-dep');
    renameFd.set('name', 'Blocked');

    await renameDeploymentAction(renameFd);
    await cloneDeploymentAction(formData('foreign-dep'));

    expect(mocks.deploymentUpdate).not.toHaveBeenCalled();
    expect(mocks.deploymentCreate).not.toHaveBeenCalled();
    expect(mocks.startProcess).not.toHaveBeenCalled();
  });
});

describe('deployCustomServerAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'bridge', command: 'docker', args: [] });
  });

  it('persists a JSON MCP with no network even when a forged source is submitted', async () => {
    const configArgs = ['-y', 'mcp-server-fetch'];
    const deployment = {
      id: 'dep-new',
      serverId: null,
      name: 'Offline MCP',
      source: 'config',
      sourceRef: 'npx',
      installCfg: { command: 'npx', args: configArgs, env: {}, network: 'none' },
    };
    mocks.deploymentCreate.mockResolvedValue(deployment);

    await deployCustomServerAction(customMcpFormData({
      workspace: 'mine',
      source: 'npm',
      ref: '@scope/server',
      name: 'Offline MCP',
      config: JSON.stringify({
        mcpServers: {
          'Offline MCP': { command: 'npx', args: configArgs },
        },
      }),
      network: 'none',
    }));

    expect(mocks.deploymentCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws1',
        serverId: null,
        name: 'Offline MCP',
        source: 'config',
        sourceRef: 'npx',
        installCfg: { command: 'npx', args: configArgs, env: {}, network: 'none' },
        status: 'provisioning',
      },
    });
    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith(expect.objectContaining({
      source: 'config',
      installCfg: { command: 'npx', args: configArgs, env: {}, network: 'none' },
    }));
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep-new',
      { kind: 'bridge', command: 'docker', args: [] },
      expect.objectContaining({ awaitReady: false, workspaceId: 'ws1', onReady: expect.any(Function) }),
    );
  });

  it('persists a standard remote HTTP MCP as a remote deployment', async () => {
    const token = 'test-token';
    const installCfg = {
      env: { MCP_BEARER_TOKEN: token },
      requiredEnv: ['MCP_BEARER_TOKEN'],
      transport: 'streamable-http',
      authType: 'bearer',
      bearerEnv: 'MCP_BEARER_TOKEN',
    };
    const deployment = {
      id: 'dep-remote',
      serverId: null,
      name: 'Audit',
      source: 'remote',
      sourceRef: 'https://mcp.example.com/mcp',
      installCfg,
    };
    const spec = {
      kind: 'remote' as const,
      name: 'Audit',
      url: 'https://mcp.example.com/mcp',
      transport: 'streamable-http' as const,
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 60_000,
    };
    mocks.deploymentCreate.mockResolvedValue(deployment);
    mocks.resolveSpawnSpec.mockReturnValue(spec);

    await deployCustomServerAction(customMcpFormData({
      workspace: 'mine',
      config: JSON.stringify({
        mcpServers: {
          Audit: {
            type: 'http',
            url: 'https://mcp.example.com/mcp',
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }),
      network: 'none',
      runtimeFiles: '[]',
    }));

    expect(mocks.deploymentCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws1',
        serverId: null,
        name: 'Audit',
        source: 'remote',
        sourceRef: 'https://mcp.example.com/mcp',
        installCfg,
        status: 'provisioning',
      },
    });
    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith({
      serverId: null,
      server: null,
      name: 'Audit',
      source: 'remote',
      sourceRef: 'https://mcp.example.com/mcp',
      installCfg,
    });
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep-remote',
      spec,
      expect.objectContaining({ awaitReady: false, workspaceId: 'ws1', onReady: expect.any(Function) }),
    );
  });

  it('persists an mcpServers config runtime file as an encrypted nested create and starts its resolved spec', async () => {
    const runtimeFileContent = JSON.stringify([
      {
        name: 'dev',
        host: '1.2.3.4',
        username: 'alice',
        password: '{abc=P100s0}',
      },
    ], null, 2);
    const configArgs = ['-y', '@fangjunjie/ssh-mcp-server', '--config-file', 'ssh-config.json'];
    const deployment = {
      id: 'dep-ssh',
      serverId: null,
      name: 'ssh-mcp-server',
      source: 'config',
      sourceRef: 'npx',
      installCfg: { command: 'npx', args: configArgs, env: {} },
    };
    mocks.deploymentCreate.mockResolvedValue(deployment);

    await deployCustomServerAction(customMcpFormData({
      workspace: 'mine',
      source: 'config',
      config: JSON.stringify({
        mcpServers: {
          'ssh-mcp-server': {
            command: 'npx',
            args: configArgs,
          },
        },
      }),
      network: 'isolated',
      runtimeFiles: JSON.stringify([
        { path: 'ssh-config.json', content: runtimeFileContent },
      ]),
    }));

    expect(mocks.deploymentCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: 'ws1',
        name: 'ssh-mcp-server',
        source: 'config',
        sourceRef: 'npx',
        installCfg: { command: 'npx', args: configArgs, env: {} },
        status: 'provisioning',
      }),
    }));
    const createInput = mocks.deploymentCreate.mock.calls[0]?.[0] as {
      data: { configFiles?: { create: Array<Record<string, unknown>> } };
    };
    const storedFile = createInput.data.configFiles?.create[0];
    expect(storedFile).toMatchObject({
      path: 'ssh-config.json',
      pathKey: 'ssh-config.json',
      size: Buffer.byteLength(runtimeFileContent, 'utf8'),
      encryptedContent: {
        v: 1,
        alg: 'aes-256-gcm',
        iv: expect.any(String),
        tag: expect.any(String),
        data: expect.any(String),
      },
    });
    expect(JSON.stringify(storedFile?.encryptedContent)).not.toContain(runtimeFileContent);
    expect(JSON.stringify(storedFile?.encryptedContent)).not.toContain('{abc=P100s0}');
    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith({
      serverId: null,
      server: null,
      name: 'ssh-mcp-server',
      source: 'config',
      sourceRef: 'npx',
      installCfg: { command: 'npx', args: configArgs, env: {} },
    });
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep-ssh',
      { kind: 'bridge', command: 'docker', args: [] },
      expect.objectContaining({ awaitReady: false, workspaceId: 'ws1', onReady: expect.any(Function) }),
    );
  });

  it('persists JSON Docker runtime files as an encrypted nested create', async () => {
    const runtimeFileContent = '[server]\nport = 3000\n';
    const configArgs = [
      'run',
      '-i',
      '--rm',
      'ghcr.io/example/mcp:latest',
      'mcp-server',
      '--config',
      '/toolplane/config/server.toml',
    ];
    const deployment = {
      id: 'dep-docker-config',
      serverId: null,
      name: 'Docker Config MCP',
      source: 'config',
      sourceRef: 'docker',
      installCfg: { command: 'docker', args: configArgs, env: {} },
    };
    mocks.deploymentCreate.mockResolvedValue(deployment);

    await deployCustomServerAction(customMcpFormData({
      workspace: 'mine',
      source: 'docker',
      ref: 'ghcr.io/example/mcp:latest',
      name: 'Docker Config MCP',
      config: JSON.stringify({
        mcpServers: {
          'Docker Config MCP': { command: 'docker', args: configArgs },
        },
      }),
      network: 'isolated',
      runtimeFiles: JSON.stringify([
        { path: 'server.toml', content: runtimeFileContent },
      ]),
    }));

    expect(mocks.deploymentCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: 'ws1',
        name: 'Docker Config MCP',
        source: 'config',
        sourceRef: 'docker',
        installCfg: { command: 'docker', args: configArgs, env: {} },
        status: 'provisioning',
      }),
    }));
    const createInput = mocks.deploymentCreate.mock.calls[0]?.[0] as {
      data: { configFiles?: { create: Array<Record<string, unknown>> } };
    };
    const storedFile = createInput.data.configFiles?.create[0];
    expect(storedFile).toMatchObject({
      path: 'server.toml',
      pathKey: 'server.toml',
      size: Buffer.byteLength(runtimeFileContent, 'utf8'),
      encryptedContent: {
        v: 1,
        alg: 'aes-256-gcm',
        iv: expect.any(String),
        tag: expect.any(String),
        data: expect.any(String),
      },
    });
    expect(JSON.stringify(storedFile?.encryptedContent)).not.toContain(runtimeFileContent);
    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith({
      serverId: null,
      server: null,
      name: 'Docker Config MCP',
      source: 'config',
      sourceRef: 'docker',
      installCfg: { command: 'docker', args: configArgs, env: {} },
    });
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep-docker-config',
      { kind: 'bridge', command: 'docker', args: [] },
      expect.objectContaining({ awaitReady: false, workspaceId: 'ws1', onReady: expect.any(Function) }),
    );
  });

  it('rejects empty or multi-server JSON before creating a deployment', async () => {
    await deployCustomServerAction(customMcpFormData({
      workspace: 'mine',
      source: 'npm',
      ref: '@scope/server',
      name: 'Unsafe network',
      network: 'isolated',
    }));
    await deployCustomServerAction(customMcpFormData({
      workspace: 'mine',
      config: JSON.stringify({
        mcpServers: {
          one: { command: 'npx', args: ['-y', 'one-mcp'] },
          two: { command: 'uvx', args: ['two-mcp'] },
        },
      }),
      network: 'isolated',
    }));

    expect(mocks.deploymentCreate).not.toHaveBeenCalled();
    expect(mocks.startProcess).not.toHaveBeenCalled();
  });
});

describe('revealMcpJsonConfigAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
  });

  it('returns launch configuration only after a workspace-scoped lookup', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      source: 'config',
      sourceRef: 'npx',
      installCfg: {
        command: 'npx',
        args: ['ssh-mcp-server', '--password', 'secret'],
        env: { SSH_TOKEN: 'token-value' },
      },
    });

    const result = await revealMcpJsonConfigAction({
      workspace: 'mine',
      deploymentId: 'dep1',
    });

    expect(mocks.deploymentFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'dep1',
        workspaceId: 'ws1',
        source: { in: ['npm', 'pypi', 'github', 'docker', 'config'] },
      },
      select: { source: true, sourceRef: true, installCfg: true },
    });
    expect(result.config).toContain('secret');
    expect(result.config).not.toContain('token-value');
  });

  it('does not reveal a config outside the current workspace', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(null);

    await expect(revealMcpJsonConfigAction({
      workspace: 'mine',
      deploymentId: 'foreign-dep',
    })).resolves.toEqual({ error: 'deploymentNotFound' });
  });

  it('reveals package and Docker configuration through the same scoped action', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      source: 'docker',
      sourceRef: 'mcp/filesystem',
      installCfg: {
        startCommand: '--token secret /tmp',
        env: { API_TOKEN: 'secret' },
        network: 'none',
      },
    });

    const result = await revealMcpJsonConfigAction({
      workspace: 'mine',
      deploymentId: 'docker-dep',
    });

    expect(JSON.parse(result.config ?? '')).toEqual({
      source: 'docker',
      ref: 'mcp/filesystem',
      startCommand: '--token secret /tmp',
    });
  });

  it('rejects unsupported sandbox or legacy deployments even if returned', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      source: 'sandbox',
      sourceRef: null,
      installCfg: {},
    });

    await expect(revealMcpJsonConfigAction({
      workspace: 'mine',
      deploymentId: 'sandbox-dep',
    })).resolves.toEqual({ error: 'deploymentNotFound' });
  });
});

describe('inviteWorkspaceMemberAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'owner1' });
  });

  it('adds an existing user to the current workspace as a member', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 'user2', email: 'teammate@example.com' });
    mocks.membershipFindUnique.mockResolvedValue(null);

    const result = await inviteWorkspaceMemberAction({}, inviteFormData('Teammate@Example.com'));

    expect(result.error).toBeUndefined();
    expect(mocks.userFindUnique).toHaveBeenCalledWith({
      where: { email: 'teammate@example.com' },
      select: { id: true, email: true },
    });
    expect(mocks.membershipCreate).toHaveBeenCalledWith({
      data: { workspaceId: 'ws1', userId: 'user2', role: 'member' },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/members');
  });

  it('requires the current user to own the workspace', async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'owner2' });

    const result = await inviteWorkspaceMemberAction({}, inviteFormData('teammate@example.com'));

    expect(result.error).toBe('Only the workspace owner can invite members.');
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.membershipCreate).not.toHaveBeenCalled();
  });

  it('does not create a duplicate membership', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 'user2', email: 'teammate@example.com' });
    mocks.membershipFindUnique.mockResolvedValue({ id: 'membership1' });

    const result = await inviteWorkspaceMemberAction({}, inviteFormData('teammate@example.com'));

    expect(result.message).toBe('teammate@example.com is already a member.');
    expect(mocks.membershipCreate).not.toHaveBeenCalled();
  });
});

describe('updateMcpJsonConfigAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
  });

  it('updates only a JSON deployment in the current workspace and rebuilds it', async () => {
    const deployment = {
      id: 'dep1',
      workspaceId: 'ws1',
      serverId: null,
      server: null,
      name: 'Everything (editable JSON)',
      source: 'config',
      sourceRef: 'npx',
      installCfg: { command: 'npx', args: ['old-package'], env: {}, network: 'none' },
    };
    const updated = {
      ...deployment,
      name: 'Everything (editable JSON)',
      installCfg: {
        command: 'npx',
        args: ['-y', '@fangjunjie/ssh-mcp-server', '--port', '2222'],
        env: { SSH_USER: 'root' },
        network: 'none',
      },
    };
    mocks.deploymentFindFirst.mockResolvedValue(deployment);
    mocks.deploymentUpdate.mockResolvedValue(updated);
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'bridge', command: 'docker', args: [] });

    const fd = configFormData('dep1', {
      command: 'npx',
      args: ['-y', '@fangjunjie/ssh-mcp-server', '--port', '2222'],
    });
    fd.set('network', 'none');
    const result = await updateMcpJsonConfigAction({}, fd);

    expect(result.error).toBeUndefined();
    expect(result.savedAt).toEqual(expect.any(Number));
    expect(mocks.deploymentFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'dep1',
        workspaceId: 'ws1',
        source: { in: ['npm', 'pypi', 'github', 'docker', 'config'] },
      },
    });
    expect(mocks.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'dep1' },
      data: {
        source: 'config',
        sourceRef: 'npx',
        installCfg: {
          command: 'npx',
          args: ['-y', '@fangjunjie/ssh-mcp-server', '--port', '2222'],
          env: {},
          network: 'none',
        },
        status: 'provisioning',
      },
      include: { server: { select: { name: true } } },
    });
    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith(updated, true);
    expect(mocks.restartProcess).toHaveBeenCalledWith(
      'dep1',
      { kind: 'bridge', command: 'docker', args: [] },
      expect.objectContaining({ awaitReady: false, workspaceId: 'ws1', onReady: expect.any(Function) }),
    );
  });

  it.each([
    {
      source: 'npm',
      currentRef: 'old-package',
      config: { source: 'npm', ref: '@modelcontextprotocol/server-memory' },
      network: 'none',
      expectedRef: '@modelcontextprotocol/server-memory',
      expectedInstallCfg: { env: {}, network: 'none' },
    },
    {
      source: 'pypi',
      currentRef: 'old-package',
      config: { source: 'pypi', ref: 'mcp-server-fetch' },
      network: 'none',
      expectedRef: 'mcp-server-fetch',
      expectedInstallCfg: { env: {}, network: 'none' },
    },
    {
      source: 'github',
      currentRef: 'https://github.com/org/old',
      config: { source: 'github', ref: 'https://github.com/modelcontextprotocol-servers/whois-mcp' },
      network: 'none',
      expectedRef: 'https://github.com/modelcontextprotocol-servers/whois-mcp',
      expectedInstallCfg: { env: {}, network: 'none' },
    },
    {
      source: 'docker',
      currentRef: 'mcp/old',
      config: {
        source: 'docker',
        ref: 'mcp/filesystem',
        startCommand: '/tmp',
      },
      network: 'none',
      expectedRef: 'mcp/filesystem',
      expectedInstallCfg: { env: {}, startCommand: '/tmp', network: 'none' },
    },
  ])('updates and rebuilds a $source deployment', async ({
    source,
    currentRef,
    config,
    network,
    expectedRef,
    expectedInstallCfg,
  }) => {
    const deployment = {
      id: 'dep1',
      workspaceId: 'ws1',
      serverId: null,
      name: 'Editable MCP',
      source,
      sourceRef: currentRef,
      installCfg: { env: {} },
    };
    const updated = {
      ...deployment,
      sourceRef: expectedRef,
      installCfg: expectedInstallCfg,
      status: 'provisioning',
      server: null,
    };
    mocks.deploymentFindFirst.mockResolvedValue(deployment);
    mocks.deploymentUpdate.mockResolvedValue(updated);
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'bridge', command: 'docker', args: [] });

    const fd = configFormData('dep1', config);
    if (network) fd.set('network', network);
    const result = await updateMcpJsonConfigAction({}, fd);

    expect(result.savedAt).toEqual(expect.any(Number));
    expect(mocks.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'dep1' },
      data: {
        source,
        sourceRef: expectedRef,
        installCfg: expectedInstallCfg,
        status: 'provisioning',
      },
      include: { server: { select: { name: true } } },
    });
    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith(updated, true);
    expect(mocks.restartProcess).toHaveBeenCalledWith(
      'dep1',
      { kind: 'bridge', command: 'docker', args: [] },
      expect.objectContaining({ awaitReady: false, workspaceId: 'ws1', onReady: expect.any(Function) }),
    );
  });

  it('keeps a catalog deployment linked to its directory server', async () => {
    const deployment = {
      id: 'catalog-dep',
      workspaceId: 'ws1',
      serverId: 'server1',
      name: null,
      source: 'npm',
      sourceRef: '@modelcontextprotocol/server-memory',
      installCfg: { env: {} },
    };
    const updated = {
      ...deployment,
      installCfg: { env: { MEMORY_PATH: '/tmp/memory.json' }, network: 'none' },
      status: 'provisioning',
      server: { name: 'Catalog Memory' },
    };
    mocks.deploymentFindFirst.mockResolvedValue(deployment);
    mocks.deploymentUpdate.mockResolvedValue(updated);
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'bridge', command: 'docker', args: [] });

    const fd = configFormData('catalog-dep', {
      source: 'npm',
      ref: '@modelcontextprotocol/server-memory',
    });
    fd.set('network', 'none');
    const result = await updateMcpJsonConfigAction({}, fd);

    expect(result.savedAt).toEqual(expect.any(Number));
    expect(mocks.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'catalog-dep' },
      data: {
        source: 'npm',
        sourceRef: '@modelcontextprotocol/server-memory',
      installCfg: { env: {}, network: 'none' },
        status: 'provisioning',
      },
      include: { server: { select: { name: true } } },
    });
    expect(mocks.deploymentUpdate.mock.calls[0][0].data).not.toHaveProperty('serverId');
    expect(mocks.deploymentUpdate.mock.calls[0][0].data).not.toHaveProperty('name');
  });

  it('keeps an existing required variable while saving catalog JSON configuration', async () => {
    const deployment = {
      id: 'catalog-dep',
      workspaceId: 'ws1',
      serverId: 'server1',
      name: null,
      source: 'npm',
      sourceRef: 'protected-mcp',
      installCfg: { env: { API_TOKEN: 'old-secret' } },
    };
    mocks.deploymentFindFirst.mockResolvedValue(deployment);
    mocks.serverFindUnique.mockResolvedValue({
      installCfg: { source: 'npm', ref: 'protected-mcp', env: ['API_TOKEN'] },
    });
    mocks.deploymentUpdate.mockResolvedValue({
      ...deployment,
      installCfg: { env: { API_TOKEN: '' } },
      status: 'setup_required',
      server: { name: 'Protected MCP' },
    });
    mocks.liveStatus.mockReturnValue(null);

    const result = await updateMcpJsonConfigAction({}, configFormData('catalog-dep', {
      source: 'npm',
      ref: 'protected-mcp',
    }));

    expect(result.savedAt).toEqual(expect.any(Number));
    expect(mocks.deploymentUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        installCfg: expect.objectContaining({ env: { API_TOKEN: 'old-secret' } }),
        status: 'provisioning',
      }),
    }));
    expect(mocks.restartProcess).toHaveBeenCalled();
    expect(mocks.resolveSpawnSpec).toHaveBeenCalled();
  });

  it('rejects environment fields in an existing deployment configuration edit', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      workspaceId: 'ws1',
      source: 'config',
      sourceRef: 'npx',
      installCfg: { command: 'npx', args: ['mcp-server'], env: { TOKEN: 'keep' } },
    });

    const result = await updateMcpJsonConfigAction({}, configFormData('dep1', {
      command: 'npx',
      args: ['mcp-server'],
      env: { TOKEN: 'replacement' },
    }));

    expect(result).toEqual({ error: 'invalidJsonConfig' });
    expect(mocks.deploymentUpdate).not.toHaveBeenCalled();
  });

  it('rejects replacing the package behind a catalog identity', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'catalog-dep',
      workspaceId: 'ws1',
      serverId: 'server1',
      name: null,
      source: 'npm',
      sourceRef: '@modelcontextprotocol/server-memory',
      installCfg: { env: {} },
    });

    const result = await updateMcpJsonConfigAction({}, configFormData('catalog-dep', {
      source: 'npm',
      ref: 'memory-mcp',
    }));

    expect(result).toEqual({ error: 'invalidJsonConfig' });
    expect(mocks.deploymentUpdate).not.toHaveBeenCalled();
    expect(mocks.restartProcess).not.toHaveBeenCalled();
  });

  it('marks the deployment as errored and revalidates when rebuild submission fails', async () => {
    const deployment = {
      id: 'dep1',
      workspaceId: 'ws1',
      serverId: null,
      server: null,
      name: 'Editable MCP',
      source: 'config',
      sourceRef: 'npx',
      installCfg: { command: 'npx', args: ['old-package'], env: {} },
    };
    const updated = {
      ...deployment,
      installCfg: { command: 'npx', args: ['new-package'], env: {} },
      status: 'provisioning',
    };
    mocks.deploymentFindFirst.mockResolvedValue(deployment);
    mocks.deploymentUpdate
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce({ ...updated, status: 'error' });
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'bridge', command: 'docker', args: [] });
    mocks.restartProcess.mockRejectedValueOnce(new Error('spawn failed'));

    const result = await updateMcpJsonConfigAction({}, configFormData('dep1', {
      command: 'npx',
      args: ['new-package'],
    }));

    expect(result).toEqual({ error: 'rebuildFailed' });
    expect(mocks.deploymentUpdate).toHaveBeenNthCalledWith(2, {
      where: { id: 'dep1' },
      data: { status: 'error' },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/mcp');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/mcp/dep1');
  });

  it('does not update a deployment outside the workspace or with another source', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(null);

    const result = await updateMcpJsonConfigAction({}, configFormData('foreign-dep', {
      server: { command: 'npx', args: ['package'] },
    }));

    expect(result).toEqual({ error: 'deploymentNotFound' });
    expect(mocks.deploymentFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'foreign-dep',
        workspaceId: 'ws1',
        source: { in: ['npm', 'pypi', 'github', 'docker', 'config'] },
      },
    });
    expect(mocks.deploymentUpdate).not.toHaveBeenCalled();
    expect(mocks.restartProcess).not.toHaveBeenCalled();
  });

  it('rejects an invalid replacement config before updating', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      workspaceId: 'ws1',
      source: 'config',
      installCfg: {},
    });

    const result = await updateMcpJsonConfigAction(
      {},
      configFormData('dep1', { unsafe: { command: 'bash', args: ['whoami'] } }),
    );

    expect(result).toEqual({ error: 'invalidJsonConfig' });
    expect(mocks.deploymentUpdate).not.toHaveBeenCalled();
    expect(mocks.restartProcess).not.toHaveBeenCalled();
  });

  it('rejects changing the source type before updating or rebuilding', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      workspaceId: 'ws1',
      source: 'npm',
      sourceRef: 'old-package',
      installCfg: { env: {} },
    });

    const result = await updateMcpJsonConfigAction({}, configFormData('dep1', {
      source: 'docker',
      ref: 'mcp/filesystem',
    }));

    expect(result).toEqual({ error: 'invalidJsonConfig' });
    expect(mocks.deploymentUpdate).not.toHaveBeenCalled();
    expect(mocks.restartProcess).not.toHaveBeenCalled();
  });

  it('rejects an unsupported network selector before updating', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      workspaceId: 'ws1',
      serverId: null,
      source: 'npm',
      sourceRef: 'pkg',
      installCfg: { env: {} },
    });
    const fd = configFormData('dep1', { source: 'npm', ref: 'pkg' });
    fd.set('network', 'host');

    const result = await updateMcpJsonConfigAction({}, fd);

    expect(result).toEqual({ error: 'invalidJsonConfig' });
    expect(mocks.deploymentUpdate).not.toHaveBeenCalled();
    expect(mocks.restartProcess).not.toHaveBeenCalled();
  });
});

describe('setDeploymentEnvAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
  });

  it('updates environment variables without changing the selected network mode', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      installCfg: { env: { OLD: 'value' }, network: 'none' },
    });
    mocks.deploymentUpdate.mockResolvedValue({ id: 'dep1' });
    const fd = formData('dep1');
    fd.set('env', JSON.stringify([{ key: 'API_TOKEN', value: 'secret' }]));

    await setDeploymentEnvAction(fd);

    expect(mocks.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'dep1' },
      data: { installCfg: { env: { API_TOKEN: 'secret' }, network: 'none' } },
    });
  });

  it('merges a variable patch without sending existing secrets back to the browser', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      status: 'stopped',
      installCfg: { env: { API_TOKEN: 'old-secret', KEEP_ME: 'unchanged' }, network: 'none' },
    });
    const fd = formData('dep1');
    fd.set('changes', JSON.stringify({ set: { API_TOKEN: 'replacement' }, remove: [] }));

    await setDeploymentEnvAction(fd);

    expect(mocks.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'dep1' },
      data: {
        installCfg: {
          env: { API_TOKEN: 'replacement', KEEP_ME: 'unchanged' },
          network: 'none',
        },
      },
    });
  });

  it('removes an explicitly selected variable while preserving untouched values', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      status: 'stopped',
      installCfg: { env: { API_TOKEN: 'old-secret', OPTIONAL: 'keep' } },
    });
    const fd = formData('dep1');
    fd.set('changes', JSON.stringify({ set: {}, remove: ['API_TOKEN'] }));

    await setDeploymentEnvAction(fd);

    expect(mocks.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'dep1' },
      data: { installCfg: { env: { OPTIONAL: 'keep' } } },
    });
  });

  it('moves a setup-required catalog deployment to stopped after all required values are saved', async () => {
    mocks.liveStatus.mockReturnValue(null);
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      status: 'setup_required',
      installCfg: { env: { API_TOKEN: '' }, network: 'none' },
      server: {
        installCfg: { source: 'npm', ref: 'protected-mcp', env: ['API_TOKEN'] },
      },
    });
    const fd = formData('dep1');
    fd.set('env', JSON.stringify([{ key: 'API_TOKEN', value: 'secret' }]));

    await setDeploymentEnvAction(fd);

    expect(mocks.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'dep1' },
      data: {
        installCfg: { env: { API_TOKEN: 'secret' }, network: 'none' },
        status: 'stopped',
      },
    });
  });

  it('kills a running deployment and persists setup_required when a required value is cleared', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      status: 'running',
      installCfg: { env: { API_TOKEN: 'old-secret' }, network: 'none' },
      server: {
        installCfg: { source: 'npm', ref: 'protected-mcp', env: ['API_TOKEN'] },
      },
    });
    const fd = formData('dep1');
    fd.set('env', JSON.stringify([{ key: 'API_TOKEN', value: '' }]));

    await setDeploymentEnvAction(fd);

    expect(mocks.killProcess).toHaveBeenCalledWith('dep1', { finalStatus: 'setup_required' });
    expect(mocks.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'dep1' },
      data: {
        installCfg: { env: { API_TOKEN: '' }, network: 'none' },
        status: 'setup_required',
      },
    });
    expect(mocks.killProcess.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deploymentUpdate.mock.invocationCallOrder[0],
    );
  });

  it('serializes credential clearing with start so an old spawn spec cannot win the race', async () => {
    let current = {
      id: 'dep1',
      workspaceId: 'ws1',
      status: 'running',
      source: 'npm',
      sourceRef: 'protected-mcp',
      installCfg: { env: { API_TOKEN: 'old-secret' } },
      server: {
        name: 'Protected MCP',
        slug: 'protected-mcp',
        installCfg: { source: 'npm', ref: 'protected-mcp', env: ['API_TOKEN'] },
      },
    };
    mocks.deploymentFindFirst.mockImplementation(async () => current);
    mocks.deploymentUpdate.mockImplementation(async ({ data }) => {
      current = { ...current, ...data };
      return current;
    });
    let finishKill!: () => void;
    mocks.killProcess.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishKill = resolve;
    }));

    const clear = formData('dep1');
    clear.set('env', JSON.stringify([{ key: 'API_TOKEN', value: '' }]));
    const clearing = setDeploymentEnvAction(clear);
    await vi.waitFor(() => expect(mocks.killProcess).toHaveBeenCalledOnce());

    const starting = startDeploymentAction(formData('dep1'));
    await Promise.resolve();
    expect(mocks.deploymentFindFirst).toHaveBeenCalledOnce();
    expect(mocks.startProcess).not.toHaveBeenCalled();

    finishKill();
    await Promise.all([clearing, starting]);

    expect(mocks.deploymentFindFirst).toHaveBeenCalledTimes(2);
    expect(mocks.killProcess).toHaveBeenCalledTimes(2);
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(current.status).toBe('setup_required');
    expect(current.installCfg.env.API_TOKEN).toBe('');
  });
});

describe('updateMcpToolExposureAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
    mocks.liveStatus.mockReturnValue('running');
    mocks.listMcpTools.mockResolvedValue([{ name: 'read' }, { name: 'write' }]);
  });

  it('stores an exact allowlist while preserving a selected unavailable tool', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      source: 'npm',
      mcpAllowedTools: ['temporarily-missing'],
    });
    const fd = formData('dep1');
    fd.set('mode', 'allowlist');
    fd.append('toolName', 'read');
    fd.append('toolName', 'temporarily-missing');

    const result = await updateMcpToolExposureAction({}, fd);

    expect(result.savedAt).toEqual(expect.any(Number));
    expect(mocks.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'dep1' },
      data: {
        mcpToolExposure: 'allowlist',
        mcpAllowedTools: ['read', 'temporarily-missing'],
        publicInvocable: false,
      },
    });
    expect(mocks.restartProcess).not.toHaveBeenCalled();
  });

  it('keeps an explicit empty allowlist and resets cleanly to all mode', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      source: 'npm',
      mcpAllowedTools: ['read'],
    });
    const empty = formData('dep1');
    empty.set('mode', 'allowlist');
    await updateMcpToolExposureAction({}, empty);
    expect(mocks.deploymentUpdate).toHaveBeenLastCalledWith({
      where: { id: 'dep1' },
      data: { mcpToolExposure: 'allowlist', mcpAllowedTools: [], publicInvocable: false },
    });

    const all = formData('dep1');
    all.set('mode', 'all');
    await updateMcpToolExposureAction({}, all);
    expect(mocks.deploymentUpdate).toHaveBeenLastCalledWith({
      where: { id: 'dep1' },
      data: { mcpToolExposure: 'all', mcpAllowedTools: [], publicInvocable: false },
    });
  });

  it('accepts bounded names that disappeared after page load and rejects malformed names', async () => {
    mocks.deploymentFindFirst.mockResolvedValueOnce({
      id: 'dep1',
      source: 'npm',
      mcpAllowedTools: [],
    });
    const disappeared = formData('dep1');
    disappeared.set('mode', 'allowlist');
    disappeared.append('toolName', 'not-reported-anymore');
    await expect(updateMcpToolExposureAction({}, disappeared)).resolves.toMatchObject({
      savedAt: expect.any(Number),
    });
    expect(mocks.deploymentUpdate).toHaveBeenLastCalledWith({
      where: { id: 'dep1' },
      data: {
        mcpToolExposure: 'allowlist',
        mcpAllowedTools: ['not-reported-anymore'],
        publicInvocable: false,
      },
    });

    mocks.deploymentUpdate.mockClear();
    mocks.deploymentFindFirst.mockResolvedValue({
      id: 'dep1',
      source: 'npm',
      mcpAllowedTools: [],
    });
    const malformed = formData('dep1');
    malformed.set('mode', 'allowlist');
    malformed.append('toolName', 'bad\0name');
    await expect(updateMcpToolExposureAction({}, malformed)).resolves.toEqual({
      error: 'invalidToolSelection',
    });
  });

  it('does not update a deployment outside the workspace', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(null);

    const foreign = formData('foreign');
    foreign.set('mode', 'all');
    await expect(updateMcpToolExposureAction({}, foreign)).resolves.toEqual({
      error: 'deploymentNotFound',
    });
    expect(mocks.deploymentFindFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'foreign', workspaceId: 'ws1' },
    }));
  });
});

describe('runMcpConsoleToolAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
    mocks.liveStatus.mockReturnValue('running');
    mocks.listMcpTools.mockResolvedValue([{ name: 'read' }, { name: 'write' }]);
    mocks.mcpRpc.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    mocks.logRequest.mockResolvedValue(undefined);
  });

  it('allows workspace members to manually test a tool and records the call', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({ id: 'dep1' });

    const result = await runMcpConsoleToolAction({
      workspace: 'mine',
      deploymentId: 'dep1',
      toolName: 'write',
      arguments: { value: 'x' },
    });

    expect(result).toEqual({ result: { content: [{ type: 'text', text: 'ok' }] } });
    expect(mocks.mcpRpc).toHaveBeenCalledWith('dep1', 'tools/call', {
      name: 'write',
      arguments: { value: 'x' },
    }, 30_000, { maxRequestBytes: 16_000, maxResponseBytes: 1_000_000 });
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws1',
      deploymentId: 'dep1',
      path: '/mcp/dep1/rpc#tools/call:write',
    }));
  });

  it('rejects unauthorized, stopped, and unknown tool calls before MCP execution', async () => {
    mocks.getWorkspaceForUser.mockResolvedValueOnce(null);
    await expect(runMcpConsoleToolAction({
      workspace: 'mine', deploymentId: 'dep1', toolName: 'read', arguments: {},
    })).resolves.toEqual({ error: 'notAuthorized' });

    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
    mocks.deploymentFindFirst.mockResolvedValue({ id: 'dep1' });
    mocks.liveStatus.mockReturnValueOnce('stopped');
    await expect(runMcpConsoleToolAction({
      workspace: 'mine', deploymentId: 'dep1', toolName: 'read', arguments: {},
    })).resolves.toEqual({ error: 'deploymentNotRunning' });

    mocks.liveStatus.mockReturnValue('running');
    mocks.listMcpTools.mockResolvedValueOnce([{ name: 'other' }]);
    await expect(runMcpConsoleToolAction({
      workspace: 'mine', deploymentId: 'dep1', toolName: 'read', arguments: {},
    })).resolves.toEqual({ error: 'invalidToolCall' });

    expect(mocks.mcpRpc).not.toHaveBeenCalled();
  });
});
