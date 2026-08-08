import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptSecretText } from '@/lib/security/secrets';
import {
  MAX_RUNTIME_TEXT_FILE_BYTES,
  MAX_RUNTIME_TEXT_FILES,
  MAX_RUNTIME_TEXT_FILES_BYTES,
} from '@/lib/workspace/runtime-files';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  deploymentFindFirst: vi.fn(),
  deploymentConfigFileDeleteMany: vi.fn(),
  transaction: vi.fn(),
  transactionConfigFileFindMany: vi.fn(),
  transactionConfigFileUpsert: vi.fn(),
  restartProcess: vi.fn(),
  resolveSpawnSpec: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    deployment: { findFirst: mocks.deploymentFindFirst },
    deploymentConfigFile: { deleteMany: mocks.deploymentConfigFileDeleteMany },
  },
}));
vi.mock('@/lib/process/supervisor', () => ({ restartProcess: mocks.restartProcess }));
vi.mock('@/lib/process/spawn-spec', () => ({ resolveSpawnSpec: mocks.resolveSpawnSpec }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import {
  deleteDeploymentRuntimeFileAction,
  upsertDeploymentRuntimeFileAction,
} from '@/lib/workspace/runtime-files-actions';

const deployment = {
  id: 'dep-1',
  workspaceId: 'workspace-1',
  source: 'config',
  installCfg: { command: 'npx', args: ['-y', 'example-mcp'] },
  server: { name: 'Example MCP' },
};

function upsertForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set('workspace', 'acme');
  form.set('deploymentId', 'dep-1');
  form.set('path', 'ssh-config.json');
  form.set('content', 'host = bastion\n');
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  return form;
}

function deleteForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set('workspace', 'acme');
  form.set('deploymentId', 'dep-1');
  form.set('fileId', 'file-1');
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  return form;
}

