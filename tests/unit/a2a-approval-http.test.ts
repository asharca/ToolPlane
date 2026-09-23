// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ principal: vi.fn(), workspace: vi.fn(), active: vi.fn(), token: vi.fn(), check: vi.fn(), list: vi.fn(), decide: vi.fn() }));
vi.mock('@/lib/auth/request-user', () => ({ resolveRequestPrincipal: mocks.principal }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.workspace }));
vi.mock('@/lib/db', () => ({ db: { user: { count: mocks.active } } }));
vi.mock('@/lib/observability/context', () => ({ withLogContext: (_c: unknown, f: () => unknown) => f() }));
vi.mock('@/lib/agents/runtime-access', () => ({ agentRuntimeTokenFromRequest: mocks.token }));
vi.mock('@/lib/a2a/tool-approvals', async (original) => ({ ...await original<typeof import('@/lib/a2a/tool-approvals')>(),
  checkNativeToolApproval: mocks.check, listNativeToolApprovals: mocks.list, decideNativeToolApproval: mocks.decide }));
import { handleRuntimeApprovals, handleConsoleApprovals } from '@/lib/a2a/approval-http';
const decision = { rootTaskId: 'root', taskId: 'child', approvalId: 'approval', inputHash: 'a'.repeat(64), decision: 'approved' };
function req(body: unknown, headers: Record<string, string> = {}, url = 'https://tp.example/api/approval') {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks(); process.env.NEXT_PUBLIC_APP_URL = 'https://tp.example';
  mocks.principal.mockResolvedValue({ user: { id: 'human' }, credential: 'session' });
  mocks.workspace.mockResolvedValue({ id: 'workspace', slug: 'ws', status: 'active' }); mocks.active.mockResolvedValue(1);
  mocks.token.mockResolvedValue({ a2aTaskId: 'child', a2aLeaseToken: 'lease', a2aApprovalRequired: true });
  mocks.check.mockResolvedValue({ status: 'pending' }); mocks.list.mockResolvedValue([]); mocks.decide.mockResolvedValue({ status: 'approved' });
});
it('binds the human decision to the verified session actor and exact hash', async () => {
  const result = await handleConsoleApprovals(req(decision, { origin: 'https://tp.example' }), 'ws', 'agent');
  expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toContain('no-store');
  expect(mocks.decide).toHaveBeenCalledWith({ workspaceId: 'workspace', actorId: 'human', agentId: 'agent', slug: 'ws' }, decision);
});
it.each(['null', 'https://evil.test', ''])('rejects decision origin %s before processing identity', async (origin) => {
  expect((await handleConsoleApprovals(req(decision, { origin }), 'ws', 'agent')).status).toBe(403);
  expect(mocks.decide).not.toHaveBeenCalled();
});
it('rejects missing Origin and does not fall back from a service Bearer to cookies', async () => {
  expect((await handleConsoleApprovals(req(decision), 'ws', 'agent')).status).toBe(403);
  expect((await handleConsoleApprovals(req(decision, { origin: 'https://tp.example', authorization: 'Bearer any' }), 'ws', 'agent')).status).toBe(401);
  expect(mocks.decide).not.toHaveBeenCalled();
});
it('rejects forged actor/arguments on a decision rather than granting edited work', async () => {
  expect((await handleConsoleApprovals(req({ ...decision, actorId: 'owner', input: { command: 'changed' } }, { origin: 'https://tp.example' }), 'ws', 'agent')).status).toBe(400);
  expect(mocks.decide).not.toHaveBeenCalled();
});
it('does not expose approval parameters through cross-site or ambiguous queries', async () => {
  const url = 'https://tp.example/api/approval?rootTaskId=root&taskId=child';
  expect((await handleConsoleApprovals(new Request(url, { headers: { 'sec-fetch-site': 'cross-site' } }), 'ws', 'agent')).status).toBe(403);
  expect((await handleConsoleApprovals(new Request(url + '&taskId=other'), 'ws', 'agent')).status).toBe(400);
  expect(mocks.list).not.toHaveBeenCalled();
});
it('the runtime has a check/ready contract, never an approve operation', async () => {
  expect((await handleRuntimeApprovals(req({ action: 'approve', ...decision }), 'child')).status).toBe(400);
  expect(mocks.check).not.toHaveBeenCalled();
  expect((await handleRuntimeApprovals(req({ action: 'check', callId: 'c', toolName: 'bash', input: { command: 'echo test' } }), 'child')).status).toBe(200);
  expect(mocks.check).toHaveBeenCalledWith(expect.objectContaining({ a2aLeaseToken: 'lease' }), expect.objectContaining({ callId: 'c' }));
});
it('requires the task-bound approval token and rejects browser runtime access', async () => {
  expect((await handleRuntimeApprovals(req({ action: 'ready' }, { origin: 'https://tp.example' }), 'child')).status).toBe(403);
  expect((await handleRuntimeApprovals(req({ action: 'ready' }), 'another')).status).toBe(401);
  mocks.token.mockResolvedValue({ a2aTaskId: 'child', a2aLeaseToken: 'lease' });
  expect((await handleRuntimeApprovals(req({ action: 'ready' }), 'child')).status).toBe(401);
  expect(mocks.check).not.toHaveBeenCalled();
});
it('bounds request bodies and sanitizes upstream failures', async () => {
  expect((await handleRuntimeApprovals(req({ action: 'ready' }, { 'content-length': '22000' }), 'child')).status).toBe(413);
  mocks.check.mockRejectedValue(new Error('private key fixture'));
  const r = await handleRuntimeApprovals(req({ action: 'ready' }), 'child');
  expect(r.status).toBe(500); expect(await r.text()).not.toContain('private key');
});
