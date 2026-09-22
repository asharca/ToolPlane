// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: vi.fn(), workspace: vi.fn(), member: vi.fn(), admin: vi.fn(), activeUser: vi.fn(),
  update: vi.fn(), audit: vi.fn(), root: vi.fn(), target: vi.fn(), rpc: vi.fn(), slug: vi.fn() }));
vi.mock('@/lib/auth/request-user', () => ({ resolveAgentControlRequestUser: mocks.user }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.workspace }));
vi.mock('@/lib/observability/audit', () => ({ writeAudit: mocks.audit }));
vi.mock('@/lib/agents/queries', () => ({ ORDINARY_AGENT_FILTER: { publicRuntimeAllocation: { is: null }, NOT: { runtime: { is: { kind: 'public' } } } } }));
vi.mock('@/lib/a2a/local-policy', () => ({ createLocalRootGrant: mocks.root, localTarget: mocks.target }));
vi.mock('@/lib/a2a/http', () => ({ handleA2ARpc: mocks.rpc }));
vi.mock('@/lib/db', () => ({ db: { membership: { count: mocks.member }, workspace: { findUniqueOrThrow: mocks.slug },
  $transaction: async (fn: (tx: unknown) => unknown) => fn({ $queryRaw: vi.fn(),
    workspace: { count: mocks.admin }, user: { count: mocks.activeUser }, agent: { updateMany: mocks.update } }) } }));
import { handleLocalA2A } from '@/lib/a2a/local-http';
const request = (method = 'PUT', body: unknown = { enabled: true }, headers: Record<string, string> = {}) => new Request('https://toolplane.test/local', {
  method, headers: { authorization: 'Bearer fixture-account', 'content-type': 'application/json', ...headers },
  ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
});
beforeEach(() => {
  vi.clearAllMocks(); process.env.NEXT_PUBLIC_APP_URL = 'https://toolplane.test';
  mocks.user.mockResolvedValue({ id: 'actor' }); mocks.workspace.mockResolvedValue({ id: 'ws', slug: 'acme', ownerId: 'actor', status: 'active' });
  mocks.member.mockResolvedValue(0); mocks.admin.mockResolvedValue(1); mocks.activeUser.mockResolvedValue(1); mocks.update.mockResolvedValue({ count: 1 });
  mocks.target.mockResolvedValue({ name: 'Reviewer', binding: 'configuration-hash' }); mocks.slug.mockResolvedValue({ slug: 'acme' });
  mocks.root.mockResolvedValue({ kind: 'local', workspaceId: 'ws', actorId: 'actor', agentId: 'agent', ownerKey: 'owner' });
});
describe('native workspace A2A entry and opt-in', () => {
  it('requires account Bearer authentication, without a cookie or runtime fallback', async () => {
    mocks.user.mockResolvedValue(null);
    expect((await handleLocalA2A(request(), 'acme', 'agent')).status).toBe(401);
    expect(mocks.workspace).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
  it('rejects browser-origin requests, including an empty Origin header', async () => {
    expect((await handleLocalA2A(request('PUT', {}, { origin: '' }), 'acme', 'agent')).status).toBe(403);
    expect(mocks.user).not.toHaveBeenCalled();
  });
  it('does not grant ordinary members permission to enable another Agent', async () => {
    mocks.workspace.mockResolvedValue({ id: 'ws', ownerId: 'other', status: 'active' });
    expect((await handleLocalA2A(request(), 'acme', 'agent')).status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('rechecks administrative authority in the write transaction', async () => {
    mocks.admin.mockResolvedValue(0);
    expect((await handleLocalA2A(request(), 'acme', 'agent')).status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('scopes an explicit opt-in and audit to an ordinary Agent in the same workspace', async () => {
    const response = await handleLocalA2A(request(), 'acme', 'agent');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ where: { id: 'agent', workspaceId: 'ws', publicRuntimeAllocation: { is: null } }, data: { a2aInternalEnabled: true } });
    expect(mocks.update.mock.calls[0][0].where.NOT).toBeDefined();
    expect(mocks.audit.mock.calls[0][1]).toMatchObject({ actorId: 'actor', workspaceId: 'ws', targetId: 'agent', changes: { enabled: true } });
  });
  it('rejects arbitrary prompt/tool overrides and unavailable target IDs', async () => {
    expect((await handleLocalA2A(request('PUT', { enabled: true, systemPrompt: 'override' }), 'acme', 'agent')).status).toBe(400);
    mocks.update.mockResolvedValue({ count: 0 });
    expect((await handleLocalA2A(request(), 'acme', 'foreign')).status).toBe(404);
  });
  it('uses the standard JSON-RPC handler with a separate local resolver', async () => {
    mocks.rpc.mockImplementation(async (req, id, resolve) => {
      expect(id).toBe('agent');
      expect((await resolve(req)).grant).toMatchObject({ kind: 'local', agentId: 'agent' });
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
    });
    expect((await handleLocalA2A(request('POST', { jsonrpc: '2.0', id: 1, method: 'GetTask' }), 'acme', 'agent')).status).toBe(200);
    expect(mocks.root).toHaveBeenCalledWith('ws', 'agent', 'actor'); expect(mocks.update).not.toHaveBeenCalled();
  });
  it('publishes a standard protected Card with a trusted configured origin, not Host', async () => {
    const response = await handleLocalA2A(request('GET', null, { host: 'attacker.test' }), 'acme', 'agent');
    const card = await response.json();
    expect(card.supportedInterfaces).toEqual([{ url: 'https://toolplane.test/api/v1/workspaces/acme/agents/agent/a2a/local', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
    expect(card.capabilities.streaming).toBe(true); expect(card.defaultInputModes).toEqual(['text/plain']);
    expect(JSON.stringify(card)).not.toContain('attacker.test');
  });
  it('does not disclose an invalid deployment origin or underlying database errors', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://unsafe-deployment.test';
    const response = await handleLocalA2A(request('GET'), 'acme', 'agent');
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('unsafe-deployment');
    mocks.workspace.mockRejectedValue(new Error('private database error'));
    expect(await (await handleLocalA2A(request(), 'acme', 'agent')).text()).not.toContain('private database');
  });
});
