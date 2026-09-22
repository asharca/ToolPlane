// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: vi.fn(), workspace: vi.fn(), member: vi.fn(), endpoint: vi.fn(),
  current: vi.fn(), update: vi.fn(), count: vi.fn(), create: vi.fn(), audit: vi.fn(), key: vi.fn(), lock: vi.fn() }));
vi.mock('@/lib/auth/request-user', () => ({ resolveAgentControlRequestUser: mocks.user }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.workspace }));
vi.mock('@/lib/observability/audit', () => ({ writeAudit: mocks.audit }));
vi.mock('@/lib/agents/public-api/auth', () => ({ createAgentApiKey: mocks.key }));
vi.mock('@/lib/a2a/principal', () => ({ A2A_SCOPES: ['a2a:send', 'a2a:read', 'a2a:cancel'] }));
vi.mock('@/lib/db', () => ({ db: { membership: { count: mocks.member }, agentEndpoint: { findFirst: mocks.endpoint },
  $transaction: async (fn: (tx: unknown) => unknown) => fn({ $queryRaw: mocks.lock,
    agentEndpoint: { findFirst: mocks.current, update: mocks.update },
    agentApiClient: { count: mocks.count, create: mocks.create } }),
} }));
import { manageA2AService } from '@/lib/a2a/management';
const request = (body: unknown = { enabled: true }) => new Request('https://toolplane.test/manage', {
  method: 'POST', headers: { authorization: 'Bearer account-fixture', 'content-type': 'application/json' }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'u' });
  mocks.workspace.mockResolvedValue({ id: 'w', status: 'active', ownerId: 'u' }); mocks.member.mockResolvedValue(0);
  mocks.endpoint.mockResolvedValue({ id: 'ep', publicId: 'agep_fixture', status: 'active', currentRevisionId: 'rev' });
  mocks.current.mockResolvedValue({ id: 'ep' }); mocks.count.mockResolvedValue(0);
  mocks.create.mockResolvedValue({ id: 'client' }); mocks.key.mockResolvedValue({ token: 'fixture-created-once' });
});
describe('A2A publication authorization', () => {
  it('rejects missing account-level credentials before changing publication', async () => {
    mocks.user.mockResolvedValue(null);
    expect((await manageA2AService(request(), 'workspace', 'agent')).status).toBe(401);
    expect(mocks.workspace).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
  it('does not permit an ordinary workspace member to publish or mint credentials', async () => {
    mocks.workspace.mockResolvedValue({ id: 'w', status: 'active', ownerId: 'other' });
    expect((await manageA2AService(request({ enabled: true, clientName: 'attacker' }), 'workspace', 'agent')).status).toBe(403);
    expect(mocks.endpoint).not.toHaveBeenCalled(); expect(mocks.key).not.toHaveBeenCalled();
  });
  it('fails closed for an inaccessible or inactive workspace', async () => {
    mocks.workspace.mockResolvedValue({ id: 'w', status: 'closing', ownerId: 'u' });
    expect((await manageA2AService(request(), 'workspace', 'agent')).status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('permits explicit administrators but scopes the target to the workspace and source Agent', async () => {
    mocks.workspace.mockResolvedValue({ id: 'w', status: 'active', ownerId: 'other' }); mocks.member.mockResolvedValue(1);
    expect((await manageA2AService(request(), 'workspace', 'agent')).status).toBe(200);
    expect(mocks.member).toHaveBeenCalledWith({ where: { workspaceId: 'w', userId: 'u', role: 'admin' } });
    expect(mocks.endpoint.mock.calls[0][0].where).toEqual({ workspaceId: 'w', sourceAgentId: 'agent' });
  });
  it('creates a least-privilege client and returns its token once without auditing it', async () => {
    const response = await manageA2AService(request({ enabled: true, clientName: 'Integration' }), 'workspace', 'agent');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ enabled: true, token: 'fixture-created-once', clientId: 'client',
      scopes: ['a2a:send', 'a2a:read', 'a2a:cancel'] });
    expect(mocks.create.mock.calls[0][0].data.scopes).not.toContain('responses:create');
    expect(mocks.audit.mock.calls[0][1].changes).toEqual({ enabled: true, clientId: 'client' });
  });
  it('does not mint a client when disabling a service', async () => {
    expect((await manageA2AService(request({ enabled: false, clientName: 'ignored' }), 'workspace', 'agent')).status).toBe(200);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.key).not.toHaveBeenCalled();
    expect(mocks.update.mock.calls[0][0].data).toEqual({ a2aEnabled: false });
  });
  it('requires an existing published revision and rejects configuration override fields', async () => {
    expect((await manageA2AService(request({ enabled: true, systemPrompt: 'override' }), 'workspace', 'agent')).status).toBe(400);
    mocks.endpoint.mockResolvedValue(null);
    expect((await manageA2AService(request(), 'workspace', 'agent')).status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('does not leak a key creation error and warns about partial client creation', async () => {
    mocks.key.mockRejectedValue(new Error('private database details'));
    const response = await manageA2AService(request({ enabled: true, clientName: 'Integration' }), 'workspace', 'agent');
    expect(response.status).toBe(409);
    const body = await response.text(); expect(body).not.toContain('private database'); expect(body).toContain('before retrying');
  });
});
