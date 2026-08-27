// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  workspaceFindFirst: vi.fn(),
  attachmentCreate: vi.fn(),
  attachmentFindFirst: vi.fn(),
  attachmentDeleteMany: vi.fn(),
  systemSettingFindUnique: vi.fn(),
  writeWorkspaceAttachment: vi.fn(),
  readWorkspaceAttachment: vi.fn(),
  deleteWorkspaceAttachmentFile: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({ resolveRequestUser: mocks.resolveRequestUser }));
vi.mock('@/lib/db', () => ({
  db: {
    workspace: { findFirst: mocks.workspaceFindFirst },
    workspaceAttachment: {
      create: mocks.attachmentCreate,
      findFirst: mocks.attachmentFindFirst,
      deleteMany: mocks.attachmentDeleteMany,
    },
    systemSetting: { findUnique: mocks.systemSettingFindUnique },
  },
}));
vi.mock('@/lib/attachments/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/attachments/storage')>();
  return {
    ...actual,
    writeWorkspaceAttachment: mocks.writeWorkspaceAttachment,
    readWorkspaceAttachment: mocks.readWorkspaceAttachment,
    deleteWorkspaceAttachmentFile: mocks.deleteWorkspaceAttachmentFile,
  };
});

import { POST } from '@/app/api/v1/workspaces/[slug]/attachments/route';
import {
  DELETE,
  GET,
} from '@/app/api/v1/attachments/[attachmentId]/route';

const uploadContext = { params: Promise.resolve({ slug: 'workspace-1' }) };
const attachmentContext = { params: Promise.resolve({ attachmentId: 'attachment-1' }) };

function uploadRequest(body: BodyInit = Buffer.from('hello')) {
  return new Request('http://toolplane.test/api/v1/workspaces/workspace-1/attachments?filename=notes.txt', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body,
  });
}

function attachmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'attachment-1',
    workspaceId: 'workspace-1',
    uploadedById: 'user-1',
    chatThreadId: null,
    conversationId: null,
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: 5,
    storagePath: 'objects/123e4567-e89b-12d3-a456-426614174000-notes.txt',
    ...overrides,
  };
}

describe('workspace attachment routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: 'user-1' });
    mocks.workspaceFindFirst.mockResolvedValue({ id: 'workspace-1' });
    mocks.systemSettingFindUnique.mockResolvedValue(null);
    mocks.writeWorkspaceAttachment.mockResolvedValue({
      storagePath: 'objects/123e4567-e89b-12d3-a456-426614174000-notes.txt',
      size: 5,
    });
    mocks.attachmentCreate.mockResolvedValue(attachmentRow());
    mocks.attachmentFindFirst.mockResolvedValue(attachmentRow());
    mocks.attachmentDeleteMany.mockResolvedValue({ count: 1 });
    mocks.deleteWorkspaceAttachmentFile.mockResolvedValue(undefined);
    mocks.readWorkspaceAttachment.mockReturnValue(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'));
        controller.close();
      },
    }));
  });

  it('stores a raw body only after workspace authorization', async () => {
    const response = await POST(uploadRequest(), uploadContext);

    expect(response.status).toBe(201);
    expect(mocks.workspaceFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'workspace-1',
        OR: [{ ownerId: 'user-1' }, { members: { some: { userId: 'user-1' } } }],
      },
      select: { id: true },
    });
    expect(mocks.writeWorkspaceAttachment).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      filename: 'notes.txt',
      maxBytes: 1_000_000_000,
      body: expect.any(ReadableStream),
    }));
    expect(mocks.attachmentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'workspace-1',
        uploadedById: 'user-1',
        mimeType: 'text/plain',
        size: 5,
      }),
    });
  });

  it('rejects a declared oversize upload before touching Docker storage', async () => {
    mocks.systemSettingFindUnique.mockResolvedValue({ value: '4' });
    const request = uploadRequest();
    request.headers.set('content-length', '5');

    const response = await POST(request, uploadContext);

    expect(response.status).toBe(413);
    expect(mocks.writeWorkspaceAttachment).not.toHaveBeenCalled();
  });

  it('keeps unclaimed drafts private to their uploader', async () => {
    mocks.attachmentFindFirst.mockResolvedValue(attachmentRow({ uploadedById: 'user-2' }));

    const response = await GET(new Request('http://toolplane.test/api/v1/attachments/attachment-1'), attachmentContext);

    expect(response.status).toBe(404);
    expect(mocks.readWorkspaceAttachment).not.toHaveBeenCalled();
  });

  it('streams a claimed attachment with download hardening headers', async () => {
    mocks.attachmentFindFirst.mockResolvedValue(attachmentRow({ chatThreadId: 'thread-1' }));

    const response = await GET(new Request('http://toolplane.test/api/v1/attachments/attachment-1'), attachmentContext);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''notes.txt");
    await expect(response.text()).resolves.toBe('hello');
  });

  it('deletes only an unclaimed draft owned by the caller', async () => {
    const response = await DELETE(new Request('http://toolplane.test/api/v1/attachments/attachment-1', {
      method: 'DELETE',
    }), attachmentContext);

    expect(response.status).toBe(204);
    expect(mocks.attachmentDeleteMany).toHaveBeenCalledWith({
      where: {
        id: 'attachment-1',
        workspaceId: 'workspace-1',
        uploadedById: 'user-1',
        chatThreadId: null,
        conversationId: null,
      },
    });
    expect(mocks.deleteWorkspaceAttachmentFile).toHaveBeenCalledWith(
      'workspace-1',
      'objects/123e4567-e89b-12d3-a456-426614174000-notes.txt',
    );
  });

  it('refuses to delete an attachment already claimed by a conversation', async () => {
    mocks.attachmentFindFirst.mockResolvedValue(attachmentRow({ conversationId: 'conversation-1' }));

    const response = await DELETE(new Request('http://toolplane.test/api/v1/attachments/attachment-1', {
      method: 'DELETE',
    }), attachmentContext);

    expect(response.status).toBe(409);
    expect(mocks.attachmentDeleteMany).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspaceAttachmentFile).not.toHaveBeenCalled();
  });
});
