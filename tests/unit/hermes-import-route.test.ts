// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HERMES_ARCHIVE_IMPORT_MAX_DURATION_SECONDS } from '@/lib/agents/hermes/archive-limits';

const mocks = vi.hoisted(() => {
  class HermesArchiveError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    HermesArchiveError,
    resolveRequestUser: vi.fn(),
    getWorkspaceForUser: vi.fn(),
    getHermesArchiveSettings: vi.fn(),
    acquireHermesArchiveImportLock: vi.fn(),
    stageHermesArchiveStream: vi.fn(),
    findHermesArchiveImport: vi.fn(),
    importStagedHermesArchive: vi.fn(),
    isSameOriginRequest: vi.fn(),
  };
});

vi.mock('@/lib/auth/request-user', () => ({ resolveRequestUser: mocks.resolveRequestUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/admin/settings', () => ({ getHermesArchiveSettings: mocks.getHermesArchiveSettings }));
vi.mock('@/lib/http/origin', () => ({ isSameOriginRequest: mocks.isSameOriginRequest }));
vi.mock('@/lib/agents/hermes/archive', () => ({
  HermesArchiveError: mocks.HermesArchiveError,
  acquireHermesArchiveImportLock: mocks.acquireHermesArchiveImportLock,
  stageHermesArchiveStream: mocks.stageHermesArchiveStream,
}));
vi.mock('@/lib/agents/hermes/import', () => ({
  findHermesArchiveImport: mocks.findHermesArchiveImport,
  importStagedHermesArchive: mocks.importStagedHermesArchive,
}));

import {
  maxDuration,
  POST,
} from '@/app/api/v1/workspaces/[slug]/sandboxes/hermes-import/route';

function archiveRequest(options: {
  contentLength?: string;
  trusted?: boolean;
  contentType?: string;
  image?: string;
} = {}) {
  return new Request('http://toolplane.test/api/v1/workspaces/acme/sandboxes/hermes-import', {
    method: 'POST',
    headers: {
      origin: 'http://toolplane.test',
      'content-type': options.contentType ?? 'application/zip',
      'content-length': options.contentLength ?? '3',
      'x-toolplane-hermes-archive-name': encodeURIComponent('backup.zip'),
      'x-toolplane-hermes-import-name': encodeURIComponent('Recovered assistant'),
      'x-toolplane-hermes-import-id': 'import-request-0001',
      ...(options.trusted === false ? {} : { 'x-toolplane-hermes-archive-trusted': '1' }),
      ...(options.image === undefined
        ? {}
        : { 'x-toolplane-hermes-image': encodeURIComponent(options.image) }),
    },
    body: 'zip',
  });
}

describe('Hermes archive streaming import route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: 'user-1' });
    mocks.isSameOriginRequest.mockReturnValue(true);
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.getHermesArchiveSettings.mockResolvedValue({ hermesArchiveMaxUploadMiB: 10_240 });
    mocks.acquireHermesArchiveImportLock.mockResolvedValue({
      stagingToken: 'staging-token-0001',
      assertHeld: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    });
    mocks.stageHermesArchiveStream.mockResolvedValue({ directory: '/tmp/staged', cleanup: vi.fn() });
    mocks.findHermesArchiveImport.mockResolvedValue(null);
    mocks.importStagedHermesArchive.mockResolvedValue({ agentId: 'agent-1', sandboxId: 'sandbox-1' });
  });

  it('reserves an end-to-end duration for ingress and both Docker copy phases', () => {
    expect(maxDuration).toBe(HERMES_ARCHIVE_IMPORT_MAX_DURATION_SECONDS);
  });

  it('keeps the default Hermes image for compatible requests without an image header', async () => {
    const result = await POST(archiveRequest(), { params: Promise.resolve({ slug: 'acme' }) });

    expect(result.status).toBe(201);
    await expect(result.json()).resolves.toEqual({ agentId: 'agent-1', sandboxId: 'sandbox-1' });
    expect(mocks.stageHermesArchiveStream).toHaveBeenCalledWith(expect.objectContaining({
      name: 'backup.zip',
      size: 3,
      body: expect.any(Object),
    }), { maxUploadMiB: 10_240, stagingToken: 'staging-token-0001' });
    expect(mocks.importStagedHermesArchive).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      name: 'Recovered assistant',
      staged: expect.any(Object),
      importId: 'import-request-0001',
    });
    expect(mocks.getWorkspaceForUser).toHaveBeenCalledTimes(2);
  });

  it('strictly validates and forwards a selected Hermes image', async () => {
    const image = 'nousresearch/hermes-agent:v2026.8.3';

    const result = await POST(archiveRequest({ image }), { params: Promise.resolve({ slug: 'acme' }) });

    expect(result.status).toBe(201);
    expect(mocks.importStagedHermesArchive).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      name: 'Recovered assistant',
      staged: expect.any(Object),
      importId: 'import-request-0001',
      image,
    });
  });

  it('rejects an invalid Hermes image header before staging the archive', async () => {
    const result = await POST(archiveRequest({ image: '--privileged' }), {
      params: Promise.resolve({ slug: 'acme' }),
    });

    expect(result.status).toBe(400);
    expect(mocks.acquireHermesArchiveImportLock).not.toHaveBeenCalled();
    expect(mocks.stageHermesArchiveStream).not.toHaveBeenCalled();
    expect(mocks.importStagedHermesArchive).not.toHaveBeenCalled();
  });

  it('rejects a pre-announced archive above the configured limit before staging it', async () => {
    mocks.getHermesArchiveSettings.mockResolvedValue({ hermesArchiveMaxUploadMiB: 1 });

    const result = await POST(archiveRequest({ contentLength: String(1024 * 1024 + 1) }), {
      params: Promise.resolve({ slug: 'acme' }),
    });

    expect(result.status).toBe(413);
    expect(mocks.stageHermesArchiveStream).not.toHaveBeenCalled();
  });

  it('requires the dashboard origin and explicit trust acknowledgement', async () => {
    mocks.isSameOriginRequest.mockReturnValue(false);
    const crossSite = await POST(archiveRequest(), { params: Promise.resolve({ slug: 'acme' }) });
    expect(crossSite.status).toBe(403);

    mocks.isSameOriginRequest.mockReturnValue(true);
    const untrusted = await POST(archiveRequest({ trusted: false }), { params: Promise.resolve({ slug: 'acme' }) });
    expect(untrusted.status).toBe(400);
    expect(mocks.stageHermesArchiveStream).not.toHaveBeenCalled();
  });

  it('cleans the staged archive and refuses the mutation after membership is revoked', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    mocks.stageHermesArchiveStream.mockResolvedValue({ directory: '/tmp/staged', cleanup });
    mocks.getWorkspaceForUser
      .mockResolvedValueOnce({ id: 'workspace-1' })
      .mockResolvedValueOnce(null);

    const result = await POST(archiveRequest(), { params: Promise.resolve({ slug: 'acme' }) });

    expect(result.status).toBe(404);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(mocks.importStagedHermesArchive).not.toHaveBeenCalled();
  });

  it('cleans the staged archive when its import lease is lost after staging', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    mocks.stageHermesArchiveStream.mockResolvedValue({ directory: '/tmp/staged', cleanup });
    mocks.acquireHermesArchiveImportLock.mockResolvedValue({
      assertHeld: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new mocks.HermesArchiveError('lost lease', 409)),
      release: vi.fn().mockResolvedValue(undefined),
    });

    const result = await POST(archiveRequest(), { params: Promise.resolve({ slug: 'acme' }) });

    expect(result.status).toBe(409);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(mocks.importStagedHermesArchive).not.toHaveBeenCalled();
  });

  it('does not accept a second large import while the shared staging volume is busy', async () => {
    mocks.acquireHermesArchiveImportLock.mockResolvedValue(null);

    const result = await POST(archiveRequest(), { params: Promise.resolve({ slug: 'acme' }) });

    expect(result.status).toBe(409);
    expect(mocks.stageHermesArchiveStream).not.toHaveBeenCalled();
  });

  it('returns a completed import for the same client request ID without uploading again', async () => {
    mocks.findHermesArchiveImport.mockResolvedValue({
      status: 'completed',
      result: { agentId: 'agent-existing', sandboxId: 'sandbox-existing' },
    });

    const result = await POST(archiveRequest(), { params: Promise.resolve({ slug: 'acme' }) });

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ agentId: 'agent-existing', sandboxId: 'sandbox-existing' });
    expect(mocks.acquireHermesArchiveImportLock).not.toHaveBeenCalled();
    expect(mocks.stageHermesArchiveStream).not.toHaveBeenCalled();
  });

  it('does not report an incomplete import as a successful retry', async () => {
    mocks.findHermesArchiveImport.mockResolvedValue({
      status: 'incomplete',
      result: { agentId: 'agent-incomplete', sandboxId: 'sandbox-incomplete' },
    });

    const result = await POST(archiveRequest(), { params: Promise.resolve({ slug: 'acme' }) });

    expect(result.status).toBe(409);
    expect(mocks.acquireHermesArchiveImportLock).not.toHaveBeenCalled();
    expect(mocks.stageHermesArchiveStream).not.toHaveBeenCalled();
  });
});
