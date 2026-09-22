// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Task, TaskState, SendMessageRequest } from '@a2a-js/sdk';
import { toJsonRpcError } from '@a2a-js/sdk/errors';
import { assertTransition, historyView, taskEvent, jsonEvent, textArtifact } from '@/lib/a2a/model';
import { validateParams, validateSend } from '@/lib/a2a/validation';

const message = { messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'hello' }] };
const task = () => Task.fromJSON({ id: 't-1', contextId: 'c-1', status: { state: 'TASK_STATE_WORKING' },
  history: [message, { ...message, messageId: 'm-2' }], artifacts: [] });

describe('native A2A 1.0 protocol contract', () => {
  it('uses official oneofs, enums and JSON response shapes without v0.3 fields', () => {
    const value = jsonEvent(taskEvent(task()));
    expect(value).toMatchObject({ task: { id: 't-1', status: { state: 'TASK_STATE_WORKING' },
      history: [{ role: 'ROLE_USER', parts: [{ text: 'hello' }] }, { messageId: 'm-2' }] } });
    expect(JSON.stringify(value)).not.toContain('"kind"');
    expect(textArtifact('result').parts[0].content).toEqual({ $case: 'text', value: 'result' });
  });
  it('honors historyLength zero without changing the stored task', () => {
    const original = task();
    expect(historyView(original, 0).history).toEqual([]);
    expect(historyView(original, 1).history[0].messageId).toBe('m-2');
    expect(original.history).toHaveLength(2);
    expect(() => historyView(original, -1)).toThrow();
  });
  it.each([3, 4, 5, 7])('never reopens terminal state %s', (state) => {
    expect(() => assertTransition(state, TaskState.TASK_STATE_SUBMITTED)).toThrow();
    expect(() => assertTransition(state, TaskState.TASK_STATE_COMPLETED)).toThrow();
  });
  it('allows input interruption but never turns a queue directly into input-required', () => {
    expect(() => assertTransition(2, 6)).not.toThrow();
    expect(() => assertTransition(6, 1)).not.toThrow();
    expect(() => assertTransition(1, 6)).toThrow();
  });
  it.each([
    { ...message, parts: [{ text: 'hello', url: 'https://private.test' }] },
    { ...message, role: 'user' },
    { ...message, role: 'ROLE_AGENT' },
    { ...message, messageId: 17 },
    { ...message, parts: [{ kind: 'text', text: 'hello' }] },
    { ...message, parts: [{}] },
  ])('rejects lossy coercion and non-standard message shapes', (bad) => {
    expect(() => validateParams('SendMessage', { message: bad })).toThrow();
  });
  it('accepts standard cancel metadata but no caller-controlled system or model', () => {
    expect(() => validateParams('CancelTask', { id: 't-1', metadata: { note: 'cancel' } })).not.toThrow();
    expect(() => validateParams('SendMessage', { message, model: 'override' })).toThrow();
    expect(() => validateParams('SendMessage', { message, configuration: { returnImmediately: 'false' } })).toThrow();
  });
  it.each([{ url: 'http://169.254.169.254' }, { raw: 'YQ==' }, { data: { a: 1 } }, { data: null }])('rejects unadvertised input modes, never fetching files', (part) => {
    try { validateParams('SendMessage', { message: { ...message, parts: [part] } }); throw new Error('accepted'); }
    catch (error) { expect(toJsonRpcError(error).code).toBe(-32005); }
  });
  it('reports standard errors for unsupported push and output modes', () => {
    for (const [configuration, code] of [
      [{ taskPushNotificationConfig: { url: 'https://callback.test' } }, -32003],
      [{ acceptedOutputModes: ['image/png'] }, -32005],
    ] as const) {
      try { validateSend(SendMessageRequest.fromJSON({ message, configuration })); throw new Error('accepted'); }
      catch (error) { expect(toJsonRpcError(error).code).toBe(code); }
    }
  });
});
