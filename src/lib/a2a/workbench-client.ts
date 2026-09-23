import { SendMessageRequest, Task, TaskState, Role } from '@a2a-js/sdk';
import { z } from 'zod';

const Id = z.string().min(1).max(200);
const Selection = z.object({ agent: Id.optional(), task: Id.optional() }).strict()
  .refine((value) => !value.task || Boolean(value.agent));
export function parseWorkbenchSelection(value: unknown) { return Selection.safeParse(value); }
export function workbenchHref(slug: string, agentId?: string, taskId?: string) {
  const query = new URLSearchParams({ mode: 'a2a' });
  if (agentId) query.set('agent', agentId);
  if (taskId) query.set('task', taskId);
  return `/app/${encodeURIComponent(slug)}/work?${query}`;
}
export const isWorkbenchTerminal = (state: TaskState) => [TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED].includes(state);

/** Use the SDK's ProtoJSON codec; a completed task is referenced, never reopened. */
export function workbenchMessage(text: string, selected: Task | null, messageId: string): Record<string, unknown> {
  if (!text.trim() || text.trim().length > 20_000 || !messageId) throw new Error('Invalid message.');
  const state = selected?.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
  if (selected && state !== TaskState.TASK_STATE_INPUT_REQUIRED && !isWorkbenchTerminal(state)) {
    throw new Error('The task is not accepting a follow-up.');
  }
  return SendMessageRequest.toJSON(SendMessageRequest.fromJSON({ message: {
    messageId, role: Role.ROLE_USER, parts: [{ text: text.trim() }],
    ...(selected ? { contextId: selected.contextId,
      ...(state === TaskState.TASK_STATE_INPUT_REQUIRED ? { taskId: selected.id } : { referenceTaskIds: [selected.id] }) } : {}),
  }, configuration: { returnImmediately: true, historyLength: 0 } })) as Record<string, unknown>;
}
export function workbenchTask(value: unknown): Task {
  const valid = z.object({ id: Id, contextId: Id, status: z.object({ state: z.string().min(1) }) }).passthrough().safeParse(value);
  if (!valid.success) throw new Error('Invalid task response.');
  const task = Task.fromJSON(value);
  if (!task.status || task.status.state === TaskState.UNRECOGNIZED || task.status.state === TaskState.TASK_STATE_UNSPECIFIED) {
    throw new Error('Invalid task state.');
  }
  return task;
}

/** Bounded browser reads. No cookies/tokens are stored and no operation is automatically retried. */
export async function readWorkbenchJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const limit = 2 * 1024 * 1024;
  if (!response.body) throw new Error('Empty response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '';
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Response limit exceeded.'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}
export async function workbenchRpc(base: string, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const id = crypto.randomUUID();
  const response = await fetch(`${base}/rpc`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const envelope = await readWorkbenchJson(response, signal);
  if (!response.ok || !envelope || typeof envelope !== 'object' || !('jsonrpc' in envelope) || envelope.jsonrpc !== '2.0'
    || !('id' in envelope) || envelope.id !== id || 'error' in envelope || !('result' in envelope)
    || !envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) throw new Error('A2A request failed.');
  return envelope.result as Record<string, unknown>;
}
