// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentCard, Task, TaskState, StreamResponse, SendMessageRequest, GetTaskRequest, ListTasksRequest, SubscribeToTaskRequest } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { TaskNotFoundError } from '@a2a-js/sdk/errors';
import type * as A2ALog from '@/lib/observability/a2a-log';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), live: vi.fn(), submit: vi.fn(), get: vi.fn(), row: vi.fn(),
  events: vi.fn(), list: vi.fn(), cancel: vi.fn(), endpoint: vi.fn(), wake: vi.fn(), record: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { agentEndpoint: { findFirstOrThrow: mocks.endpoint } } }));
vi.mock('@/lib/a2a/principal', () => ({ resolveA2AGrant: mocks.resolve, assertLiveGrant: mocks.live,
  isLocalGrant: () => false, isRemoteGrant: () => false, isWorkspaceGrant: () => false,
  grantTargetId: (grant: { endpointPublicId: string }) => grant.endpointPublicId,
  permits: (grant: { scopes: string[] }, op: string) => grant.scopes.includes(`a2a:${op}`),
  A2AHttpError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
}));
vi.mock('@/lib/a2a/worker', () => ({ wakeA2AWorker: mocks.wake }));
vi.mock('@/lib/a2a/store', () => ({ submitTask: mocks.submit, getTask: mocks.get, getTaskRow: mocks.row,
  eventsAfter: mocks.events, listTasks: mocks.list, requestCancellation: mocks.cancel }));
vi.mock('@/lib/runtime/ownership-state', () => ({ assertRuntimeOwner: vi.fn() }));
vi.mock('@/lib/observability/a2a-log', async (importOriginal) => ({
  ...await importOriginal<typeof A2ALog>(), recordA2AEvent: mocks.record,
}));
import { getLogContext, withLogContext, type LogContext } from '@/lib/observability/context';
import { A2AQuotaError } from '@/lib/a2a/quotas';
import { handleA2ARpc, handleA2ACard } from '@/lib/a2a/http';
import { buildAgentCard } from '@/lib/a2a/handler';
import { A2AHttpError, type A2AGrant, type LocalA2AGrant } from '@/lib/a2a/principal';

const grant: A2AGrant = { workspaceId: 'ws', endpointId: 'ep', endpointPublicId: 'agep_test', revisionId: 'rev',
  clientId: 'client', keyId: 'key', ownerKey: 'owner', expiresAt: null, scopes: ['a2a:send', 'a2a:read', 'a2a:cancel'],
  maxConcurrent: 2, timeoutSeconds: 30, retentionDays: 7 };
