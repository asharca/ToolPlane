// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentCard, Task, TaskState, SendMessageRequest, GetTaskRequest, ListTasksRequest, SubscribeToTaskRequest } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { TaskNotFoundError } from '@a2a-js/sdk/errors';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), live: vi.fn(), submit: vi.fn(), get: vi.fn(), row: vi.fn(),
  events: vi.fn(), list: vi.fn(), cancel: vi.fn(), endpoint: vi.fn(), wake: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { agentEndpoint: { findFirstOrThrow: mocks.endpoint } } }));
vi.mock('@/lib/a2a/principal', () => ({ resolveA2AGrant: mocks.resolve, assertLiveGrant: mocks.live,
  isLocalGrant: () => false,
  permits: (grant: { scopes: string[] }, op: string) => grant.scopes.includes(`a2a:${op}`),
  A2AHttpError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
}));
vi.mock('@/lib/a2a/worker', () => ({ wakeA2AWorker: mocks.wake }));
vi.mock('@/lib/a2a/store', () => ({ submitTask: mocks.submit, getTask: mocks.get, getTaskRow: mocks.row,
  eventsAfter: mocks.events, listTasks: mocks.list, requestCancellation: mocks.cancel }));
vi.mock('@/lib/runtime/ownership-state', () => ({ assertRuntimeOwner: vi.fn() }));
import { handleA2ARpc, handleA2ACard } from '@/lib/a2a/http';
import { buildAgentCard } from '@/lib/a2a/handler';
import { A2AHttpError, type A2AGrant } from '@/lib/a2a/principal';

const grant: A2AGrant = { workspaceId: 'ws', endpointId: 'ep', endpointPublicId: 'agep_test', revisionId: 'rev',
  clientId: 'client', keyId: 'key', ownerKey: 'owner', expiresAt: null, scopes: ['a2a:send', 'a2a:read', 'a2a:cancel'],
  maxConcurrent: 2, timeoutSeconds: 30, retentionDays: 7 };
