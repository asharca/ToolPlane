// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attachmentFindMany: vi.fn(),
  readAttachment: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: { workspaceAttachment: { findMany: mocks.attachmentFindMany } },
}));
vi.mock('@/lib/attachments/storage', () => ({
  readWorkspaceAttachment: mocks.readAttachment,
}));

import {
  AttachmentMessageError,
  attachmentIdsFromParts,
  claimWorkspaceAttachments,
  hydrateWorkspaceAttachmentMessages,
} from '@/lib/attachments/messages';

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function stored(overrides: Partial<{
  id: string;
  workspaceId: string;
  name: string;
  mimeType: string;
  size: number;
  storagePath: string;
}> = {}) {
  return {
    id: 'attachment-1',
    workspaceId: 'workspace-1',
    name: 'file.txt',
    mimeType: 'text/plain',
    size: 4,
    storagePath: 'objects/file.txt',
    ...overrides,
  };
}

describe('workspace attachment messages', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts only exact internal attachment URLs and enforces five files', () => {
    expect(attachmentIdsFromParts([
      { type: 'file', url: '/api/v1/attachments/attachment-1' },
    ])).toEqual(['attachment-1']);
    expect(() => attachmentIdsFromParts([
      { type: 'file', url: 'https://toolplane.test/api/v1/attachments/attachment-1' },
    ])).toThrow(AttachmentMessageError);
    expect(() => attachmentIdsFromParts([
      { type: 'file', url: '/api/v1/attachments/attachment-1?download=1' },
    ])).toThrow(AttachmentMessageError);
    expect(() => attachmentIdsFromParts(Array.from({ length: 6 }, (_, index) => ({
      type: 'file',
      url: `/api/v1/attachments/attachment-${index}`,
    })))).toThrow(/at most 5/);
  });

  it('rejects an attachment already claimed by another conversation', async () => {
    const tx = {
      workspaceAttachment: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: 'workspace-1',
          uploadedById: 'user-1',
          chatThreadId: null,
          conversationId: 'conversation-2',
        }),
      },
    };

    await expect(claimWorkspaceAttachments(tx as never, {
      ids: ['attachment-1'],
      workspaceId: 'workspace-1',
      uploadedById: 'user-1',
      scope: { conversationId: 'conversation-1' },
    })).rejects.toMatchObject({ status: 409 });
  });

  it('allows an idempotent claim for the same conversation', async () => {
    const tx = {
      workspaceAttachment: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: 'workspace-1',
          uploadedById: 'user-1',
          chatThreadId: null,
          conversationId: 'conversation-1',
        }),
      },
    };

    await expect(claimWorkspaceAttachments(tx as never, {
      ids: ['attachment-1'],
      workspaceId: 'workspace-1',
      uploadedById: 'user-1',
      scope: { conversationId: 'conversation-1' },
    })).resolves.toBeUndefined();
  });

  it('rejects an attachment from another workspace or uploader', async () => {
    const tx = {
      workspaceAttachment: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: 'workspace-2',
          uploadedById: 'user-2',
          chatThreadId: null,
          conversationId: null,
        }),
      },
    };

    await expect(claimWorkspaceAttachments(tx as never, {
      ids: ['attachment-1'],
      workspaceId: 'workspace-1',
      uploadedById: 'user-1',
      scope: { chatThreadId: 'thread-1' },
    })).rejects.toMatchObject({ status: 400 });
  });

  it('hydrates a magic-checked PNG as transient Pi image data', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    mocks.attachmentFindMany.mockResolvedValue([stored({
      name: 'shot.png',
      mimeType: 'image/png',
      size: png.byteLength,
    })]);
    mocks.readAttachment.mockReturnValue(stream(png));

    const [message] = await hydrateWorkspaceAttachmentMessages([{
      role: 'user',
      parts: [{ type: 'file', url: '/api/v1/attachments/attachment-1' }],
    }], {
      workspaceId: 'workspace-1',
      scope: { conversationId: 'conversation-1' },
    });

    expect(message.parts).toEqual([
      { type: 'text', text: '[Attached image: "shot.png"]' },
      { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
    ]);
  });

  it('rejects image bytes that do not match the declared MIME type', async () => {
    const bytes = new TextEncoder().encode('not a png');
    mocks.attachmentFindMany.mockResolvedValue([stored({
      name: 'fake.png',
      mimeType: 'image/png',
      size: bytes.byteLength,
    })]);
    mocks.readAttachment.mockReturnValue(stream(bytes));

    await expect(hydrateWorkspaceAttachmentMessages([{
      role: 'user',
      parts: [{ type: 'file', url: '/api/v1/attachments/attachment-1' }],
    }], {
      workspaceId: 'workspace-1',
      scope: { chatThreadId: 'thread-1' },
    })).rejects.toMatchObject({ status: 415 });
  });

  it('rejects PDF instead of silently dropping it', async () => {
    mocks.attachmentFindMany.mockResolvedValue([stored({
      name: 'report.pdf',
      mimeType: 'application/pdf',
    })]);

    await expect(hydrateWorkspaceAttachmentMessages([{
      role: 'user',
      parts: [{ type: 'file', url: '/api/v1/attachments/attachment-1' }],
    }], {
      workspaceId: 'workspace-1',
      scope: { conversationId: 'conversation-1' },
    })).rejects.toMatchObject({ status: 415 });
    expect(mocks.readAttachment).not.toHaveBeenCalled();
  });
});
