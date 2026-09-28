// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createApiToken } from '@/lib/auth/tokens';
import { POST, DELETE } from '@/app/api/v1/chat/threads/[threadId]/turns/route';
import { GET } from '@/app/api/v1/chat/threads/[threadId]/turns/stream/route';
import { GET as GET_STATUS } from '@/app/api/v1/chat/assistants/route';
import { chatProviderFixture, type ChatProviderFixture } from '../fixtures/chat-provider';

let provider: ChatProviderFixture;
let userId: string, otherId: string, workspaceId: string, assistantId: string;
let token: string, otherToken: string;
// Real sockets and PostgreSQL commit outside fake timers; await observed state, not a fixed sleep.
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 12_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for persisted chat state');
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 25);
    await tick.promise;
  }
}
async function thread() {
  return db.chatThread.create({ data: { workspaceId, assistantId } });
}
function request(id: string, method: string, body?: unknown, credential = token, signal?: AbortSignal) {
  return new Request(`http://localhost/api/v1/chat/threads/${id}/turns`, {
    method, signal, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ threadId: id }) });
async function start(id: string, signal?: AbortSignal) {
  const response = await POST(request(id, 'POST', {
    messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Continue on the server' }] }],
  }, token, signal), params(id));
  expect(response.status).toBe(200);
  return response;
}

beforeAll(async () => {
  const stamp = randomUUID();
  provider = await chatProviderFixture();
  userId = (await db.user.create({ data: { email: `chat-background-${stamp}@test.invalid`, passwordHash: 'fixture' } })).id;
  otherId = (await db.user.create({ data: { email: `chat-background-other-${stamp}@test.invalid`, passwordHash: 'fixture' } })).id;
  workspaceId = (await db.workspace.create({ data: { name: 'Chat background fixture', slug: `chat-background-${stamp}`, ownerId: userId } })).id;
  const model = await db.modelProvider.create({ data: { workspaceId, name: 'Local controlled provider', format: 'openai',
    baseUrl: `${provider.baseUrl}/v1`, apiKey: 'local-fixture-only', models: ['chat-background-fixture'] } });
  assistantId = (await db.chatAssistant.create({ data: { workspaceId, name: 'Background fixture', modelProviderId: model.id, model: 'chat-background-fixture' } })).id;
  token = (await createApiToken(userId, 'Chat background test')).token;
  otherToken = (await createApiToken(otherId, 'Outside workspace')).token;
});
afterAll(async () => {
  await provider?.close();
  if (workspaceId) {
    await until(async () => await db.chatTurn.count({ where: { thread: { workspaceId }, status: 'pending' } }) === 0);
    await db.workspace.delete({ where: { id: workspaceId } });
  }
  await db.user.deleteMany({ where: { id: { in: [userId, otherId].filter(Boolean) } } });
  await db.$disconnect();
});

describe('assistant background execution with real persistence', () => {
  it('continues without an observer, persists once, and can replay the same answer', async () => {
    const chat = await thread();
    const controller = new AbortController();
    const response = await start(chat.id, controller.signal);
    const turnId = response.headers.get('X-Chat-Turn-Id')!;
    const reader = response.body!.getReader();
    await reader.read();
    await until(async () => provider.state().pending === 1);
    const statusRequest = () => new Request(`http://localhost/api/v1/chat/assistants?workspaceId=${workspaceId}&running=1`, { headers: { authorization: `Bearer ${token}` } });
    expect(await (await GET_STATUS(statusRequest())).json()).toEqual({ runningThreadIds: [chat.id] });
    expect((await GET_STATUS(new Request(statusRequest(), { headers: { authorization: `Bearer ${otherToken}` } }))).status).toBe(404);
    controller.abort();
    await reader.cancel();
    const before = provider.state();
    provider.release();
    await until(async () => (await db.chatTurn.findUniqueOrThrow({ where: { id: turnId } })).status === 'completed');
    const answer = await db.chatMessage.findFirstOrThrow({ where: { turnId, role: 'assistant' } });
    expect(answer.status).toBe('success');
    expect(answer.parts).toEqual([expect.objectContaining({ type: 'text', text: 'Before disconnect. Completed on server.' })]);
    const resumed = await GET(request(chat.id, 'GET'), params(chat.id));
    expect(await resumed.text()).toContain('Completed on server.');
    expect(provider.state().calls).toBe(before.calls);
    expect(provider.state().aborted).toBe(before.aborted);
    expect(await db.chatMessage.count({ where: { turnId, role: 'assistant' } })).toBe(1);
    expect(await (await GET_STATUS(statusRequest())).json()).toEqual({ runningThreadIds: [] });
  });

  it('denies cross-workspace replay and stop, but the owner can explicitly stop', async () => {
    const chat = await thread();
    const response = await start(chat.id);
    const turnId = response.headers.get('X-Chat-Turn-Id')!;
    await until(async () => provider.state().pending === 1);
    expect((await GET(request(chat.id, 'GET', undefined, otherToken), params(chat.id))).status).toBe(404);
    expect((await DELETE(request(chat.id, 'DELETE', { turnId }, otherToken), params(chat.id))).status).toBe(404);
    const duplicate = await POST(request(chat.id, 'POST', { messages: [{ id: 'duplicate', role: 'user', parts: [{ type: 'text', text: 'Do not execute' }] }] }), params(chat.id));
    expect(duplicate.status).toBe(409);
    const aborted = provider.state().aborted;
    expect(await (await DELETE(request(chat.id, 'DELETE', { turnId }), params(chat.id))).json()).toEqual({ cancelled: true });
    await response.text();
    await until(async () => provider.state().aborted === aborted + 1);
    expect((await db.chatTurn.findUniqueOrThrow({ where: { id: turnId } })).status).toBe('cancelled');
    expect((await db.chatMessage.findFirstOrThrow({ where: { turnId, role: 'assistant' } })).parts).toEqual([expect.objectContaining({ type: 'text', text: 'Before disconnect. ' })]);
  });

  it('stops detached execution when the workspace is suspended', async () => {
    const chat = await thread();
    const response = await start(chat.id);
    const turnId = response.headers.get('X-Chat-Turn-Id')!;
    await until(async () => provider.state().pending === 1);
    await response.body!.cancel();
    await db.workspace.update({ where: { id: workspaceId }, data: { status: 'suspended' } });
    try {
      await until(async () => (await db.chatTurn.findUniqueOrThrow({ where: { id: turnId } })).status === 'failed');
      expect((await GET(request(chat.id, 'GET'), params(chat.id))).status).toBe(404);
      await until(async () => provider.state().pending === 0);
    } finally {
      await db.workspace.update({ where: { id: workspaceId }, data: { status: 'active' } });
    }
  }, 15_000);
});
