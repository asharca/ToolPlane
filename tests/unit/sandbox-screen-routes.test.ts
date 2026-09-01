// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  sandboxFindFirst: vi.fn(),
  captureConnectorScreen: vi.fn(),
  createConnectorScreenSession: vi.fn(),
  connectorFromConfig: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({ resolveRequestUser: mocks.resolveRequestUser }));
vi.mock('@/lib/db', () => ({ db: { sandbox: { findFirst: mocks.sandboxFindFirst } } }));
vi.mock('@/lib/sandboxes/connector-broker', () => ({
  captureConnectorScreen: mocks.captureConnectorScreen,
  createConnectorScreenSession: mocks.createConnectorScreenSession,
}));
vi.mock('@/lib/sandboxes/connector', () => ({ connectorFromConfig: mocks.connectorFromConfig }));

import { GET as getFrame } from '@/app/api/v1/workspaces/[slug]/sandboxes/[sandboxId]/screen/frame/route';
import { POST as createSession } from '@/app/api/v1/workspaces/[slug]/sandboxes/[sandboxId]/screen/sessions/route';

const context = { params: Promise.resolve({ slug: 'acme', sandboxId: 'sandbox-1' }) };

describe('sandbox screen routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: 'user-1' });
    mocks.sandboxFindFirst.mockResolvedValue({ id: 'sandbox-1', config: { connector: {} } });
    mocks.connectorFromConfig.mockReturnValue({ serverUrl: 'https://toolplane.example' });
  });

  it('returns a private binary frame only for a workspace-scoped connector sandbox', async () => {
    mocks.captureConnectorScreen.mockResolvedValue({
      data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
    });

    const response = await getFrame(
      new Request('https://toolplane.example/api/frame?displayId=main'),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    expect(mocks.sandboxFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'sandbox-1',
        kind: 'connector',
        workspace: {
          slug: 'acme',
          OR: [{ ownerId: 'user-1' }, { members: { some: { userId: 'user-1' } } }],
        },
      },
      select: { id: true },
    });
    expect(mocks.captureConnectorScreen).toHaveBeenCalledWith('sandbox-1', 'main');
  });

  it('does not expose a missing or foreign sandbox', async () => {
    mocks.sandboxFindFirst.mockResolvedValue(null);
    const response = await getFrame(
      new Request('https://toolplane.example/api/frame?displayId=main'),
      context,
    );

    expect(response.status).toBe(404);
    expect(mocks.captureConnectorScreen).not.toHaveBeenCalled();
  });

  it('creates a no-store RFB session from the configured connector URL', async () => {
    mocks.createConnectorScreenSession.mockResolvedValue({
      sessionId: 'session-1',
      viewerUrl: 'wss://toolplane.example/screen/view/ticket',
      expiresAt: '2026-08-31T12:00:00.000Z',
    });
    const response = await createSession(new Request('https://toolplane.example/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayId: 'vnc' }),
    }), context);

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      sessionId: 'session-1',
      viewerUrl: 'wss://toolplane.example/screen/view/ticket',
    });
    expect(mocks.createConnectorScreenSession).toHaveBeenCalledWith(
      'sandbox-1',
      'vnc',
      'https://toolplane.example',
    );
  });

  it('rejects unauthenticated screen requests before database access', async () => {
    mocks.resolveRequestUser.mockResolvedValue(null);
    const response = await createSession(new Request('https://toolplane.example/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ displayId: 'vnc' }),
    }), context);

    expect(response.status).toBe(401);
    expect(mocks.sandboxFindFirst).not.toHaveBeenCalled();
  });
});