describe('runtime file workspace actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.deploymentFindFirst.mockResolvedValue(deployment);
    mocks.transactionConfigFileFindMany.mockResolvedValue([]);
    mocks.transactionConfigFileUpsert.mockImplementation(async ({ create }) => ({
      id: 'file-1',
      path: create.path,
      size: create.size,
      updatedAt: new Date('2026-08-07T00:00:00.000Z'),
    }));
    mocks.transaction.mockImplementation(async (callback) => callback({
      deploymentConfigFile: {
        findMany: mocks.transactionConfigFileFindMany,
        upsert: mocks.transactionConfigFileUpsert,
      },
    }));
    mocks.deploymentConfigFileDeleteMany.mockResolvedValue({ count: 1 });
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'bridge', command: 'docker', args: [] });
    mocks.restartProcess.mockResolvedValue(undefined);
  });

  it('rejects an unauthenticated write before looking up a workspace or deployment', async () => {
    mocks.getCurrentUser.mockResolvedValue(null);

    await expect(upsertDeploymentRuntimeFileAction({}, upsertForm())).resolves.toEqual({
      error: 'notAuthorized',
    });

    expect(mocks.getWorkspaceForUser).not.toHaveBeenCalled();
    expect(mocks.deploymentFindFirst).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('looks up an editable deployment only within the authorized workspace', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(null);

    await expect(upsertDeploymentRuntimeFileAction({}, upsertForm())).resolves.toEqual({
      error: 'deploymentNotFound',
    });

    expect(mocks.getWorkspaceForUser).toHaveBeenCalledWith('acme', 'user-1');
    expect(mocks.deploymentFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'dep-1',
        workspaceId: 'workspace-1',
        source: { in: ['npm', 'pypi', 'github', 'docker', 'config'] },
      },
      include: { server: { select: { name: true } } },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('encrypts text before the transactional upsert and returns metadata only', async () => {
    const content = 'SUPER_SECRET$%__123\n';
    const result = await upsertDeploymentRuntimeFileAction({}, upsertForm({ content }));

    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
      maxWait: 10_000,
      timeout: 30_000,
    });
    expect(mocks.transactionConfigFileFindMany).toHaveBeenCalledWith({
      where: { deploymentId: 'dep-1' },
      select: { pathKey: true, size: true },
    });

    const write = mocks.transactionConfigFileUpsert.mock.calls[0]?.[0];
    expect(write).toMatchObject({
      where: {
        deploymentId_pathKey: {
          deploymentId: 'dep-1',
          pathKey: 'ssh-config.json',
        },
      },
      update: {
        path: 'ssh-config.json',
        size: Buffer.byteLength(content, 'utf8'),
      },
      create: {
        deploymentId: 'dep-1',
        path: 'ssh-config.json',
        pathKey: 'ssh-config.json',
        size: Buffer.byteLength(content, 'utf8'),
      },
      select: { id: true, path: true, size: true, updatedAt: true },
    });
    expect(write.update).not.toHaveProperty('content');
    expect(write.create).not.toHaveProperty('content');
    expect(JSON.stringify(write)).not.toContain(content);
    expect(decryptSecretText(write.update.encryptedContent)).toBe(content);
    expect(decryptSecretText(write.create.encryptedContent)).toBe(content);

    expect(result).toEqual({
      savedAt: expect.any(Number),
      file: {
        id: 'file-1',
        path: 'ssh-config.json',
        size: Buffer.byteLength(content, 'utf8'),
        updatedAt: '2026-08-07T00:00:00.000Z',
      },
    });
    expect(result.file).not.toHaveProperty('content');
    expect(mocks.restartProcess).toHaveBeenCalledWith(
      'dep-1',
      { kind: 'bridge', command: 'docker', args: [] },
      { awaitReady: false, workspaceId: 'workspace-1' },
    );
  });

  it('enforces the aggregate file-count limit inside the serializable transaction', async () => {
    mocks.transactionConfigFileFindMany.mockResolvedValue(
      Array.from({ length: MAX_RUNTIME_TEXT_FILES }, (_, index) => ({
        pathKey: `existing-${index}.txt`,
        size: 1,
      })),
    );

    await expect(upsertDeploymentRuntimeFileAction({}, upsertForm())).resolves.toEqual({
      error: 'invalidFile',
    });

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.transactionConfigFileUpsert).not.toHaveBeenCalled();
    expect(mocks.restartProcess).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('enforces the aggregate byte limit inside the serializable transaction', async () => {
    mocks.transactionConfigFileFindMany.mockResolvedValue(
      Array.from({ length: 4 }, (_, index) => ({
        pathKey: `existing-${index}.txt`,
        size: MAX_RUNTIME_TEXT_FILE_BYTES,
      })),
    );
    expect(4 * MAX_RUNTIME_TEXT_FILE_BYTES).toBe(MAX_RUNTIME_TEXT_FILES_BYTES);

    await expect(upsertDeploymentRuntimeFileAction({}, upsertForm({ content: 'x' }))).resolves.toEqual({
      error: 'invalidFile',
    });

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.transactionConfigFileUpsert).not.toHaveBeenCalled();
    expect(mocks.restartProcess).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('returns restartFailed and revalidates persisted file metadata after a restart failure', async () => {
    mocks.restartProcess.mockRejectedValue(new Error('Docker is unavailable'));

    await expect(upsertDeploymentRuntimeFileAction({}, upsertForm())).resolves.toEqual({
      error: 'restartFailed',
    });

    expect(mocks.transactionConfigFileUpsert).toHaveBeenCalledOnce();
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/mcp');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/mcp/dep-1');
  });

  it('returns saveFailed when a scoped runtime-file deletion cannot be persisted', async () => {
    mocks.deploymentConfigFileDeleteMany.mockRejectedValue(new Error('database unavailable'));

    await expect(deleteDeploymentRuntimeFileAction(deleteForm())).resolves.toEqual({
      error: 'saveFailed',
    });

    expect(mocks.deploymentConfigFileDeleteMany).toHaveBeenCalledWith({
      where: { id: 'file-1', deploymentId: 'dep-1' },
    });
    expect(mocks.restartProcess).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
