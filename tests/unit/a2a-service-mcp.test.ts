// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Task, TaskState } from '@a2a-js/sdk';
import { TaskNotFoundError } from '@a2a-js/sdk/errors';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), live: vi.fn(), submit: vi.fn(), get: vi.fn(), list: vi.fn(), cancel: vi.fn(), endpoint: vi.fn(), wake: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { agentEndpoint: { findFirstOrThrow: mocks.endpoint } } }));
vi.mock('@/lib/a2a/principal', async (original) => ({ ...await original<typeof import('@/lib/a2a/principal')>(), resolveA2AGrant: mocks.resolve, assertLiveGrant: mocks.live }));
vi.mock('@/lib/a2a/store', () => ({ submitTask: mocks.submit, getTask: mocks.get, listTasks: mocks.list, requestCancellation: mocks.cancel }));
vi.mock('@/lib/a2a/worker', () => ({ wakeA2AWorker: mocks.wake }));
vi.mock('@/lib/runtime/ownership-state', () => ({ assertRuntimeOwner: vi.fn() }));
import { handleServiceMcp, executeServiceMcpTool } from '@/lib/a2a/service-mcp';
import { type A2AGrant, permits, A2AHttpError } from '@/lib/a2a/principal';
const grant: A2AGrant = { workspaceId: 'ws', endpointId: 'ep', endpointPublicId: 'agep_1', revisionId: 'rev',
  clientId: 'client', keyId: 'key', ownerKey: 'owner', expiresAt: null, scopes: ['a2a:send', 'a2a:read', 'a2a:cancel'], maxConcurrent: 2, timeoutSeconds: 30, retentionDays: 7 };
const task = Task.fromJSON({ id: 'native-task', contextId: 'native-context', status: { state: 'TASK_STATE_SUBMITTED' } });
const message = { messageId: 'test-message', role: 'ROLE_USER', parts: [{ text: 'review this' }] };
const url = 'https://toolplane.test/api/v1/agent-endpoints/agep_1/a2a/mcp';
function req(method: string, params?: unknown, id: number | undefined = 1) {
  return new Request(url, { method: 'POST', headers: { authorization: 'Bearer isolated-test-credential', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
}
beforeEach(() => {
  vi.clearAllMocks(); process.env.NEXT_PUBLIC_APP_URL = 'https://toolplane.test';
  mocks.resolve.mockResolvedValue({ grant, rateHeaders: new Headers() }); mocks.live.mockResolvedValue(undefined);
  mocks.endpoint.mockResolvedValue({ name: 'Published', publicId: 'agep_1', currentRevision: { version: 1 } });
  mocks.submit.mockResolvedValue({ id: task.id, snapshot: Task.toJSON(task) }); mocks.get.mockResolvedValue(task);
  mocks.list.mockResolvedValue({ tasks: [task], pageSize: 20, totalSize: 1, nextPageToken: '' }); mocks.cancel.mockResolvedValue({ ...task, status: { state: TaskState.TASK_STATE_WORKING } });
});
describe('MCP facade delegates to the native A2A core', () => {
  it('uses the unmodified official MCP client and HTTP transport', async () => {
    const client = new Client({ name: 'interop', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: 'Bearer isolated-test-credential' } },
      fetch: async (input, init) => handleServiceMcp(new Request(input, init), 'agep_1') });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(4);
      const accepted = await client.callTool({ name: 'a2a_send_message', arguments: { message } });
      expect(accepted.isError).toBe(false); expect(JSON.stringify(accepted)).toContain('native-task');
      expect(mocks.submit).toHaveBeenCalledWith(grant, expect.objectContaining({ configuration: expect.objectContaining({ returnImmediately: true }) }));
      expect(mocks.get).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });
  it('returns A2A ownership-aware task queries and bounds list summaries', async () => {
    await executeServiceMcpTool(grant, 'a2a_get_task', { id: task.id, historyLength: 0 });
    expect(mocks.get).toHaveBeenCalledWith(grant, task.id, 0);
    await executeServiceMcpTool(grant, 'a2a_list_tasks', { pageSize: 100, historyLength: 10, includeArtifacts: true });
    expect(mocks.list).toHaveBeenCalledWith(grant, expect.objectContaining({ pageSize: 20, historyLength: 0, includeArtifacts: false }));
  });
  it('requests cancellation without pretending the executor has stopped', async () => {
    const result = await executeServiceMcpTool(grant, 'a2a_cancel_task', { id: task.id });
    expect(result).toMatchObject({ task: { status: { state: 'TASK_STATE_WORKING' } } });
    expect(mocks.cancel).toHaveBeenCalledWith(grant, task.id); expect(mocks.get).not.toHaveBeenCalled();
  });
  it('never upgrades old wildcard or Responses scopes to A2A', async () => {
    expect(permits({ scopes: ['*'] }, 'send')).toBe(false);
    expect(permits({ scopes: ['responses:create'] }, 'send')).toBe(false);
    expect(permits({ scopes: ['a2a:cancel'] }, 'cancel')).toBe(false);
    await expect(executeServiceMcpTool({ ...grant, scopes: ['*'] }, 'a2a_send_message', { message })).rejects.toMatchObject({ status: 403 });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('filters discovery and reauthorizes tool calls', async () => {
    mocks.resolve.mockResolvedValue({ grant: { ...grant, scopes: ['a2a:read'] }, rateHeaders: new Headers() });
    const response = await handleServiceMcp(req('tools/list', {}), 'agep_1');
    const body = await response.json(); expect(body.result.tools.map((t: {name: string}) => t.name)).toEqual(['a2a_get_task', 'a2a_list_tasks']);
    const denied = await handleServiceMcp(req('tools/call', { name: 'a2a_send_message', arguments: { message } }), 'agep_1');
    expect((await denied.json()).result.isError).toBe(true); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('does not execute tool calls supplied as notifications', async () => {
    const request = new Request(req('tools/call'), { body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'a2a_send_message', arguments: { message } } }) });
    expect((await handleServiceMcp(request, 'agep_1')).status).toBe(202); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it.each([{ ...message, parts: [{ text: 'x', url: 'http://metadata' }] }, { ...message, role: 'user' }])('keeps standard validation before decoding', async (bad) => {
    await expect(executeServiceMcpTool(grant, 'a2a_send_message', { message: bad })).rejects.toThrow(); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('rejects tenant changes and unauthorized tasks, with safe errors', async () => {
    await expect(executeServiceMcpTool(grant, 'a2a_send_message', { message, tenant: 'other-endpoint' })).rejects.toBeInstanceOf(TaskNotFoundError);
    mocks.get.mockRejectedValue(new Error('private provider key: never-leak'));
    const response = await handleServiceMcp(req('tools/call', { name: 'a2a_get_task', arguments: { id: 'foreign' } }), 'agep_1');
    const out = await response.json(); expect(out.result.isError).toBe(true); expect(JSON.stringify(out)).not.toContain('never-leak');
  });
  it('returns authentication failures without cookie fallback', async () => {
    mocks.resolve.mockRejectedValue(new A2AHttpError(401, 'Invalid'));
    const response = await handleServiceMcp(req('tools/list'), 'agep_1'); expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer'); expect(mocks.submit).not.toHaveBeenCalled();
  });
});
