// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ principal: vi.fn(), workspace: vi.fn(), active: vi.fn(), view: vi.fn(), mutate: vi.fn() }));
vi.mock('@/lib/auth/request-user', () => ({ resolveRequestPrincipal: mocks.principal }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.workspace }));
vi.mock('@/lib/db', () => ({ db: { user: { count: mocks.active } } }));
vi.mock('@/lib/a2a/remote-registry', async (original) => ({ ...await original<typeof import('@/lib/a2a/remote-registry')>(),
  remoteRegistryView: mocks.view, mutateRemoteRegistry: mocks.mutate }));
import { handleRemoteRegistry } from '@/lib/a2a/remote-http';
const request = (body?: unknown, extra: Record<string, string> = {}) => new Request('https://tp.example/api/remotes', {
  method: body ? 'POST' : 'GET', headers: { ...(body ? { origin: 'https://tp.example', 'content-type': 'application/json' } : {}), ...extra },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const action = { action: 'register', name: 'Remote', cardUrl: 'https://remote.example/card', rpcUrl: 'https://remote.example/rpc' };
beforeEach(() => {
  vi.clearAllMocks(); process.env.NEXT_PUBLIC_APP_URL = 'https://tp.example';
  mocks.principal.mockResolvedValue({ user: { id: 'u' }, credential: 'session' });
  mocks.workspace.mockResolvedValue({ id: 'w', slug: 'ws', status: 'active' }); mocks.active.mockResolvedValue(1);
  mocks.view.mockResolvedValue({ canManage: false, agents: [] }); mocks.mutate.mockResolvedValue({ id: 'remote-id' });
});
describe('remote registration same-origin session boundary', () => {
  it('returns only the safe registry view and performs no registration on GET', async () => {
    const response = await handleRemoteRegistry(request(), 'ws', 'a'); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store'); expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('derives actor/workspace/current Agent from the authenticated route', async () => {
    expect((await handleRemoteRegistry(request(action), 'ws', 'a')).status).toBe(200);
    expect(mocks.mutate).toHaveBeenCalledWith({ workspaceId: 'w', actorId: 'u', agentId: 'a', slug: 'ws' }, action, expect.any(AbortSignal));
  });
  it.each<Record<string, string>>([{ authorization: 'Bearer personal' }, { origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }])('rejects foreign credentials/origin before network discovery', async (headers) => {
    expect((await handleRemoteRegistry(request(action, headers), 'ws', 'a')).status).toBeGreaterThanOrEqual(400);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('rejects supplied authority, unexpected operations and oversized bodies', async () => {
    expect((await handleRemoteRegistry(request({ ...action, workspaceId: 'victim', allowedAgentIds: ['*'] }), 'ws', 'a')).status).toBe(400);
    expect((await handleRemoteRegistry(request({ action: 'call-url', url: 'http://localhost' }), 'ws', 'a')).status).toBe(400);
    expect((await handleRemoteRegistry(request(action, { 'content-length': '20000' }), 'ws', 'a')).status).toBe(413);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('does not leak unknown provider/SQL/credential errors', async () => {
    mocks.mutate.mockRejectedValue(new Error('private-key-and-database-stack'));
    const response = await handleRemoteRegistry(request(action), 'ws', 'a'); expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private-key-and-database-stack');
  });
});
