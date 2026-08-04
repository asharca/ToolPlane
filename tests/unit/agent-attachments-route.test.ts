// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  getAgentForRequest: vi.fn(),
  acquireHermesRuntimeWriteLease: vi.fn(),
  releaseHermesRuntimeWriteLease: vi.fn(),
  ensureHermesRuntimeReady: vi.fn(),
  systemSettingFindUnique: vi.fn(),
  conversationFindFirst: vi.fn(),
  attachmentCreate: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({
  resolveRequestUser: mocks.resolveRequestUser,
}));
vi.mock('@/lib/agents/queries', () => ({
  getAgentForRequest: mocks.getAgentForRequest,
}));
vi.mock('@/lib/agents/hermes/runtime', () => ({
  acquireHermesRuntimeWriteLease: mocks.acquireHermesRuntimeWriteLease,
  ensureHermesRuntimeReady: mocks.ensureHermesRuntimeReady,
  HERMES_RUNTIME_COPY_IN_PROGRESS_ERROR:
    'The Hermes runtime is temporarily unavailable while a clone is in progress.',
}));
vi.mock('@/lib/db', () => ({
  db: {
    systemSetting: { findUnique: mocks.systemSettingFindUnique },
    conversation: { findFirst: mocks.conversationFindFirst },
    agentAttachment: { create: mocks.attachmentCreate },
  },
}));

import { POST } from '@/app/api/v1/agents/[agentId]/attachments/route';

const context = { params: Promise.resolve({ agentId: 'agent-1' }) };

function uploadRequest(body: BodyInit = Buffer.from('spreadsheet bytes')) {
  return new Request(
    'http://toolplane.test/api/v1/agents/agent-1/attachments?conversationId=conv-1&filename=report.xlsx',
    {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      body,
    },
  );
}

describe('Agent attachment upload route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: 'user-1' });
    mocks.getAgentForRequest.mockResolvedValue({
      id: 'agent-1',
      workspaceId: 'workspace-1',
      runtime: { id: 'runtime-1', kind: 'hermes' },
    });
    mocks.conversationFindFirst.mockResolvedValue({ id: 'conv-1' });
    mocks.systemSettingFindUnique.mockResolvedValue(null);
    mocks.acquireHermesRuntimeWriteLease.mockReturnValue({
      release: mocks.releaseHermesRuntimeWriteLease,
    });
    mocks.ensureHermesRuntimeReady.mockResolvedValue({ port: 4312 });
    mocks.attachmentCreate.mockImplementation(async ({ data }) => ({
      id: 'attachment-1',
      ...data,
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('streams raw bytes to the Hermes workspace and persists returned metadata', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: URL, init: RequestInit) => {
      expect(url.searchParams.get('path')).toMatch(/^attachments\/conv-1\/.+-report\.xlsx$/);
      expect(init.body).toBeInstanceOf(ReadableStream);
      expect(new Headers(init.headers).get('x-toolplane-max-upload-bytes')).toBe('1000000000');
      await expect(new Response(init.body).text()).resolves.toBe('spreadsheet bytes');
      return new Response(JSON.stringify({
        path: '/opt/data/workspace/attachments/conv-1/stored-report.xlsx',
        size: 17,
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(uploadRequest(), context);

    expect(response.status).toBe(201);
    expect(mocks.attachmentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'workspace-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        name: 'report.xlsx',
        size: 17,
        storage: 'hermes-volume',
      }),
    });
  });

  it('rejects a declared file above the configured server limit before starting Hermes', async () => {
    mocks.systemSettingFindUnique.mockResolvedValue({ value: '100' });
    const request = uploadRequest(Buffer.from('small'));
    request.headers.set('content-length', '101');

    const response = await POST(request, context);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'Attachment exceeds the 100 bytes limit.' });
    expect(mocks.ensureHermesRuntimeReady).not.toHaveBeenCalled();
    expect(mocks.releaseHermesRuntimeWriteLease).toHaveBeenCalledOnce();
  });

  it('rejects uploads while a full clone holds the Hermes runtime', async () => {
    mocks.acquireHermesRuntimeWriteLease.mockReturnValue(null);

    const response = await POST(uploadRequest(), context);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'The Hermes runtime is temporarily unavailable while a clone is in progress.',
    });
    expect(mocks.ensureHermesRuntimeReady).not.toHaveBeenCalled();
  });

  it('does not allow an attachment to target another Agent conversation', async () => {
    mocks.conversationFindFirst.mockResolvedValue(null);

    const response = await POST(uploadRequest(), context);

    expect(response.status).toBe(404);
    expect(mocks.conversationFindFirst).toHaveBeenCalledWith({
      where: { id: 'conv-1', agentId: 'agent-1' },
      select: { id: true },
    });
    expect(mocks.ensureHermesRuntimeReady).not.toHaveBeenCalled();
  });

  it('returns an actionable JSON error when the runtime upload stream fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket closed')));

    const response = await POST(uploadRequest(), context);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'Could not reach the Hermes attachment store.',
    });
    expect(mocks.attachmentCreate).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated uploads before resolving an Agent', async () => {
    mocks.resolveRequestUser.mockResolvedValue(null);

    const response = await POST(uploadRequest(), context);

    expect(response.status).toBe(401);
    expect(mocks.getAgentForRequest).not.toHaveBeenCalled();
  });

  it('rejects legacy multipart bodies instead of buffering them in application memory', async () => {
    const form = new FormData();
    form.set('file', new File(['legacy'], 'legacy.txt', { type: 'text/plain' }));
    const request = new Request('http://toolplane.test/api/v1/agents/agent-1/attachments', {
      method: 'POST',
      body: form,
    });

    const response = await POST(request, context);

    expect(response.status).toBe(415);
    expect(mocks.ensureHermesRuntimeReady).not.toHaveBeenCalled();
  });
});