const userMessage = { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hello' }] };
const task = (state = TaskState.TASK_STATE_SUBMITTED) => Task.fromJSON({ id: 'task-1', contextId: 'ctx-1',
  status: { state, timestamp: '2026-09-22T00:00:00.000Z' }, history: [userMessage] });
const row = (state = TaskState.TASK_STATE_SUBMITTED) => ({ id: 'task-1', contextId: 'ctx-1',
  rootTaskId: 'task-1', parentTaskId: null, sequence: 1, snapshot: Task.toJSON(task(state)) });
function request(method: string, params: unknown = {}, version: string | null = '1.0') {
  return new Request('https://toolplane.test/api/v1/agent-endpoints/agep_test/a2a', { method: 'POST',
    headers: { authorization: 'Bearer fixture-not-real', 'content-type': 'application/json', ...(version ? { 'a2a-version': version } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}
const call = async (method: string, params?: unknown, version?: string | null) => (await handleA2ARpc(request(method, params, version), 'agep_test')).json();
const logContexts: LogContext[] = [];

beforeEach(() => {
  vi.clearAllMocks(); process.env.NEXT_PUBLIC_APP_URL = 'https://toolplane.test';
  logContexts.length = 0;
  mocks.record.mockImplementation(async () => { logContexts.push({ ...getLogContext()! }); });
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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('standard A2A JSON-RPC HTTP binding', () => {
  it('maps service-specific resource exhaustion to a bounded HTTP 429 response', async () => {
    mocks.submit.mockRejectedValue(new A2AQuotaError());
    const response = await handleA2ARpc(request('SendMessage', { message: userMessage, configuration: { returnImmediately: true } }), 'agep_test');
    expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('60');
    expect((await response.json()).error.code).toBe(-32099); expect(mocks.wake).not.toHaveBeenCalled();
  });

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
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.record.mock.calls[0][0]).toMatchObject({ eventName: 'a2a.request', rpcMethod: 'SendMessage',
      httpStatus: 200, outcome: 'success', responseKind: 'json', responseComplete: true,
      binding: { grant, taskId: 'task-1', contextId: 'ctx-1', rootTaskId: 'task-1' },
      metadata: { taskState: 'TASK_STATE_SUBMITTED' }, response: out });
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
    const entries = mocks.record.mock.calls.map(([entry]) => entry);
    expect(entries.map((entry) => [entry.httpStatus, entry.outcome, entry.metadata.rpcErrorCode])).toEqual([
      [200, 'error', -32700], [200, 'error', -32600], [200, 'error', -32602], [200, 'error', -32001],
    ]);
    expect(entries[0].request).toEqual({ rawText: '{' });
    expect(entries[3].binding.taskId).toBeUndefined();
  });
  it('does not execute mutation notifications', async () => {
    const notification = new Request(request('SendMessage'), { body: JSON.stringify({ jsonrpc: '2.0', method: 'SendMessage', params: { message: userMessage } }) });
    expect((await handleA2ARpc(notification, 'agep_test')).status).toBe(202);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.record.mock.calls[0][0]).toMatchObject({ httpStatus: 202, responseKind: 'none', responseComplete: true });
    expect(mocks.record.mock.calls[0][0].response).toBeUndefined();
  });
  it('suppresses native error text even when the official transport catches it', async () => {
    mocks.get.mockRejectedValue(new Error('postgres://password-secret@database private prompt'));
    const out = await call('GetTask', { id: 'task-1' });
    expect(out.error.code).toBe(-32603); expect(JSON.stringify(out)).not.toContain('password-secret');
    expect(mocks.record.mock.calls[0][0].response).toEqual(out);
    expect(JSON.stringify(mocks.record.mock.calls[0][0].response)).not.toContain('password-secret');
  });
  it('challenges invalid credentials and enforces operation permissions', async () => {
    mocks.resolve.mockRejectedValueOnce(new A2AHttpError(401, 'Invalid credential.'));
    const deniedRequest = request('GetTask', { id: 'task-1' });
    const denied = await handleA2ARpc(deniedRequest, 'agep_test');
    expect(denied.status).toBe(401); expect(denied.headers.get('www-authenticate')).toContain('Bearer');
    expect(deniedRequest.bodyUsed).toBe(false);
    mocks.resolve.mockResolvedValueOnce({ grant: { ...grant, scopes: ['a2a:read'] }, rateHeaders: new Headers() });
    expect((await handleA2ARpc(request('SendMessage', { message: userMessage }), 'agep_test')).status).toBe(403);
    expect(mocks.submit).not.toHaveBeenCalled();
    const entries = mocks.record.mock.calls.map(([entry]) => entry);
    expect(entries.map((entry) => [entry.httpStatus, entry.outcome])).toEqual([[401, 'denied'], [403, 'denied']]);
    for (const entry of entries) { expect(entry).not.toHaveProperty('request'); expect(entry).not.toHaveProperty('response'); }
    expect(entries[0].binding).toBeUndefined(); expect(entries[0].rpcMethod).toBe('unknown');
    expect(logContexts[0].requestId).toEqual(expect.any(String));
    expect(logContexts[0].traceId).toEqual(expect.any(String));
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
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.record.mock.calls[0][0]).toMatchObject({ outcome: 'cancelled', httpStatus: 200,
      responseKind: 'sse', responseComplete: false, binding: { taskId: 'task-1' } });
  });
  it('rejects subscriptions on terminal tasks with the standard error', async () => {
    mocks.row.mockResolvedValue(row(TaskState.TASK_STATE_COMPLETED));
    const response = await handleA2ARpc(request('SubscribeToTask', { id: 'task-1' }), 'agep_test');
    expect(await response.text()).toContain('"code":-32004');
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.record.mock.calls[0][0]).toMatchObject({ outcome: 'error', responseKind: 'sse',
      responseComplete: false, metadata: { rpcErrorCode: -32004, streamEventCount: 1 } });
  });
  it('bounds request bodies before any task mutation', async () => {
    const req = request('SendMessage', { message: userMessage }); req.headers.set('content-length', '262145');
    expect((await handleA2ARpc(req, 'agep_test')).status).toBe(413); expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.record.mock.calls[0][0]).toMatchObject({ httpStatus: 413, outcome: 'error' });
    expect(mocks.record.mock.calls[0][0].request).toBeUndefined();
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
    for (const stream of [client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: 'task-1' })),
      client.sendMessageStream(SendMessageRequest.fromJSON({ message: userMessage }))]) {
      const events = [];
      for await (const event of stream) events.push(StreamResponse.toJSON(event));
      expect((events as Record<string, unknown>[]).map((event) => Object.keys(event)[0])).toEqual(['task', 'statusUpdate', 'artifactUpdate', 'statusUpdate']);
      expect(events[2]).toMatchObject({ artifactUpdate: { artifact: { parts: [{ text: 'result' }] } } });
      const entry = mocks.record.mock.calls.at(-1)![0];
      expect(entry).toMatchObject({ outcome: 'success', responseKind: 'sse', responseComplete: true, truncated: false,
        metadata: { taskState: 'TASK_STATE_COMPLETED', streamEventCount: 4 } });
      expect(entry.response.events.map((event: { result: unknown }) => event.result)).toEqual(events);
    }
  });
  it('uses authorized task results instead of caller task IDs and preserves the request context', async () => {
    const local: LocalA2AGrant = { kind: 'local', workspaceId: 'ws', actorId: 'authorized-actor', agentId: 'authorized-agent',
      targetBinding: 'local-binding', ownerKey: 'local-owner', expiresAt: Date.now() + 60_000,
      scopes: ['a2a:send'], maxConcurrent: 2, timeoutSeconds: 30, retentionDays: 7, ancestorTaskIds: [], ancestorAgentIds: [] };
    mocks.resolve.mockResolvedValueOnce({ grant: local, rateHeaders: new Headers() });
    mocks.row.mockResolvedValueOnce({ ...row(), rootTaskId: 'root-1', parentTaskId: 'parent-1' });
    mocks.submit.mockImplementationOnce(async () => {
      expect(getLogContext()).toMatchObject({ workspaceId: 'ws', actorId: 'authorized-actor', agentId: 'authorized-agent', suppressPayload: true });
      return row();
    });
    await withLogContext({ requestId: 'request-1', traceId: 'trace-1', workspaceId: 'untrusted-parent',
      actorId: 'untrusted-actor', agentId: 'untrusted-agent', secrets: ['fixture-private'], suppressPayload: true }, async () => {
      const parent = getLogContext();
      await call('SendMessage', { message: { ...userMessage, taskId: 'forged-task', contextId: 'forged-context' },
        configuration: { returnImmediately: true } });
      expect(getLogContext()).toBe(parent);
      expect(parent?.workspaceId).toBe('untrusted-parent');
      expect(parent?.actorId).toBe('untrusted-actor'); expect(parent?.agentId).toBe('untrusted-agent');
    });
    expect(mocks.record.mock.calls[0][0].binding).toMatchObject({ taskId: 'task-1', contextId: 'ctx-1',
      rootTaskId: 'root-1', parentTaskId: 'parent-1' });
    expect(logContexts[0]).toMatchObject({ requestId: 'request-1', traceId: 'trace-1', suppressPayload: true });
    expect(mocks.record.mock.calls[0][0].secrets).toEqual(expect.arrayContaining(['fixture-private', 'fixture-not-real']));
  });
  it('does not associate list responses with a single task or copy caller method text into metadata', async () => {
    await call('ListTasks', {});
    expect(mocks.record.mock.calls[0][0].binding.taskId).toBeUndefined();
    expect(mocks.row).not.toHaveBeenCalled();
    const out = await call('private-prompt-method', {});
    const entry = mocks.record.mock.calls[1][0];
    expect(entry).toMatchObject({ rpcMethod: 'unknown', outcome: 'error', metadata: { rpcErrorCode: -32601 }, response: out });
    expect(entry.path).toBeUndefined();
    expect(JSON.stringify(entry.metadata)).not.toContain('private-prompt-method');
    expect(entry.request.method).toBe('private-prompt-method');
  });
  it.each([
    [TaskState.TASK_STATE_FAILED, 'error'], [TaskState.TASK_STATE_REJECTED, 'error'],
    [TaskState.TASK_STATE_CANCELED, 'cancelled'], [TaskState.TASK_STATE_WORKING, 'success'],
    [TaskState.TASK_STATE_INPUT_REQUIRED, 'success'], [TaskState.TASK_STATE_AUTH_REQUIRED, 'success'],
  ])('separates a task state %s from successful HTTP transport', async (state, outcome) => {
    mocks.get.mockResolvedValueOnce(task(state as TaskState));
    await call('GetTask', { id: 'task-1' });
    expect(mocks.record.mock.calls[0][0]).toMatchObject({ httpStatus: 200, outcome,
      metadata: { taskState: TaskState[state as TaskState] } });
  });
  it('preserves real timeout and late authorization failures after SDK error conversion', async () => {
    mocks.get.mockRejectedValueOnce(new DOMException('Private deadline detail', 'TimeoutError'));
    await call('GetTask', { id: 'task-1' });
    expect(mocks.record.mock.calls[0][0]).toMatchObject({ httpStatus: 200, outcome: 'timeout',
      metadata: { rpcErrorCode: -32603 } });
    mocks.live.mockRejectedValueOnce(new A2AHttpError(403, 'Revoked credential.'));
    await call('GetTask', { id: 'task-1' });
    const denied = mocks.record.mock.calls[1][0];
    expect(denied).toMatchObject({ httpStatus: 200, outcome: 'denied' });
    expect(denied).not.toHaveProperty('request'); expect(denied).not.toHaveProperty('response');
  });
  it('does not retain partial body text when reading fails', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"private":"partial')); },
      pull(controller) { controller.error(new Error('Read interrupted')); },
    });
    const req = new Request(request('GetTask'), { body, duplex: 'half' } as RequestInit);
    expect((await (await handleA2ARpc(req, 'agep_test')).json()).error.code).toBe(-32700);
    expect(mocks.record.mock.calls[0][0].request).toBeUndefined();
  });
  it('cannot fail a business request when logging rejects', async () => {
    mocks.record.mockRejectedValueOnce(new Error('Log storage unavailable'));
    expect((await call('GetTask', { id: 'task-1' })).result.id).toBe('task-1');
  });
  it('redacts and bounds cumulative Chinese SSE details without changing wire output or final task outcome', async () => {
    const text = '中文输出'.repeat(500) + ' password=fixture-private';
    mocks.events.mockResolvedValueOnce([
      ...Array.from({ length: 8 }, (_, index) => ({ sequence: index + 2, payload: { artifactUpdate: {
        taskId: 'task-1', contextId: 'ctx-1', artifact: { artifactId: `large-${index}`, parts: [{ text }] }, lastChunk: true,
      } } })),
      { sequence: 10, payload: { statusUpdate: { taskId: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_FAILED' } } } },
    ]);
    const response = await handleA2ARpc(request('SubscribeToTask', { id: 'task-1' }), 'agep_test');
    const wire = await response.text();
    const envelopes = wire.split('\n\n').filter(Boolean).map((line) => JSON.parse(line.slice('data: '.length)));
    expect(envelopes.slice(1, -1).map((event) => event.result.artifactUpdate.artifact.parts[0].text)).toEqual(Array(8).fill(text));
    expect(envelopes.at(-1).result.statusUpdate.status.state).toBe('TASK_STATE_FAILED');
    const entry = mocks.record.mock.calls[0][0];
    expect(entry).toMatchObject({ outcome: 'error', truncated: true, responseComplete: false,
      metadata: { taskState: 'TASK_STATE_FAILED', streamEventCount: 10 } });
    const detail = JSON.stringify({ workspaceMcpPayload: false, payload: { request: entry.request,
      response: entry.response, responseKind: entry.responseKind, responseComplete: entry.responseComplete } });
    expect(Buffer.byteLength(detail)).toBeLessThanOrEqual(32_768);
    expect(detail).not.toContain('fixture-private');
    expect(Array.isArray(JSON.parse(detail).payload.response.events)).toBe(true);
    expect(entry.response.events[1].result.artifactUpdate.artifact.parts[0].text).toContain('中文输出');
  });
  it('excludes heartbeats from SSE details and finishes naturally once', async () => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<unknown[]>();
    mocks.events.mockReturnValueOnce(gate.promise);
    const response = await handleA2ARpc(request('SubscribeToTask', { id: 'task-1' }), 'agep_test');
    const reader = response.body!.getReader();
    const completion = [{ sequence: 2, payload: { statusUpdate: { taskId: 'task-1', contextId: 'ctx-1',
      status: { state: 'TASK_STATE_COMPLETED' } } } }];
    try {
      await reader.read();
      const pending = reader.read();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(new TextDecoder().decode((await pending).value)).toBe(': keep-alive\n\n');
      gate.resolve(completion);
      while (!(await reader.read()).done) { /* Drain the natural task completion. */ }
      expect(mocks.record).toHaveBeenCalledTimes(1);
      const entry = mocks.record.mock.calls[0][0];
      expect(entry).toMatchObject({ responseComplete: true, metadata: { streamEventCount: 2 } });
      expect(entry.response.events.map((event: { result: unknown }) => Object.keys(event.result ?? {}))).toEqual([['task'], ['statusUpdate']]);
      expect(JSON.stringify(entry.response)).not.toContain('keep-alive');
    } finally { gate.resolve(completion); await reader.cancel(); }
  });
  it('records request abort exactly once under the saved trace after leaving its context', async () => {
    const controller = new AbortController();
    const req = new Request(request('SubscribeToTask', { id: 'task-1' }), { signal: controller.signal });
    const response = await withLogContext({ requestId: 'stream-request', traceId: 'stream-trace',
      secrets: ['stream-secret'] }, () => handleA2ARpc(req, 'agep_test'));
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel();
    await vi.waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));
    expect(mocks.record.mock.calls[0][0]).toMatchObject({ outcome: 'cancelled', responseComplete: false });
    expect(logContexts[0]).toMatchObject({ requestId: 'stream-request', traceId: 'stream-trace' });
    expect(mocks.record.mock.calls[0][0].secrets).toContain('stream-secret');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
