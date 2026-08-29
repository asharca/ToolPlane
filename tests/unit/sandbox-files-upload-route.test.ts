// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAccountRequestUser: vi.fn(),
  findDeployment: vi.fn(),
  livePort: vi.fn(),
  maxAgentAttachmentBytes: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({
  resolveAccountRequestUser: mocks.resolveAccountRequestUser,
}));
vi.mock('@/lib/db', () => ({
  db: { deployment: { findFirst: mocks.findDeployment } },
}));
vi.mock('@/lib/process/supervisor', () => ({ livePort: mocks.livePort }));
vi.mock('@/lib/agents/attachment-limits', () => ({
  maxAgentAttachmentBytes: mocks.maxAgentAttachmentBytes,
  formatAttachmentByteLimit: (bytes: number) => `${bytes} bytes`,
}));

import { POST } from '@/app/api/v1/mcp/[deploymentId]/files/upload/route';

const context = { params: Promise.resolve({ deploymentId: 'sandbox-deployment' }) };

describe('sandbox file upload route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAccountRequestUser.mockResolvedValue({ id: 'user-1' });
    mocks.findDeployment.mockResolvedValue({ id: 'sandbox-deployment' });
    mocks.livePort.mockReturnValue(4312);
    mocks.maxAgentAttachmentBytes.mockResolvedValue(25_000_000);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('streams a file using the current admin limit', async () => {
    let uploaded = '';
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      uploaded = await new Response(init?.body).text();
      return Response.json({ relativePath: 'src/notes.txt', size: 5 }, { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(new Request(
      'http://toolplane.test/api/v1/mcp/sandbox-deployment/files/upload?path=src%2Fnotes.txt',
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'content-length': '5' },
        body: 'hello',
      },
    ), context);

    expect(response.status).toBe(201);
    expect(uploaded).toBe('hello');
    expect(mocks.findDeployment).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sandbox: { isNot: null } }),
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4312/files/upload?path=src%2Fnotes.txt'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-length': '5',
          'x-toolplane-max-upload-bytes': '25000000',
        }),
      }),
    );
  });

  it('rejects requests without account-level authorization', async () => {
    mocks.resolveAccountRequestUser.mockResolvedValue(null);

    const response = await POST(new Request(
      'http://toolplane.test/api/v1/mcp/sandbox-deployment/files/upload?path=notes.txt',
      { method: 'POST', body: 'hello' },
    ), context);

    expect(response.status).toBe(401);
    expect(mocks.findDeployment).not.toHaveBeenCalled();
  });

  it('rejects unsafe paths and files larger than the configured limit', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const unsafe = await POST(new Request(
      'http://toolplane.test/api/v1/mcp/sandbox-deployment/files/upload?path=..%2Fsecret',
      { method: 'POST', body: 'hello' },
    ), context);
    expect(unsafe.status).toBe(400);

    mocks.maxAgentAttachmentBytes.mockResolvedValue(4);
    const oversized = await POST(new Request(
      'http://toolplane.test/api/v1/mcp/sandbox-deployment/files/upload?path=notes.txt',
      { method: 'POST', headers: { 'content-length': '5' }, body: 'hello' },
    ), context);
    expect(oversized.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a live sandbox deployment in the caller workspace', async () => {
    mocks.findDeployment.mockResolvedValueOnce(null);
    const missing = await POST(new Request(
      'http://toolplane.test/api/v1/mcp/sandbox-deployment/files/upload?path=notes.txt',
      { method: 'POST', body: 'hello' },
    ), context);
    expect(missing.status).toBe(404);

    mocks.livePort.mockReturnValue(null);
    const stopped = await POST(new Request(
      'http://toolplane.test/api/v1/mcp/sandbox-deployment/files/upload?path=notes.txt',
      { method: 'POST', body: 'hello' },
    ), context);
    expect(stopped.status).toBe(503);
  });
});
