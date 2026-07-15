import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  deploymentFindFirst: vi.fn(),
  deploymentCreate: vi.fn(),
  deploymentDeleteMany: vi.fn(),
  deploymentUpdate: vi.fn(),
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
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/db', () => ({
  db: {
    deployment: {
      findFirst: mocks.deploymentFindFirst,
      create: mocks.deploymentCreate,
      deleteMany: mocks.deploymentDeleteMany,
      update: mocks.deploymentUpdate,
    },
    user: {
      findUnique: mocks.userFindUnique,
    },
    membership: {
      findUnique: mocks.membershipFindUnique,
      create: mocks.membershipCreate,
    },
  },
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
vi.mock('@/lib/workspace/teardown', () => ({ killWorkspaceProcesses: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import {
  deployCustomServerAction,
  inviteWorkspaceMemberAction,
  removeDeploymentAction,
  revealMcpJsonConfigAction,
  runMcpConsoleToolAction,
  setDeploymentEnvAction,
  startDeploymentAction,
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

describe('removeDeploymentAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
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

  it('kills only after the deployment is confirmed in the workspace', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({ id: 'dep1' });

    await removeDeploymentAction(formData('dep1'));

    expect(mocks.killProcess).toHaveBeenCalledWith('dep1', { preventRestart: true });
    expect(mocks.deploymentDeleteMany).toHaveBeenCalledWith({
      where: { id: 'dep1', workspaceId: 'ws1' },
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
  });

  it('starts deployments in provisioning mode without waiting for ready', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({ id: 'dep1', workspaceId: 'ws1' });
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'builtin' });

    await startDeploymentAction(formData('dep1'));

    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith({ id: 'dep1', workspaceId: 'ws1' });
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep1',
      { kind: 'builtin' },
      { awaitReady: false, workspaceId: 'ws1' },
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/mcp');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/mcp/dep1');
  });
});

describe('deployCustomServerAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'bridge', command: 'docker', args: [] });
  });

  it('persists the selected no-network mode and starts with that configuration', async () => {
    const deployment = {
      id: 'dep-new',
      serverId: null,
      name: 'Offline MCP',
      source: 'npm',
      sourceRef: '@scope/server',
      installCfg: { env: {}, network: 'none' },
    };
    mocks.deploymentCreate.mockResolvedValue(deployment);

    await deployCustomServerAction(customMcpFormData({
      workspace: 'mine',
      source: 'npm',
      ref: '@scope/server',
      name: 'Offline MCP',
      network: 'none',
    }));

    expect(mocks.deploymentCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws1',
        serverId: null,
        name: 'Offline MCP',
        source: 'npm',
        sourceRef: '@scope/server',
        installCfg: { env: {}, network: 'none' },
        status: 'provisioning',
      },
    });
    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith(expect.objectContaining({
      installCfg: { env: {}, network: 'none' },
    }));
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep-new',
      { kind: 'bridge', command: 'docker', args: [] },
      { awaitReady: false, workspaceId: 'ws1' },
    );
  });

  it('rejects an unsupported network before creating a deployment', async () => {
    await deployCustomServerAction(customMcpFormData({
      workspace: 'mine',
      source: 'npm',
      ref: '@scope/server',
      name: 'Unsafe network',
      network: 'host',
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

  it('returns the full config only after a workspace-scoped lookup', async () => {
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
    expect(result.config).toContain('token-value');
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
      env: { API_TOKEN: 'secret' },
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
      env: { SSH_USER: 'root' },
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
          env: { SSH_USER: 'root' },
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
      { awaitReady: false, workspaceId: 'ws1' },
    );
  });

  it.each([
    {
      source: 'npm',
      currentRef: 'old-package',
      config: { source: 'npm', ref: '@modelcontextprotocol/server-memory', env: { TOKEN: 'value' } },
      network: 'none',
      expectedRef: '@modelcontextprotocol/server-memory',
      expectedInstallCfg: { env: { TOKEN: 'value' }, network: 'none' },
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
      { awaitReady: false, workspaceId: 'ws1' },
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
      env: { MEMORY_PATH: '/tmp/memory.json' },
    });
    fd.set('network', 'none');
    const result = await updateMcpJsonConfigAction({}, fd);

    expect(result.savedAt).toEqual(expect.any(Number));
    expect(mocks.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'catalog-dep' },
      data: {
        source: 'npm',
        sourceRef: '@modelcontextprotocol/server-memory',
        installCfg: { env: { MEMORY_PATH: '/tmp/memory.json' }, network: 'none' },
        status: 'provisioning',
      },
      include: { server: { select: { name: true } } },
    });
    expect(mocks.deploymentUpdate.mock.calls[0][0].data).not.toHaveProperty('serverId');
    expect(mocks.deploymentUpdate.mock.calls[0][0].data).not.toHaveProperty('name');
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
      data: { mcpToolExposure: 'allowlist', mcpAllowedTools: [] },
    });

    const all = formData('dep1');
    all.set('mode', 'all');
    await updateMcpToolExposureAction({}, all);
    expect(mocks.deploymentUpdate).toHaveBeenLastCalledWith({
      where: { id: 'dep1' },
      data: { mcpToolExposure: 'all', mcpAllowedTools: [] },
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
    });
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
