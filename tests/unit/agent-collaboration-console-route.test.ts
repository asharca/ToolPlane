// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ auth: vi.fn(), workspace: vi.fn(), agent: vi.fn(), origin: vi.fn(),
  list: vi.fn(), get: vi.fn(), cancel: vi.fn(), next: vi.fn(), decide: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { agent: { count: m.agent } } }));
vi.mock('@/lib/auth/request-user', () => ({ resolveRequestPrincipal: m.auth }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: m.workspace }));
vi.mock('@/lib/http/origin', () => ({ isSameOriginRequest: m.origin }));
vi.mock('@/lib/observability/http', () => ({ withRequestLogging: (_path: string, handler: unknown) => handler }));
vi.mock('@/lib/agents/collaboration/service', () => ({ listDelegations: m.list, getDelegation: m.get,
  cancelDelegation: m.cancel, continueDelegation: m.next, decideDelegation: m.decide }));
import { GET, POST } from '@/app/api/v1/workspaces/[slug]/agents/[agentId]/collaboration/route';
const context = { params: Promise.resolve({ slug: 'team', agentId: 'caller' }) };
const request = (body: unknown) => new Request('https://tp.test/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks(); m.auth.mockResolvedValue({ credential: 'session', user: { id: 'member' } });
  m.workspace.mockResolvedValue({ id: 'workspace' }); m.agent.mockResolvedValue(1); m.origin.mockReturnValue(true);
  m.decide.mockResolvedValue({ id: 'task', status: { state: 'submitted' } }); m.list.mockResolvedValue([]);
});
describe('human task authorization route', () => {
  it('rejects toolkit tokens before reading or mutating tasks', async () => {
    m.auth.mockResolvedValue({ credential: 'toolkit-token', user: { id: 'member' } });
    expect((await GET(new Request('https://tp.test/api'), context)).status).toBe(401);
    expect((await POST(request({ action: 'approve', taskId: 'task' }), context)).status).toBe(401);
    expect(m.decide).not.toHaveBeenCalled(); expect(m.workspace).not.toHaveBeenCalled();
  });
  it('rejects cross-origin browser authorization and unavailable workspaces', async () => {
    m.origin.mockReturnValue(false);
    expect((await POST(request({ action: 'approve', taskId: 'task' }), context)).status).toBe(403);
    m.origin.mockReturnValue(true); m.workspace.mockResolvedValue(null);
    expect((await POST(request({ action: 'approve', taskId: 'task' }), context)).status).toBe(404);
    expect(m.decide).not.toHaveBeenCalled();
  });
  it('binds approval to the authenticated user and URL workspace, not fields in the body', async () => {
    expect((await POST(request({ action: 'approve', taskId: 'task', userId: 'admin' }), context)).status).toBe(400);
    expect((await POST(request({ action: 'approve', taskId: 'task' }), context)).status).toBe(200);
    expect(m.decide).toHaveBeenCalledWith({ kind: 'user', workspaceId: 'workspace', agentId: 'caller', userId: 'member' }, 'task', true);
  });
  it('returns no-store responses and uses distinct cancel/continue operations', async () => {
    const response = await GET(new Request('https://tp.test/api'), context);
    expect(response.headers.get('cache-control')).toContain('no-store');
    await POST(request({ action: 'cancel', taskId: 'task' }), context);
    expect(m.cancel).toHaveBeenCalledWith(expect.objectContaining({ userId: 'member' }), 'task');
    await POST(request({ action: 'continue', taskId: 'task', messageId: 'reply-1', message: 'main branch' }), context);
    expect(m.next).toHaveBeenCalledWith(expect.objectContaining({ kind: 'user' }), expect.objectContaining({ messageId: 'reply-1' }));
  });
});