const userMessage = { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hello' }] };
const task = (state = TaskState.TASK_STATE_SUBMITTED) => Task.fromJSON({ id: 'task-1', contextId: 'ctx-1',
  status: { state, timestamp: '2026-09-22T00:00:00.000Z' }, history: [userMessage] });
const row = (state = TaskState.TASK_STATE_SUBMITTED) => ({ id: 'task-1', sequence: 1, snapshot: Task.toJSON(task(state)) });
function request(method: string, params: unknown = {}, version: string | null = '1.0') {
  return new Request('https://toolplane.test/api/v1/agent-endpoints/agep_test/a2a', { method: 'POST',
    headers: { authorization: 'Bearer fixture-not-real', 'content-type': 'application/json', ...(version ? { 'a2a-version': version } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}
const call = async (method: string, params?: unknown, version?: string | null) => (await handleA2ARpc(request(method, params, version), 'agep_test')).json();

beforeEach(() => {
  vi.clearAllMocks(); process.env.NEXT_PUBLIC_APP_URL = 'https://toolplane.test';
  mocks.resolve.mockResolvedValue({ grant, rateHeaders: new Headers() }); mocks.live.mockResolvedValue(undefined);
  mocks.endpoint.mockResolvedValue({ name: 'Published review service', publicId: 'agep_test', currentRevision: { version: 3 } });
  mocks.submit.mockResolvedValue(row()); mocks.row.mockResolvedValue(row()); mocks.get.mockResolvedValue(task(TaskState.TASK_STATE_COMPLETED));
  mocks.cancel.mockResolvedValue(task(TaskState.TASK_STATE_CANCELED));
  mocks.list.mockResolvedValue({ tasks: [task()], pageSize: 50, totalSize: 1, nextPageToken: '' });
  mocks.events.mockImplementation(async (_g, _id, sequence: number) => [
    { sequence: 2, payload: { statusUpdate: { taskId: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_WORKING' } } } },
    { sequence: 3, payload: { artifactUpdate: { taskId: 'task-1', contextId: 'ctx-1', artifact: { artifactId: 'a1', parts: [{ text: 'result' }] }, lastChunk: true } } },
    { sequence: 4, payload: { statusUpdate: { taskId: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_COMPLETED' } } } },
  ].filter((event) => event.sequence > sequence));
});

describe('standard A2A JSON-RPC HTTP binding', () => {
  it('returns a real versioned Agent Card without private configuration', async () => {
    const res = await handleA2ACard(new Request('https://untrusted-host.test/card'), 'agep_test');
    const card = await res.json();
    expect(card.supportedInterfaces).toEqual([{ url: 'https://toolplane.test/api/v1/agent-endpoints/agep_test/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
    expect(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme).toBe('Bearer');
    expect(card.capabilities).toMatchObject({ streaming: true, pushNotifications: false });
    expect(JSON.stringify(card)).not.toContain('systemPrompt');
  });
  it('returns accepted Task, not an AgentRun or legacy Response', async () => {
    const out = await call('SendMessage', { message: userMessage, configuration: { returnImmediately: true, historyLength: 0 } });
    expect(out.result.task).toMatchObject({ id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_SUBMITTED' } });
    expect(out.result.task.history ?? []).toEqual([]);
    expect(out.result.response).toBeUndefined(); expect(mocks.wake).toHaveBeenCalledTimes(1);
  });
  it.each(['0.3', '2.0', null])('rejects unsupported or missing version %s', async (version) => {
    expect((await call('GetTask', { id: 'task-1' }, version)).error.code).toBe(-32009);
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('ignores a compatible patch number, rejects old method names', async () => {
    expect((await call('GetTask', { id: 'task-1' }, '1.0.1')).result.id).toBe('task-1');
    expect((await call('message/send', { message: userMessage })).error.code).toBe(-32601);
  });
  it('distinguishes JSON parse, envelope, parameter and missing-task errors', async () => {
    const malformed = new Request(request('GetTask'), { body: '{' });
    expect((await (await handleA2ARpc(malformed, 'agep_test')).json()).error.code).toBe(-32700);
    const invalid = new Request(request('GetTask'), { body: '[]' });
    expect((await (await handleA2ARpc(invalid, 'agep_test')).json()).error.code).toBe(-32600);
    expect((await call('GetTask', { id: 't', historyLength: -1 })).error.code).toBe(-32602);
    mocks.get.mockRejectedValue(new TaskNotFoundError());
    expect((await call('GetTask', { id: 'foreign-task' })).error.code).toBe(-32001);
  });
  it('does not execute mutation notifications', async () => {
    const notification = new Request(request('SendMessage'), { body: JSON.stringify({ jsonrpc: '2.0', method: 'SendMessage', params: { message: userMessage } }) });
    expect((await handleA2ARpc(notification, 'agep_test')).status).toBe(202);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('suppresses native error text even when the official transport catches it', async () => {
    mocks.get.mockRejectedValue(new Error('postgres://password-secret@database private prompt'));
    const out = await call('GetTask', { id: 'task-1' });
    expect(out.error.code).toBe(-32603); expect(JSON.stringify(out)).not.toContain('password-secret');
  });
  it('challenges invalid credentials and enforces operation permissions', async () => {
    mocks.resolve.mockRejectedValueOnce(new A2AHttpError(401, 'Invalid credential.'));
    const denied = await handleA2ARpc(request('GetTask', { id: 'task-1' }), 'agep_test');
    expect(denied.status).toBe(401); expect(denied.headers.get('www-authenticate')).toContain('Bearer');
    mocks.resolve.mockResolvedValueOnce({ grant: { ...grant, scopes: ['a2a:read'] }, rateHeaders: new Headers() });
    expect((await handleA2ARpc(request('SendMessage', { message: userMessage }), 'agep_test')).status).toBe(403);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('reports unsupported capabilities with standard errors', async () => {
    expect((await call('CreateTaskPushNotificationConfig', { taskId: 'task-1', url: 'https://callback.test' })).error.code).toBe(-32003);
    expect((await call('GetExtendedAgentCard', {})).error.code).toBe(-32007);
  });
  it('keeps task execution independent of an abandoned subscription', async () => {
    const response = await handleA2ARpc(request('SubscribeToTask', { id: 'task-1' }), 'agep_test');
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"task"');
    await reader.cancel(); expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('rejects subscriptions on terminal tasks with the standard error', async () => {
    mocks.row.mockResolvedValue(row(TaskState.TASK_STATE_COMPLETED));
    const response = await handleA2ARpc(request('SubscribeToTask', { id: 'task-1' }), 'agep_test');
    expect(await response.text()).toContain('"code":-32004');
  });
  it('bounds request bodies before any task mutation', async () => {
    const req = request('SendMessage', { message: userMessage }); req.headers.set('content-length', '262145');
    expect((await handleA2ARpc(req, 'agep_test')).status).toBe(413); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('round-trips task, history and list defaults through the unmodified official client', async () => {
    const fetchImpl: typeof fetch = async (input, init) => handleA2ARpc(new Request(input, init), 'agep_test');
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })] })
      .createFromAgentCard(AgentCard.fromJSON(AgentCard.toJSON(await buildAgentCard(grant))));
    const sent = await client.sendMessage(SendMessageRequest.fromJSON({ message: userMessage, configuration: { returnImmediately: true } }));
    expect(sent).toMatchObject({ id: 'task-1', status: { state: TaskState.TASK_STATE_SUBMITTED } });
    expect(await client.getTask(GetTaskRequest.fromJSON({ id: 'task-1', historyLength: 0 }))).toMatchObject({ id: 'task-1' });
    const listed = await client.listTasks(ListTasksRequest.fromJSON({}));
    expect(listed.nextPageToken).toBe(''); expect(listed.pageSize).toBe(50);
    const events = [];
    for await (const event of client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: 'task-1' }))) events.push(event.payload?.$case);
    expect(events).toEqual(['task', 'statusUpdate', 'artifactUpdate', 'statusUpdate']);
  });
});
