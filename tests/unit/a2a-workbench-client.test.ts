// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendMessageRequest, Task, TaskState } from '@a2a-js/sdk';
import { parseWorkbenchSelection, readWorkbenchJson, workbenchHref, workbenchMessage, workbenchRpc, workbenchTask } from '@/lib/a2a/workbench-client';

const task = (state: TaskState) => Task.fromJSON({ id: 'task-1', contextId: 'ctx-1', status: { state, timestamp: '2026-09-23T00:00:00Z' } });
afterEach(() => vi.unstubAllGlobals());
describe('native workbench contract', () => {
  it('builds a new standard user message without selecting an arbitrary task or context', () => {
    const wire = workbenchMessage('  Review changes  ', null, 'message-1');
    expect(wire).toMatchObject({ message: { messageId: 'message-1', role: 'ROLE_USER', parts: [{ text: 'Review changes' }] }, configuration: { returnImmediately: true, historyLength: 0 } });
    const decoded = SendMessageRequest.fromJSON(wire);
    expect(wire.message).not.toHaveProperty('taskId'); expect(wire.message).not.toHaveProperty('contextId');
    expect(decoded.message?.taskId).toBe(''); expect(decoded.message?.contextId).toBe('');
  });
  it('continues an input-required task with its task and context IDs', () => {
    expect(workbenchMessage('main', task(TaskState.TASK_STATE_INPUT_REQUIRED), 'answer-1')).toMatchObject({ message: { taskId: 'task-1', contextId: 'ctx-1', messageId: 'answer-1' } });
  });
  it.each([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED])('creates a new task after terminal state %s', (state) => {
    const request = SendMessageRequest.fromJSON(workbenchMessage('Refine it', task(state), 'followup-1'));
    expect(request.message).toMatchObject({ contextId: 'ctx-1', referenceTaskIds: ['task-1'] });
    expect(request.message?.taskId).toBe('');
    expect(workbenchMessage('Refine it', task(state), 'followup-1').message).not.toHaveProperty('taskId');
  });
  it.each([TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_AUTH_REQUIRED, TaskState.TASK_STATE_UNSPECIFIED])('never treats state %s as model-approved continuation', (state) => {
    expect(() => workbenchMessage('approved', task(state), 'message-2')).toThrow();
  });
  it('bounds text and route selection while preserving SDK fields', () => {
    expect(() => workbenchMessage(' ', null, 'x')).toThrow();
    expect(() => workbenchMessage('x'.repeat(20001), null, 'x')).toThrow();
    expect(parseWorkbenchSelection({ task: 'task-1' }).success).toBe(false);
    expect(parseWorkbenchSelection({ agent: ['a', 'b'] }).success).toBe(false);
    expect(parseWorkbenchSelection({ agent: 'a', task: 't', workspaceId: 'other' }).success).toBe(false);
    expect(parseWorkbenchSelection({ agent: 'a', task: 't' }).success).toBe(true);
    expect(workbenchHref('a/b', 'agent&x', 'task#x')).toBe('/app/a%2Fb/work?mode=a2a&agent=agent%26x&task=task%23x');
    expect(workbenchTask(Task.toJSON(task(TaskState.TASK_STATE_COMPLETED))).status?.timestamp).toBe('2026-09-23T00:00:00Z');
    expect(() => workbenchTask({ id: 't', contextId: 'c', status: { state: 'invented' } })).toThrow();
  });
  it('uses the same-origin BFF and matches the RPC ID without automatic retries', async () => {
    const fetcher = vi.fn(async (_url, init) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: { task: Task.toJSON(task(1)) } })));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const result = await workbenchRpc('/console', 'SendMessage', { message: {} }, controller.signal);
    expect(result.task).toBeDefined(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', headers: { 'A2A-Version': '1.0' } });
    fetcher.mockRejectedValueOnce(new Error('Connection lost'));
    await expect(workbenchRpc('/console', 'SendMessage', {}, controller.signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([{ jsonrpc: '2.0', id: 'wrong', result: {} }, { jsonrpc: '2.0', result: {} }, { jsonrpc: '2.0', error: { code: -32603 } }])('rejects malformed/unmatched RPC envelopes', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
    await expect(workbenchRpc('/console', 'GetTask', { id: 'task-1' }, new AbortController().signal)).rejects.toThrow();
  });
  it('bounds response bytes and propagates body cancellation', async () => {
    await expect(readWorkbenchJson(new Response('x'.repeat(2 * 1024 * 1024 + 1)))).rejects.toThrow('limit');
    const cancel = vi.fn(); const controller = new AbortController();
    const response = new Response(new ReadableStream({ cancel }));
    const result = readWorkbenchJson(response, controller.signal);
    controller.abort(); await expect(result).rejects.toThrow(); expect(cancel).toHaveBeenCalled();
  });
});
