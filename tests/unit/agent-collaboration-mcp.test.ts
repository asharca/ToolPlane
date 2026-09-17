// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), submit: vi.fn(), get: vi.fn(), next: vi.fn(), cancel: vi.fn(), current: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/agents/collaboration/service', () => ({ listDelegateAgents: mocks.list, submitDelegation: mocks.submit,
  getDelegation: mocks.get, continueDelegation: mocks.next, cancelDelegation: mocks.cancel,
  currentTask: mocks.current, updateCurrentTask: mocks.update }));
import { handleCollaborationMcp, collaborationAdmission } from '@/lib/agents/collaboration/mcp';
import { CollaborationError } from '@/lib/agents/collaboration/protocol';
const principal = { kind: 'runtime' as const, workspaceId: 'workspace', agentId: 'caller', runId: 'run' };
const request = (body: unknown, headers = {}) => new Request('https://tp.test/mcp', { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function call(name: string, args: unknown = {}) {
  return (await handleCollaborationMcp(request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), principal)).json();
}
beforeEach(() => { vi.clearAllMocks(); mocks.submit.mockResolvedValue({ id: 'task', status: { state: 'submitted' } }); });
describe('restricted collaboration MCP transport', () => {
  it('negotiates MCP tools only without claiming standard A2A or experimental MCP task support', async () => {
    const body = await (await handleCollaborationMcp(request({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }), principal)).json();
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
    const listed = await (await handleCollaborationMcp(request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), principal)).json();
    expect(listed.result.tools).toHaveLength(8);
    expect(JSON.stringify(listed.result.tools.map((t: { name: string }) => t.name))).not.toMatch(/approve|authorize/);
  });
  it('passes server-derived identity and strict validated input to durable admission', async () => {
    const args = { agentId: 'target', messageId: 'message-1', message: 'review' };
    const body = await call('delegate_to_agent', args);
    expect(mocks.submit).toHaveBeenCalledWith(principal, args);
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0].text).status.state).toBe('submitted');
    expect((await call('delegate_to_agent', { ...args, workspaceId: 'other' })).result.isError).toBe(true);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });
  it('never executes tools carried in a notification', async () => {
    const response = await handleCollaborationMcp(request({ jsonrpc: '2.0', method: 'tools/call', params: {
      name: 'delegate_to_agent', arguments: { agentId: 'target', messageId: 'message-1', message: 'review' },
    } }), principal);
    expect(response.status).toBe(202); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('returns tool errors rather than successful text and does not expose unexpected exception bodies', async () => {
    mocks.submit.mockRejectedValueOnce(new CollaborationError('capacity', 'Capacity reached.', 429));
    expect((await call('delegate_to_agent', { agentId: 't', messageId: 'm', message: 'review' })).result.isError).toBe(true);
    mocks.submit.mockRejectedValueOnce(new Error('provider-key-fixture and private native response'));
    const body = await call('delegate_to_agent', { agentId: 't', messageId: 'm', message: 'review' });
    expect(body.result.isError).toBe(true); expect(JSON.stringify(body)).not.toContain('provider-key-fixture');
    expect((await call('approve_delegation', { taskId: 't' })).result.isError).toBe(true);
  });
  it('rejects credential copying before persisting task content', async () => {
    const response = await handleCollaborationMcp(request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'delegate_to_agent', arguments: { agentId: 'target', messageId: 'm', message: 'Use runtime-secret-fixture' },
    } }, { authorization: 'Bearer runtime-secret-fixture' }), principal);
    expect(response.status).toBe(400); expect(mocks.submit).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('runtime-secret-fixture');
  });
  it('reclaims expired buckets even when the limiter is exactly at capacity', () => {
    const time = Date.now() + 1_000_000;
    for (let i = 0; i < 4096; i++) collaborationAdmission(`bucket-${i}`, time);
    expect(() => collaborationAdmission('after-expiry', time + 60_001)).not.toThrow();
  });
  it('caps request frequency per run without widening identity', async () => {
    const actor = { ...principal, runId: 'rate-fixture' };
    let status = 0;
    for (let i = 0; i < 121; i++) status = (await handleCollaborationMcp(request({ jsonrpc: '2.0', id: i, method: 'ping' }), actor)).status;
    expect(status).toBe(429);
  });
});
