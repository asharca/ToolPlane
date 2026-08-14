// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  startProcess: vi.fn(),
  stopProcess: vi.fn(),
  restartProcess: vi.fn(),
  killProcess: vi.fn(),
  liveStatus: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/process/supervisor', () => ({
  startProcess: mocks.startProcess,
  stopProcess: mocks.stopProcess,
  restartProcess: mocks.restartProcess,
  killProcess: mocks.killProcess,
  liveStatus: mocks.liveStatus,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { cloneDeploymentAction, deployServerAction } from '@/lib/workspace/actions';

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const email = `workspace-deployment-setup-${stamp}@test.dev`;
const workspaceSlug = `workspace-deployment-setup-${stamp}`;
const requiredServerSlug = `required-mcp-${stamp}`;
const automaticServerSlug = `automatic-mcp-${stamp}`;
let userId = '';
let workspaceId = '';
let requiredServerId = '';
let automaticServerId = '';

function deploymentForm(serverId: string): FormData {
  const form = new FormData();
  form.set('workspace', workspaceSlug);
  form.set('serverId', serverId);
  return form;
}

function cloneForm(deploymentId: string): FormData {
  const form = new FormData();
  form.set('workspace', workspaceSlug);
  form.set('deploymentId', deploymentId);
  form.set('name', 'Detached required MCP');
  form.set('copyEnvironmentVariables', 'false');
  return form;
}

describe('catalog MCP deployment setup', () => {
  beforeAll(async () => {
    const user = await db.user.create({ data: { email, passwordHash: 'x' } });
    userId = user.id;
    const workspace = await db.workspace.create({
      data: {
        slug: workspaceSlug,
        name: 'Deployment setup integration',
        ownerId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
      },
    });
    workspaceId = workspace.id;
    const [requiredServer, automaticServer] = await Promise.all([
      db.server.create({
        data: {
          slug: requiredServerSlug,
          name: 'Required MCP',
          verifiedAt: new Date(),
          installCfg: {
            source: 'npm',
            ref: 'required-mcp',
            env: ['API_TOKEN'],
          },
        },
      }),
      db.server.create({
        data: {
          slug: automaticServerSlug,
          name: 'Automatic MCP',
          verifiedAt: new Date(),
          installCfg: {
            source: 'npm',
            ref: '@modelcontextprotocol/server-memory',
            env: [],
          },
        },
      }),
    ]);
    requiredServerId = requiredServer.id;
    automaticServerId = automaticServer.id;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: userId, email });
    mocks.liveStatus.mockReturnValue(null);
    mocks.startProcess.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.server.deleteMany({ where: { id: { in: [requiredServerId, automaticServerId] } } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it('persists setup_required and does not spawn when a required value is empty', async () => {
    await deployServerAction(deploymentForm(requiredServerId));

    const deployment = await db.deployment.findUniqueOrThrow({
      where: {
        workspaceId_serverId: { workspaceId, serverId: requiredServerId },
      },
    });
    expect(deployment.status).toBe('setup_required');
    expect(deployment.installCfg).toMatchObject({ env: { API_TOKEN: '' } });
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith(
      `/app/${workspaceSlug}/mcp/${deployment.id}?tab=variables`,
    );
  });

  it('keeps one-click startup for a recipe with no missing requirements', async () => {
    await deployServerAction(deploymentForm(automaticServerId));

    const deployment = await db.deployment.findUniqueOrThrow({
      where: {
        workspaceId_serverId: { workspaceId, serverId: automaticServerId },
      },
    });
    expect(deployment.status).toBe('provisioning');
    expect(mocks.startProcess).toHaveBeenCalledWith(
      deployment.id,
      expect.any(Object),
      { awaitReady: false, workspaceId },
    );
    expect(mocks.redirect).toHaveBeenCalledWith(
      `/app/${workspaceSlug}/mcp/${deployment.id}`,
    );
  });

  it('keeps required-env constraints when a catalog deployment is cloned without values', async () => {
    await deployServerAction(deploymentForm(requiredServerId));
    const source = await db.deployment.findUniqueOrThrow({
      where: {
        workspaceId_serverId: { workspaceId, serverId: requiredServerId },
      },
    });
    mocks.startProcess.mockClear();
    mocks.redirect.mockClear();

    await cloneDeploymentAction(cloneForm(source.id));

    const clone = await db.deployment.findFirstOrThrow({
      where: { workspaceId, serverId: null, name: 'Detached required MCP' },
    });
    expect(clone.status).toBe('setup_required');
    expect(clone.installCfg).toMatchObject({
      env: { API_TOKEN: '' },
      requiredEnv: ['API_TOKEN'],
    });
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith(
      `/app/${workspaceSlug}/mcp/${clone.id}?tab=variables`,
    );
  });
});
