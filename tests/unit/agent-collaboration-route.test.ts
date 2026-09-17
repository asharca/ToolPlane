// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
const mock = vi.hoisted(() => ({ token: vi.fn(), current: vi.fn(), authorize: vi.fn(), handle: vi.fn() }));
vi.mock('@/lib/agents/runtime-access', () => ({ agentRuntimeTokenFromRequest: mock.token, bindRuntimeLogContext: vi.fn() }));
vi.mock('@/lib/agents/runtime-grant', () => ({ isAgentRuntimeGrantCurrent: mock.current }));
vi.mock('@/lib/agents/collaboration/service', () => ({ authorizeRun: mock.authorize }));
vi.mock('@/lib/agents/collaboration/mcp', () => ({ handleCollaborationMcp: mock.handle }));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/observability/http', () => ({ withRequestLogging: (_route: string, handler: unknown) => handler }));
import { POST } from '@/app/api/v1/agent-runtime/collaboration/[runId]/mcp/route';
import { CollaborationError } from '@/lib/agents/collaboration/protocol';
const context = { params: Promise.resolve({ runId: 'run-1' }) };
const req = () => new Request('https://tp.test/mcp', { method: 'POST', body: '{}' });
beforeEach(() => { vi.clearAllMocks(); mock.current.mockResolvedValue(true); mock.authorize.mockResolvedValue({}); mock.handle.mockResolvedValue(Response.json({ ok: true })); });
describe('collaboration runtime authentication', () => {
  it.each([null, { collaborationRunId: 'other-run' }, { workspaceId: 'w', agentId: 'a' }])('rejects missing or differently scoped authority', async (token) => {
    mock.token.mockResolvedValue(token);
    expect((await POST(req(), context)).status).toBe(401); expect(mock.handle).not.toHaveBeenCalled();
  });
  it('rejects a revoked resource grant before handling tools', async () => {
    mock.token.mockResolvedValue({ collaborationRunId: 'run-1' }); mock.current.mockResolvedValue(false);
    expect((await POST(req(), context)).status).toBe(403); expect(mock.handle).not.toHaveBeenCalled();
  });
  it('rejects a completed/canceled execution even with an unexpired signature', async () => {
    mock.token.mockResolvedValue({ collaborationRunId: 'run-1' });
    mock.authorize.mockRejectedValue(new CollaborationError('expired_grant', 'Revoked', 403));
    expect((await POST(req(), context)).status).toBe(403); expect(mock.handle).not.toHaveBeenCalled();
  });
  it('constructs caller identity solely from validated signed claims', async () => {
    mock.token.mockResolvedValue({ collaborationRunId: 'run-1', workspaceId: 'w', agentId: 'a' });
    expect((await POST(req(), context)).status).toBe(200);
    expect(mock.handle).toHaveBeenCalledWith(expect.any(Request), { kind: 'runtime', workspaceId: 'w', agentId: 'a', runId: 'run-1' });
  });
});
