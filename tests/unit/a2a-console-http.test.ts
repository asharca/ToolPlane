// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ principal: vi.fn(), workspace: vi.fn(), active: vi.fn(), view: vi.fn(), mutate: vi.fn(), grant: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/auth/request-user', () => ({ resolveRequestPrincipal: mocks.principal }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.workspace }));
vi.mock('@/lib/db', () => ({ db: { user: { count: mocks.active } } }));
vi.mock('@/lib/observability/context', () => ({ withLogContext: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('@/lib/a2a/console-service', async (original) => ({ ...await original<typeof import('@/lib/a2a/console-service')>(), getA2AConsoleView: mocks.view, mutateA2AConsole: mocks.mutate }));
vi.mock('@/lib/a2a/local-policy', () => ({ createLocalRootGrant: mocks.grant }));
vi.mock('@/lib/a2a/http', () => ({ handleA2ARpc: mocks.rpc }));
import { handleA2AConsole, handleA2AConsoleRpc } from '@/lib/a2a/console-http';
function req(method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new Request('https://tp.example/api/console', { method,
    headers: { ...(method === 'POST' ? { origin: 'https://tp.example', 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
beforeEach(() => {
  vi.clearAllMocks(); process.env.NEXT_PUBLIC_APP_URL = 'https://tp.example';
  mocks.principal.mockResolvedValue({ user: { id: 'u' }, credential: 'session' });
  mocks.workspace.mockResolvedValue({ id: 'w', slug: 'ws', status: 'active' });
  mocks.active.mockResolvedValue(1); mocks.view.mockResolvedValue({ canManage: true });
  mocks.mutate.mockResolvedValue({ token: 'one-time-fixture' });
  mocks.grant.mockResolvedValue({ kind: 'local', workspaceId: 'w', agentId: 'a', actorId: 'u' });
  mocks.rpc.mockImplementation(async (request, id, resolve) => Response.json({ result: await resolve(request), id }));
});
describe('same-origin A2A console boundary', () => {
  it('loads safe session configuration without issuing credentials', async () => {
    const response = await handleA2AConsole(req(), 'ws', 'a');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.view).toHaveBeenCalledWith({ workspaceId: 'w', actorId: 'u', agentId: 'a', slug: 'ws' });
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it.each(['Bearer personal', 'Bearer tp_agent_private', 'Bearer toolkit', 'bad'])('never falls back from explicit %s to a browser cookie', async (authorization) => {
    expect((await handleA2AConsole(req('GET', undefined, { authorization }), 'ws', 'a')).status).toBe(401);
    expect(mocks.principal).not.toHaveBeenCalled();
  });
  it.each(['https://evil.example', 'null', '', 'https://tp.example/path', 'https://tp.example,https://evil.example'])('rejects mutation Origin %s', async (origin) => {
    expect((await handleA2AConsole(req('POST', { action: 'set-local', enabled: true }, { origin }), 'ws', 'a')).status).toBe(403);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('rejects missing Origin and malicious forwarded host', async () => {
    const request = req('POST', { action: 'set-local', enabled: false }); request.headers.delete('origin');
    request.headers.set('x-forwarded-host', 'evil.example');
    expect((await handleA2AConsole(request, 'ws', 'a')).status).toBe(403);
  });
  it('rejects cross-site reads and missing sessions', async () => {
    expect((await handleA2AConsole(req('GET', undefined, { 'sec-fetch-site': 'cross-site' }), 'ws', 'a')).status).toBe(403);
    mocks.principal.mockResolvedValue(null);
    expect((await handleA2AConsole(req(), 'ws', 'a')).status).toBe(401);
  });
  it('rejects disabled actors and unavailable workspaces', async () => {
    mocks.active.mockResolvedValue(0);
    expect((await handleA2AConsole(req(), 'ws', 'a')).status).toBe(401);
    mocks.workspace.mockResolvedValue(null);
    expect((await handleA2AConsole(req(), 'ws', 'a')).status).toBe(404);
  });
  it('does not allow caller-supplied workspace, user, scopes or target', async () => {
    const response = await handleA2AConsole(req('POST', { action: 'create-client', name: 'integration', scopes: ['*'], actorId: 'owner' }), 'ws', 'a');
    expect(response.status).toBe(400); expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('returns the one-time key without a fallible configuration reload', async () => {
    mocks.view.mockRejectedValue(new Error('database unavailable'));
    const response = await handleA2AConsole(req('POST', { action: 'create-client', name: 'integration' }), 'ws', 'a');
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, token: 'one-time-fixture' });
    expect(mocks.view).not.toHaveBeenCalled();
  });
  it('limits request bodies and sanitizes unexpected failures', async () => {
    expect((await handleA2AConsole(req('POST', { action: 'set-local', enabled: true }, { 'content-length': '5000' }), 'ws', 'a')).status).toBe(413);
    mocks.mutate.mockRejectedValue(new Error('fixture secret upstream stack'));
    const response = await handleA2AConsole(req('POST', { action: 'set-local', enabled: true }), 'ws', 'a');
    expect(response.status).toBe(500); expect(await response.text()).not.toContain('fixture secret');
  });
  it('uses the native RPC handler and trusted session actor, without a fabricated token', async () => {
    const request = req('POST', { jsonrpc: '2.0', id: 1, method: 'ListTasks', params: {} });
    const response = await handleA2AConsoleRpc(request, 'ws', 'a');
    expect(response.status).toBe(200); expect(mocks.grant).toHaveBeenCalledWith('w', 'a', 'u');
    expect(request.headers.has('authorization')).toBe(false);
  });
  it('does not let the playground bypass CSRF', async () => {
    expect((await handleA2AConsoleRpc(req('POST', {}, { origin: 'https://evil.example' }), 'ws', 'a')).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
