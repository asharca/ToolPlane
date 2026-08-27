// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sandboxFindFirst: vi.fn(),
  attachmentFindMany: vi.fn(),
  copy: vi.fn(),
  attachmentUpdateMany: vi.fn(),
  releaseLease: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    sandbox: { findFirst: mocks.sandboxFindFirst },
    workspaceAttachment: { findMany: mocks.attachmentFindMany },
  },
}));

vi.mock('@/lib/attachments/storage', () => ({
  safeAttachmentFilename: (name: string) => name.replace(/[^A-Za-z0-9._-]/g, '-'),
  copyWorkspaceAttachmentToDockerVolume: mocks.copy,
}));

vi.mock('@/lib/sandboxes/runtime', () => ({
  sandboxVolumeName: (id: string) => `volume-${id}`,
}));

vi.mock('@/lib/agents/hermes/runtime', () => ({
  acquireHermesRuntimeWriteLease: vi.fn(() => ({ release: mocks.releaseLease })),
  HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR: 'Hermes maintenance in progress.',
}));

import {
  claimWorkAttachments,
  prepareWorkAttachments,
  WorkAttachmentError,
} from '@/lib/attachments/work';

describe('Work attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sandboxFindFirst.mockResolvedValue({
      id: 'sandbox-1',
      kind: 'docker',
      agentRuntime: null,
      deployment: { installCfg: null },
    });
    mocks.attachmentFindMany.mockResolvedValue([{
      id: 'attachment-1',
      name: 'notes.txt',
      mimeType: 'text/plain',
      storagePath: 'objects/source-notes.txt',
    }]);
  });

  it('copies into the Hermes workspace inside its dedicated volume', async () => {
    mocks.sandboxFindFirst.mockResolvedValue({
      id: 'sandbox-hermes',
      kind: 'hermes',
      agentRuntime: { agentId: 'agent-hermes' },
      deployment: { installCfg: { volumeName: 'hermes-volume' } },
    });

    await expect(prepareWorkAttachments({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      sandboxId: 'sandbox-hermes',
      workingDirectory: 'projects/app',
      attachmentIds: ['attachment-1'],
    })).resolves.toEqual([expect.objectContaining({
      runtimePath: '/opt/data/workspace/projects/app/.toolplane/attachments/attachment-1/notes.txt',
    })]);
    expect(mocks.copy).toHaveBeenCalledWith(expect.objectContaining({
      destinationVolume: 'hermes-volume',
      destinationPath: 'workspace/projects/app/.toolplane/attachments/attachment-1/notes.txt',
    }));
    expect(mocks.releaseLease).toHaveBeenCalledOnce();
  });

  it('copies a caller-owned draft into the selected sandbox directory', async () => {
    await expect(prepareWorkAttachments({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      sandboxId: 'sandbox-1',
      workingDirectory: 'projects/app',
      attachmentIds: ['attachment-1'],
    })).resolves.toEqual([{
      id: 'attachment-1',
      name: 'notes.txt',
      mimeType: 'text/plain',
      runtimePath: '/workspace/projects/app/.toolplane/attachments/attachment-1/notes.txt',
    }]);
    expect(mocks.copy).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      destinationVolume: 'volume-sandbox-1',
      destinationPath: 'projects/app/.toolplane/attachments/attachment-1/notes.txt',
    }));
  });

  it('does not claim an attachment already owned by another conversation', async () => {
    mocks.attachmentUpdateMany.mockResolvedValue({ count: 0 });
    await expect(claimWorkAttachments({
      workspaceAttachment: { updateMany: mocks.attachmentUpdateMany },
    } as never, {
      workspaceId: 'workspace-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      attachments: [{
        id: 'attachment-1',
        name: 'notes.txt',
        mimeType: 'text/plain',
        runtimePath: '/workspace/notes.txt',
      }],
    })).rejects.toBeInstanceOf(WorkAttachmentError);
  });

  it('rejects connector sandboxes instead of exposing a host path', async () => {
    mocks.sandboxFindFirst.mockResolvedValue({
      id: 'sandbox-1',
      kind: 'connector',
      agentRuntime: null,
      deployment: { installCfg: null },
    });
    await expect(prepareWorkAttachments({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      sandboxId: 'sandbox-1',
      workingDirectory: '.',
      attachmentIds: ['attachment-1'],
    })).rejects.toMatchObject({ status: 400 });
    expect(mocks.copy).not.toHaveBeenCalled();
  });
});
